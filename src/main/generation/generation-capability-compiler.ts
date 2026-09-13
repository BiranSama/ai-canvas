import { createHash } from 'node:crypto'
import {
  imageTaskRequestSchema,
  providerCapabilitiesSchema,
  type ImageTaskRequest,
  type ProviderCapabilities
} from '../../shared/generation'
import {
  generationWorkflowSpecSchema,
  providerCompiledRequestSchema,
  type GenerationWorkflowSpec,
  type ProviderCapabilityWarning,
  type ProviderCompiledRequest
} from '../../shared/generation-workflow'

export class GenerationCapabilityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GenerationCapabilityError'
    this.code = code
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]))
  }
  return value
}

function fingerprint(capabilities: ProviderCapabilities): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(capabilities))).digest('hex')
}

function warning(code: string, message: string, adaptation: string): ProviderCapabilityWarning {
  return { code, severity: 'warning', message, adaptation }
}

export class GenerationCapabilityCompiler {
  compile(inputValue: {
    readonly spec: GenerationWorkflowSpec
    readonly request: ImageTaskRequest
    readonly capabilities: ProviderCapabilities
  }): ProviderCompiledRequest {
    const spec = generationWorkflowSpecSchema.parse(inputValue.spec)
    const request = imageTaskRequestSchema.parse(inputValue.request)
    const capabilities = providerCapabilitiesSchema.parse(inputValue.capabilities)
    if (request.providerId !== spec.providerId || request.model !== spec.model) {
      throw new GenerationCapabilityError('WORKFLOW_PROVIDER_MISMATCH', 'Workflow provider/model does not match the generation request.')
    }
    const isEdit = 'kind' in request && request.kind === 'edit'
    if (isEdit && !capabilities.maskEditing) {
      throw new GenerationCapabilityError('CAPABILITY_EDIT_UNSUPPORTED', 'The selected provider cannot perform mask editing.')
    }
    if (!isEdit && !capabilities.textToImage) {
      throw new GenerationCapabilityError('CAPABILITY_TEXT_TO_IMAGE_UNSUPPORTED', 'The selected provider cannot generate an image from text.')
    }
    if (request.references.length > 0 && !capabilities.imageReferences) {
      throw new GenerationCapabilityError('CAPABILITY_REFERENCE_UNSUPPORTED', 'The selected provider cannot receive image references.')
    }
    if (request.references.length > 1 && !capabilities.multipleReferences) {
      throw new GenerationCapabilityError(
        'CAPABILITY_MULTI_REFERENCE_REQUIRES_COMPOSITE',
        'Multiple references must be compiled into one explicit composite before this provider can be used.'
      )
    }
    const warnings: ProviderCapabilityWarning[] = []
    let compiledRequest = request
    if (request.count > capabilities.maxImages) {
      warnings.push(warning(
        'CAPABILITY_IMAGE_COUNT_REDUCED',
        `Requested ${request.count} images but the provider supports at most ${capabilities.maxImages}.`,
        `The compiled request contains ${capabilities.maxImages} images; this warning must remain visible before dispatch.`
      ))
      compiledRequest = imageTaskRequestSchema.parse({ ...compiledRequest, count: capabilities.maxImages })
    }
    const ratio = `${request.aspectWidth}:${request.aspectHeight}`
    if (capabilities.supportedRatios.length > 0
      && !capabilities.supportedRatios.includes('custom')
      && !capabilities.supportedRatios.includes(ratio)) {
      warnings.push(warning(
        'CAPABILITY_RATIO_APPROXIMATION',
        `The provider does not explicitly advertise ${ratio}.`,
        'Keep the requested output dimensions, but mark the ratio as provider-approximated for user review.'
      ))
    }
    if (compiledRequest.parameters.transparentOutput === true && !capabilities.transparentOutput) {
      const parameters = { ...compiledRequest.parameters }
      delete parameters.transparentOutput
      warnings.push(warning(
        'CAPABILITY_TRANSPARENCY_REMOVED',
        'The provider does not support transparent output.',
        'The transparent-output flag was removed; the result will use an opaque background.'
      ))
      compiledRequest = imageTaskRequestSchema.parse({ ...compiledRequest, parameters })
    }
    return providerCompiledRequestSchema.parse({
      version: 1,
      providerId: spec.providerId,
      model: spec.model,
      operation: spec.operation,
      request: compiledRequest,
      warnings,
      capabilityFingerprint: fingerprint(capabilities),
      compilation: warnings.length === 0 ? 'exact' : 'adapted'
    })
  }
}
