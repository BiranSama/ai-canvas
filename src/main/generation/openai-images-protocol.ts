import { z } from 'zod'
import type { EditRequest, GenerationRequest } from '../../shared/generation'
import { familyPrompt } from './image-prompt-families'
import { GPT_IMAGE_1_PRESETS, GPT_IMAGE_FREE_SIZE, GROK_ASPECT_RATIOS, GROK_MAX_REFERENCES, hasPresetSizesOnly, isGptImageModel, isGrokImageModel, OPENAI_IMAGES_CAPABILITIES } from '../../shared/image-model-profiles'
import { fitFreeImageSize, formatImageSize, nearestPresetSize } from '../../shared/image-size-rules'

const modelSchema = z.string().trim().min(1).max(200)
const base64Schema = z.string().min(1).max(70 * 1024 * 1024)
const responseSchema = z.object({
  data: z.array(z.object({
    b64_json: base64Schema.optional(),
    url: z.string().url().max(8_192).optional()
  }).passthrough()).min(1).max(4)
}).passthrough()

export interface OpenAiImagesJsonRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface OpenAiImagesMultipartFile {
  readonly field: 'image[]' | 'mask'
  readonly name: string
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly bytes: Buffer
}

export interface OpenAiImagesMultipartRequest {
  readonly url: string
  readonly fields: Readonly<Record<string, string>>
  readonly files: readonly OpenAiImagesMultipartFile[]
}

export interface OpenAiImagesFileInput {
  readonly name: string
  readonly mimeType: OpenAiImagesMultipartFile['mimeType']
  readonly bytes: Buffer
}

export interface NormalizedOpenAiImage {
  readonly kind: 'base64'
  readonly value: string
}

function validatedBaseUrl(value: string): URL {
  const direct = new URL(value)
  if (direct.protocol !== 'https:' || direct.username !== '' || direct.password !== '' || direct.search !== '' || direct.hash !== '') {
    throw new Error('OpenAI Images compatible Base URL must use credential-free HTTPS.')
  }
  const normalizedPath = direct.pathname.replace(/\/+$/, '')
  const suffix = ['/images/generations', '/images/edits'].find((candidate) => normalizedPath.endsWith(candidate))
  if (suffix !== undefined) direct.pathname = normalizedPath.slice(0, -suffix.length) || '/'
  return new URL(direct.toString().endsWith('/') ? direct.toString() : `${direct.toString()}/`)
}

function outputSize(request: GenerationRequest | EditRequest): string {
  const requested = { width: request.outputWidth, height: request.outputHeight }
  const aspect = { width: request.aspectWidth, height: request.aspectHeight }
  if (hasPresetSizesOnly(request.model)) return formatImageSize(nearestPresetSize(aspect, GPT_IMAGE_1_PRESETS))
  if (isGptImageModel(request.model)) return formatImageSize(fitFreeImageSize(requested, aspect, GPT_IMAGE_FREE_SIZE))
  // Other OpenAI-compatible image services document their own sizes; send the request as asked.
  return formatImageSize(requested)
}

function grokFrameFields(request: GenerationRequest | EditRequest): Readonly<Record<string, string>> {
  const ratio = nearestPresetSize({ width: request.aspectWidth, height: request.aspectHeight }, GROK_ASPECT_RATIOS)
  return {
    aspect_ratio: `${ratio.width}:${ratio.height}`,
    resolution: Math.max(request.outputWidth, request.outputHeight) > 1_536 ? '2k' : '1k'
  }
}

function responseFormatField(model: string): Readonly<Record<string, string>> {
  return isGptImageModel(model) ? {} : { response_format: 'b64_json' }
}

function transparentFields(request: GenerationRequest | EditRequest): Readonly<Record<string, string>> {
  return request.parameters.transparentOutput === true
    ? { background: 'transparent', output_format: 'png' }
    : {}
}

export class OpenAiImagesProtocol {
  readonly id = 'openai-images'
  readonly label = 'OpenAI Images 兼容协议'
  readonly capabilities = OPENAI_IMAGES_CAPABILITIES
  readonly allowedModels: readonly string[]
  readonly #baseUrl: URL

  constructor(config: { readonly baseUrl: string; readonly allowedModels: readonly string[] }) {
    this.#baseUrl = validatedBaseUrl(config.baseUrl)
    if (config.allowedModels.length === 0) throw new Error('OpenAI Images compatible protocol requires a configured model.')
    this.allowedModels = Object.freeze([...new Set(config.allowedModels.map((model) => modelSchema.parse(model)))])
  }

  buildGenerationRequest(request: GenerationRequest): OpenAiImagesJsonRequest {
    this.#validate(request)
    if (request.references.length > 0) {
      throw new Error('OpenAI Images reference inputs must use the multipart edit endpoint.')
    }
    return {
      url: new URL('images/generations', this.#baseUrl).toString(),
      body: isGrokImageModel(request.model)
        ? { model: request.model, prompt: familyPrompt(request), n: request.count, response_format: 'b64_json', ...grokFrameFields(request) }
        : {
            model: request.model,
            prompt: familyPrompt(request),
            n: request.count,
            size: outputSize(request),
            ...responseFormatField(request.model),
            ...transparentFields(request)
          }
    }
  }

  /**
   * Grok Imagine reads references from a JSON body: one `image` or up to three
   * `images`, each a data URI. The canvas frame is set explicitly, since the
   * output would otherwise follow the first reference.
   */
  buildGrokReferenceRequest(input: {
    readonly request: GenerationRequest | EditRequest
    readonly images: readonly OpenAiImagesFileInput[]
  }): OpenAiImagesJsonRequest {
    this.#validate(input.request)
    if (!isGrokImageModel(input.request.model)) throw new Error('Only Grok Imagine models take JSON reference requests.')
    if (input.images.length === 0) throw new Error('A Grok reference request needs at least one image.')
    if (input.images.length > GROK_MAX_REFERENCES) throw new Error(`Grok Imagine accepts at most ${GROK_MAX_REFERENCES} reference images.`)
    const sources = input.images.map((image) => ({ url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`, type: 'image_url' }))
    return {
      url: new URL('images/edits', this.#baseUrl).toString(),
      body: {
        model: input.request.model,
        prompt: familyPrompt(input.request),
        n: input.request.count,
        response_format: 'b64_json',
        aspect_ratio: grokFrameFields(input.request).aspect_ratio,
        ...(sources.length === 1 ? { image: sources[0] } : { images: sources })
      }
    }
  }

  buildEditRequest(input: {
    readonly request: GenerationRequest | EditRequest
    readonly images: readonly OpenAiImagesFileInput[]
    readonly mask: OpenAiImagesFileInput | null
  }): OpenAiImagesMultipartRequest {
    this.#validate(input.request)
    if (isGrokImageModel(input.request.model)) throw new Error('Grok Imagine takes reference images as JSON; use buildGrokReferenceRequest.')
    if (input.images.length === 0) throw new Error('OpenAI Images multipart editing requires at least one image.')
    if (input.images.length > 8) throw new Error('OpenAI Images accepts at most eight AI Canvas image inputs.')
    const files: OpenAiImagesMultipartFile[] = input.images.map((image) => ({ ...image, field: 'image[]' }))
    if (input.mask !== null) files.push({ ...input.mask, field: 'mask' })
    return {
      url: new URL('images/edits', this.#baseUrl).toString(),
      fields: {
        model: input.request.model,
        prompt: familyPrompt(input.request),
        n: String(input.request.count),
        size: outputSize(input.request),
        ...responseFormatField(input.request.model),
        ...transparentFields(input.request)
      },
      files
    }
  }

  parseResponse(value: unknown): readonly NormalizedOpenAiImage[] {
    const parsed = responseSchema.parse(value)
    return parsed.data.map((image) => {
      if (image.b64_json === undefined) {
        throw new Error('OpenAI Images compatible result must contain Base64; URL-only output is not followed outside the saved Provider address.')
      }
      return { kind: 'base64' as const, value: image.b64_json }
    })
  }

  #validate(request: GenerationRequest | EditRequest): void {
    modelSchema.parse(request.model)
    if (!this.allowedModels.includes(request.model)) throw new Error(`Model “${request.model}” is not the configured OpenAI Images model.`)
    if (request.count > this.capabilities.maxImages) throw new Error(`OpenAI Images requests are limited to ${this.capabilities.maxImages} outputs.`)
  }
}
