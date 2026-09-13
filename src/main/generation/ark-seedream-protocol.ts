import { z } from 'zod'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import { resolveImageProtocolEndpoint } from '../../shared/provider-settings'

const arkBaseUrlSchema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}, 'Ark base URL must use HTTPS and cannot contain credentials.')

const dataImageSchema = z.string().max(40 * 1024 * 1024).refine(
  (value) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value),
  'Seedream image input must be a PNG, JPEG or WebP data URI.'
)

const arkSeedreamResponseSchema = z.object({
  model: z.string().optional(),
  created: z.number().optional(),
  data: z.array(z.object({
    url: z.string().url().optional(),
    b64_json: z.string().min(1).optional(),
    size: z.string().optional()
  }).refine((item) => item.url !== undefined || item.b64_json !== undefined, {
    message: 'Seedream result must contain url or b64_json.'
  })).min(1),
  usage: z.object({
    generated_images: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional()
  }).passthrough().optional()
})

export interface ArkSeedreamProtocolRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface ArkSeedreamProtocolInput {
  readonly request: GenerationRequest | EditRequest
  /** Ordered image inputs already localized by Main and encoded without URLs. */
  readonly images: readonly string[]
}

export interface NormalizedSeedreamImage {
  readonly kind: 'base64' | 'url'
  readonly value: string
  readonly size: string | null
}

export interface NormalizedSeedreamResponse {
  readonly images: readonly NormalizedSeedreamImage[]
  readonly generatedImages: number
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

export const ARK_SEEDREAM_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  // Seedream has no native mask field. AI Canvas supports this through an
  // annotated visual-control reference, as recommended by the prompt guide.
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: false,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

export const ARK_SEEDREAM_EDIT_MODE = 'visual-guided' as const

function imageGenerationUrl(baseUrl: string): string {
  return resolveImageProtocolEndpoint(baseUrl, 'ark-seedream', 'generate')
}

function numericParameter(
  request: GenerationRequest | EditRequest,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = request.parameters[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return undefined
  return value
}

function booleanParameter(request: GenerationRequest | EditRequest, key: string, fallback: boolean): boolean {
  const value = request.parameters[key]
  return typeof value === 'boolean' ? value : fallback
}

function compiledPrompt(request: GenerationRequest | EditRequest): string {
  const negative = request.negativePrompt.trim()
  const framedPrompt = `画幅比例严格保持 ${request.aspectWidth}:${request.aspectHeight}。\n${request.prompt}`
  const rawRequirement = negative === ''
    ? framedPrompt
    : `${framedPrompt}\n\n避免出现：${negative}`
  const requirement = request.count > 1
    ? `请生成一组共 ${request.count} 张内容关联、主体与风格一致的图片。\n${rawRequirement}`
    : rawRequirement
  if (!('kind' in request) || request.kind !== 'edit') return requirement
  return [
    '这是一次视觉引导式局部编辑。图一是必须保留的原图；图二是带红色半透明标记的编辑指示图。',
    '只修改红色标记覆盖的区域，未标记区域、构图、主体身份、文字与光影关系尽量保持不变。',
    `编辑要求：${requirement}`
  ].join('\n')
}

function outputSize(request: GenerationRequest | EditRequest): string {
  const configured = request.parameters.seedreamSize
  if (typeof configured === 'string' && /^(?:1K|2K|4K|[1-9]\d{2,4}x[1-9]\d{2,4})$/.test(configured)) {
    return configured
  }
  // The UI's 1024px working sizes are reference/canvas dimensions. Ark's
  // documented generation default is 2K, which produces materially better
  // typography and faces while the prompt preserves the requested ratio.
  if (Math.max(request.outputWidth, request.outputHeight) < 1_536) return '2K'
  return `${request.outputWidth}x${request.outputHeight}`
}

/**
 * Pure Seedream request/response mapper. It never reads a key or performs I/O.
 */
export class ArkSeedreamProtocol {
  readonly id = 'ark-seedream-images'
  readonly label = '火山方舟 · Doubao Seedream'
  readonly capabilities = ARK_SEEDREAM_CAPABILITIES
  readonly editMode = ARK_SEEDREAM_EDIT_MODE
  readonly #baseUrl: string

  constructor(config: { readonly baseUrl: string }) {
    this.#baseUrl = arkBaseUrlSchema.parse(config.baseUrl)
    imageGenerationUrl(this.#baseUrl)
  }

  buildRequest(input: ArkSeedreamProtocolInput): ArkSeedreamProtocolRequest {
    const request = input.request
    if (request.count > this.capabilities.maxImages) {
      throw new Error(`AI Canvas allows at most ${this.capabilities.maxImages} Seedream images per request.`)
    }
    const images = input.images.map((image) => dataImageSchema.parse(image))
    if (request.references.length > 0 && images.length === 0) {
      throw new Error('Seedream reference metadata exists but no localized image input was supplied.')
    }
    if ('kind' in request && request.kind === 'edit' && images.length < 2) {
      throw new Error('Visual-guided Seedream editing requires the source and annotated edit reference.')
    }
    const seed = numericParameter(request, 'seed', -1, 2_147_483_647)
    const guidanceScale = numericParameter(request, 'guidanceScale', 1, 10)
    const sequential = request.count > 1 ? 'auto' : 'disabled'
    return {
      url: imageGenerationUrl(this.#baseUrl),
      body: {
        model: request.model,
        prompt: compiledPrompt(request),
        ...(images.length === 0 ? {} : { image: images }),
        size: outputSize(request),
        sequential_image_generation: sequential,
        ...(sequential === 'auto'
          ? { sequential_image_generation_options: { max_images: request.count } }
          : {}),
        stream: false,
        response_format: 'b64_json',
        watermark: booleanParameter(request, 'watermark', false),
        ...(seed === undefined ? {} : { seed: Math.trunc(seed) }),
        ...(guidanceScale === undefined ? {} : { guidance_scale: guidanceScale })
      }
    }
  }

  parseResponse(value: unknown): NormalizedSeedreamResponse {
    const parsed = arkSeedreamResponseSchema.parse(value)
    const images = parsed.data.map((item): NormalizedSeedreamImage => {
      if (item.b64_json !== undefined) {
        return { kind: 'base64', value: item.b64_json, size: item.size ?? null }
      }
      const url = new URL(item.url!)
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
        throw new Error('Seedream returned an unsafe image URL.')
      }
      return { kind: 'url', value: url.toString(), size: item.size ?? null }
    })
    return {
      images,
      generatedImages: parsed.usage?.generated_images ?? images.length,
      outputTokens: parsed.usage?.output_tokens ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null
    }
  }
}
