import { describe, expect, it } from 'vitest'
import { GenerationCapabilityCompiler } from '../../src/main/generation/generation-capability-compiler'
import type { GenerationCapabilityError } from '../../src/main/generation/generation-capability-compiler'
import type { GenerationRequest, ProviderCapabilities } from '../../src/shared/generation'
import type { GenerationWorkflowSpec } from '../../src/shared/generation-workflow'

const spec: GenerationWorkflowSpec = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000801',
  profileId: 'local-sketch',
  tier: 'local-sketch',
  operation: 'text',
  providerId: 'mock',
  model: 'mock-balanced',
  sourceSceneRevision: 7,
  promptPackageHash: null,
  idempotencyKey: 'turn:fixture:generation:0',
  steps: [
    { id: 'compile', kind: 'compile-prompt', label: '编译', required: true },
    { id: 'reserve', kind: 'reserve-budget', label: '预留', required: true },
    { id: 'create', kind: 'create-job', label: '创建', required: true },
    { id: 'observe', kind: 'observe-job', label: '观察', required: true }
  ],
  limits: { maxJobs: 1, maxImages: 4, maxCostCny: 0, maxWallTimeMs: 120_000, noImprovementLimit: 1 }
}

const request: GenerationRequest = {
  prompt: 'quiet blue album cover',
  negativePrompt: '',
  aspectWidth: 4,
  aspectHeight: 5,
  outputWidth: 1024,
  outputHeight: 1280,
  count: 1,
  providerId: 'mock',
  model: 'mock-balanced',
  references: [],
  parameters: {},
  sourceMessageId: null,
  parentResultId: null,
  referenceMode: 'hybrid',
  variationInstruction: '',
  preserveConstraints: ''
}

const capabilities: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: true,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png']
}

describe('AH1 S7 generation workflow contracts', () => {
  it('compiles an exact provider request with a stable capability fingerprint', () => {
    const compiler = new GenerationCapabilityCompiler()
    const first = compiler.compile({ spec, request, capabilities })
    const second = compiler.compile({ spec, request, capabilities })
    expect(first).toMatchObject({ compilation: 'exact', warnings: [], request: { count: 1 } })
    expect(first.capabilityFingerprint).toBe(second.capabilityFingerprint)
  })

  it('makes bounded capability degradation explicit instead of silently changing output', () => {
    const compiled = new GenerationCapabilityCompiler().compile({
      spec,
      request: { ...request, count: 4, parameters: { transparentOutput: true } },
      capabilities: {
        ...capabilities,
        maxImages: 2,
        transparentOutput: false,
        supportedRatios: ['1:1']
      }
    })
    expect(compiled.compilation).toBe('adapted')
    expect(compiled.request.count).toBe(2)
    expect(compiled.request.parameters.transparentOutput).toBeUndefined()
    expect(compiled.warnings.map((item) => item.code)).toEqual([
      'CAPABILITY_IMAGE_COUNT_REDUCED',
      'CAPABILITY_RATIO_APPROXIMATION',
      'CAPABILITY_TRANSPARENCY_REMOVED'
    ])
  })

  it('blocks multiple references when an explicit composite has not been compiled', () => {
    expect(() => new GenerationCapabilityCompiler().compile({
      spec: { ...spec, operation: 'canvas' },
      request: {
        ...request,
        references: [
          { assetId: '00000000-0000-4000-8000-000000000811', intent: 'composition', strength: .8 },
          { assetId: '00000000-0000-4000-8000-000000000812', intent: 'style', strength: .6 }
        ]
      },
      capabilities: { ...capabilities, multipleReferences: false }
    })).toThrowError(expect.objectContaining<Partial<GenerationCapabilityError>>({
      code: 'CAPABILITY_MULTI_REFERENCE_REQUIRES_COMPOSITE'
    }))
  })
})
