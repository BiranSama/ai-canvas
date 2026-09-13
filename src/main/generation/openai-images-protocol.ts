import { z } from 'zod'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'

const modelSchema = z.string().trim().min(1).max(200)
const base64Schema = z.string().min(1).max(70 * 1024 * 1024)
const responseSchema = z.object({
  data: z.array(z.object({
    b64_json: base64Schema.optional(),
    url: z.string().url().max(8_192).optional()
  }).passthrough()).min(1).max(4)
}).passthrough()

export const OPENAI_IMAGES_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: true,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

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

function compiledPrompt(request: GenerationRequest | EditRequest): string {
  const ratio = `画幅比例严格保持 ${request.aspectWidth}:${request.aspectHeight}。`
  const negative = request.negativePrompt.trim()
  return negative === ''
    ? `${ratio}\n${request.prompt}`
    : `${ratio}\n${request.prompt}\n\n避免出现：${negative}`
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
      body: {
        model: request.model,
        prompt: compiledPrompt(request),
        n: request.count,
        size: `${request.outputWidth}x${request.outputHeight}`,
        response_format: 'b64_json',
        ...transparentFields(request)
      }
    }
  }

  buildEditRequest(input: {
    readonly request: GenerationRequest | EditRequest
    readonly images: readonly OpenAiImagesFileInput[]
    readonly mask: OpenAiImagesFileInput | null
  }): OpenAiImagesMultipartRequest {
    this.#validate(input.request)
    if (input.images.length === 0) throw new Error('OpenAI Images multipart editing requires at least one image.')
    if (input.images.length > 8) throw new Error('OpenAI Images accepts at most eight AI Canvas image inputs.')
    const files: OpenAiImagesMultipartFile[] = input.images.map((image) => ({ ...image, field: 'image[]' }))
    if (input.mask !== null) files.push({ ...input.mask, field: 'mask' })
    return {
      url: new URL('images/edits', this.#baseUrl).toString(),
      fields: {
        model: input.request.model,
        prompt: compiledPrompt(input.request),
        n: String(input.request.count),
        size: `${input.request.outputWidth}x${input.request.outputHeight}`,
        response_format: 'b64_json',
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
