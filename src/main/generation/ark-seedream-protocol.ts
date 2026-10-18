import { z } from 'zod'
import { familyPrompt } from './image-prompt-families'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import { resolveImageProtocolEndpoint } from '../../shared/provider-settings'
import { fitFreeImageSize, formatImageSize, type FreeSizeRule } from './image-size-rules'

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

/**
 * What a Seedream model accepts. Model families differ in their size range,
 * in whether they can return a related image set, and in whether seed and
 * guidance scale exist at all; sending a field a model does not support fails
 * the request.
 */
export interface SeedreamModelProfile {
  readonly presets: readonly string[]
  /** Free width x height range, or null when the model takes presets only. */
  readonly freeSize: FreeSizeRule | null
  /** `adaptive` lets the model keep the input image size (SeedEdit). */
  readonly adaptiveSize: boolean
  readonly sequentialImages: boolean
  readonly seedAndGuidance: boolean
  readonly maxImages: number
}

const SEEDREAM_ASPECT_LIMIT = 16

export function seedreamModelProfile(model: string): SeedreamModelProfile {
  if (/seedream-5-0-(?:pro|flash)/i.test(model)) {
    return {
      presets: ['1K', '1.5K', '2K'],
      freeSize: { multipleOf: 16, minPixels: 921_600, maxPixels: 4_624_220, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: false,
      seedAndGuidance: false,
      maxImages: 1
    }
  }
  if (/seedream-5-0|seedream-4-5/i.test(model)) {
    return {
      presets: ['2K', '4K'],
      freeSize: { multipleOf: 16, minPixels: 3_686_400, maxPixels: 16_777_216, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: true,
      seedAndGuidance: false,
      maxImages: 4
    }
  }
  if (/seedream-4-0/i.test(model)) {
    return {
      presets: ['1K', '2K', '4K'],
      freeSize: { multipleOf: 16, minPixels: 921_600, maxPixels: 16_777_216, maxAspect: SEEDREAM_ASPECT_LIMIT },
      adaptiveSize: false,
      sequentialImages: true,
      seedAndGuidance: false,
      maxImages: 4
    }
  }
  if (/seededit-3-0/i.test(model)) {
    return { presets: [], freeSize: null, adaptiveSize: true, sequentialImages: false, seedAndGuidance: true, maxImages: 1 }
  }
  if (/seedream-3-0/i.test(model)) {
    return {
      presets: [],
      freeSize: { multipleOf: 16, minPixels: 512 * 512, maxPixels: 2_048 * 2_048, minEdge: 512, maxEdge: 2_048, maxAspect: 4 },
      adaptiveSize: false,
      sequentialImages: false,
      seedAndGuidance: true,
      maxImages: 1
    }
  }
  // An unrecognised model gets only the request shape every current Seedream
  // model accepts: the 2K preset, one image, no optional controls.
  return { presets: ['2K'], freeSize: null, adaptiveSize: false, sequentialImages: false, seedAndGuidance: false, maxImages: 1 }
}

export function seedreamCapabilitiesFor(model: string): ProviderCapabilities {
  return { ...ARK_SEEDREAM_CAPABILITIES, maxImages: seedreamModelProfile(model).maxImages }
}

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


function configuredSize(request: GenerationRequest | EditRequest, profile: SeedreamModelProfile): string | null {
  const configured = request.parameters.seedreamSize
  if (typeof configured !== 'string') return null
  if (profile.presets.includes(configured)) return configured
  const match = configured.match(/^([1-9]\d{2,4})x([1-9]\d{2,4})$/)
  if (match === null || profile.freeSize === null) return null
  const pixels = Number(match[1]) * Number(match[2])
  return pixels >= profile.freeSize.minPixels && pixels <= profile.freeSize.maxPixels ? configured : null
}

function outputSize(request: GenerationRequest | EditRequest, profile: SeedreamModelProfile): string {
  const configured = configuredSize(request, profile)
  if (configured !== null) return configured
  if (profile.adaptiveSize) return 'adaptive'
  // The UI's 1024px working sizes are reference/canvas dimensions. Ark's
  // documented generation default is 2K, which produces materially better
  // typography and faces while the prompt preserves the requested ratio.
  if (profile.presets.includes('2K') && Math.max(request.outputWidth, request.outputHeight) < 1_536) return '2K'
  if (profile.freeSize === null) return profile.presets[0] ?? '2K'
  return formatImageSize(fitFreeImageSize(
    { width: request.outputWidth, height: request.outputHeight },
    { width: request.aspectWidth, height: request.aspectHeight },
    profile.freeSize
  ))
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
    const profile = seedreamModelProfile(request.model)
    if (request.count > profile.maxImages) {
      throw new Error(`Seedream model “${request.model}” returns at most ${profile.maxImages} image(s) per request.`)
    }
    const images = input.images.map((image) => dataImageSchema.parse(image))
    if (request.references.length > 0 && images.length === 0) {
      throw new Error('Seedream reference metadata exists but no localized image input was supplied.')
    }
    if ('kind' in request && request.kind === 'edit' && images.length < 2) {
      throw new Error('Visual-guided Seedream editing requires the source and annotated edit reference.')
    }
    const seed = profile.seedAndGuidance ? numericParameter(request, 'seed', -1, 2_147_483_647) : undefined
    const guidanceScale = profile.seedAndGuidance ? numericParameter(request, 'guidanceScale', 1, 10) : undefined
    const sequential = request.count > 1 ? 'auto' : 'disabled'
    return {
      url: imageGenerationUrl(this.#baseUrl),
      body: {
        model: request.model,
        prompt: familyPrompt(request, 'seedream'),
        ...(images.length === 0 ? {} : { image: images }),
        size: outputSize(request, profile),
        ...(profile.sequentialImages ? { sequential_image_generation: sequential } : {}),
        ...(profile.sequentialImages && sequential === 'auto'
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
