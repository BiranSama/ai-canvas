import { z } from 'zod'
import type { GenerationRequest, ProviderCapabilities } from '../../shared/generation'

export const KRILL_BASE_URL = 'https://api.krill-ai.net/v1'
export const KRILL_PROVIDER_ID = 'krill-image'
export const KRILL_IMAGE_MODELS = [
  'qwen-image-2.0',
  'qwen-image-2.0-pro',
  'wan2.7-image',
  'wan2.7-image-pro'
] as const

export type KrillImageModel = typeof KRILL_IMAGE_MODELS[number]

export interface KrillModelMetadata {
  readonly id: KrillImageModel
  readonly label: string
  readonly tier: 'draft' | 'final'
  readonly observedUnitPriceUsd: number
  readonly observedAvailability: 'verified-2026-08-18'
  readonly recommendation: string
}

/** Prices are observations from the user's Krill page, not a permanent tariff. */
export const KRILL_MODEL_CATALOG: readonly KrillModelMetadata[] = [
  {
    id: 'qwen-image-2.0', label: 'Qwen Image 2.0', tier: 'draft', observedUnitPriceUsd: 0.20,
    observedAvailability: 'verified-2026-08-18', recommendation: '快速草图、文字和版式倾向的开发参考图'
  },
  {
    id: 'wan2.7-image', label: 'Wan 2.7 Image', tier: 'draft', observedUnitPriceUsd: 0.20,
    observedAvailability: 'verified-2026-08-18', recommendation: '通用产品、物体、场景和氛围概念图'
  },
  {
    id: 'qwen-image-2.0-pro', label: 'Qwen Image 2.0 Pro', tier: 'final', observedUnitPriceUsd: 0.50,
    observedAvailability: 'verified-2026-08-18', recommendation: '质量优先的文字、细节和版式候选'
  },
  {
    id: 'wan2.7-image-pro', label: 'Wan 2.7 Image Pro', tier: 'final', observedUnitPriceUsd: 0.50,
    observedAvailability: 'verified-2026-08-18', recommendation: '质量优先且可接受较长等待的场景候选'
  }
]

export const KRILL_IMAGE_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: false,
  maskEditing: false,
  multipleReferences: false,
  transparentOutput: false,
  maxImages: 1,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

const krillModelSchema = z.enum(KRILL_IMAGE_MODELS)
const taskIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const statusSchema = z.string().trim().min(1).max(80).transform((value) => value.toLowerCase().replaceAll('-', '_'))
const imageSchema = z.object({
  url: z.string().url().max(8_192).optional(),
  b64_json: z.string().min(1).max(70 * 1024 * 1024).optional()
}).passthrough().refine((value) => value.url !== undefined || value.b64_json !== undefined, {
  message: 'Krill image result must contain url or b64_json.'
})
const errorSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().max(2_000).optional()
}).passthrough()
const envelopeSchema = z.object({
  id: z.string().optional(),
  image_id: z.string().optional(),
  task_id: z.string().optional(),
  status: statusSchema.optional(),
  data: z.array(imageSchema).optional(),
  result: z.object({ data: z.array(imageSchema).optional() }).passthrough().optional(),
  output: z.array(imageSchema).optional(),
  error: errorSchema.optional()
}).passthrough()
const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough())
}).passthrough()

export interface KrillJsonRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
  /** Main-only budget scope; never serialized into the provider request body. */
  readonly authorizationScopeId?: string
}

export interface KrillGetRequest {
  readonly url: string
  /** Main-only budget scope; never appended to the provider URL. */
  readonly authorizationScopeId?: string
}

export interface NormalizedKrillImage {
  readonly kind: 'base64' | 'url'
  readonly value: string
}

export type KrillTaskState =
  | { readonly kind: 'completed'; readonly taskId: string | null; readonly images: readonly NormalizedKrillImage[] }
  | { readonly kind: 'pending'; readonly taskId: string; readonly status: string }

function validatedBaseUrl(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Krill base URL must use credential-free HTTPS.')
  }
  if (url.origin !== 'https://api.krill-ai.net' || url.pathname !== '/v1/') {
    throw new Error('Krill offline adapter is pinned to https://api.krill-ai.net/v1/.')
  }
  return url
}

function taskIdFrom(value: z.infer<typeof envelopeSchema>, fallback: string | null): string | null {
  const raw = value.id ?? value.image_id ?? value.task_id ?? fallback
  return raw === null ? null : taskIdSchema.parse(raw)
}

function normalizedImages(value: z.infer<typeof envelopeSchema>): readonly NormalizedKrillImage[] {
  const items = value.data ?? value.result?.data ?? value.output ?? []
  return items.map((item) => item.b64_json !== undefined
    ? { kind: 'base64' as const, value: item.b64_json }
    : { kind: 'url' as const, value: item.url! })
}

function failedStatus(status: string | undefined): boolean {
  return status !== undefined && ['failed', 'error', 'cancelled', 'canceled'].includes(status)
}

function completedStatus(status: string | undefined): boolean {
  return status !== undefined && ['completed', 'succeeded', 'success'].includes(status)
}

function safeFailure(value: z.infer<typeof envelopeSchema>): Error {
  const code = value.error?.code
  const message = value.error?.message
  const summary = [code === undefined ? null : String(code), message]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(': ')
  return new Error(summary || 'Krill image task failed.')
}

function compiledPrompt(request: GenerationRequest): string {
  const ratio = `画幅比例严格保持 ${request.aspectWidth}:${request.aspectHeight}。`
  const negative = request.negativePrompt.trim()
  return negative === ''
    ? `${ratio}\n${request.prompt}`
    : `${ratio}\n${request.prompt}\n\n避免出现：${negative}`
}

export class KrillImagesProtocol {
  readonly id = 'krill-images-v1'
  readonly label = 'Krill AI · Images'
  readonly capabilities = KRILL_IMAGE_CAPABILITIES
  readonly allowedModels: readonly KrillImageModel[]
  readonly #baseUrl: URL

  constructor(config: { readonly baseUrl?: string; readonly allowedModels?: readonly KrillImageModel[] } = {}) {
    this.#baseUrl = validatedBaseUrl(config.baseUrl ?? KRILL_BASE_URL)
    const allowedModels = config.allowedModels ?? KRILL_IMAGE_MODELS
    if (allowedModels.length === 0) throw new Error('Krill adapter requires at least one allowed image model.')
    this.allowedModels = Object.freeze([...new Set(allowedModels.map((model) => krillModelSchema.parse(model)))])
  }

  buildModelListRequest(): KrillGetRequest {
    return { url: new URL('models', this.#baseUrl).toString() }
  }

  buildGenerationRequest(request: GenerationRequest): KrillJsonRequest {
    krillModelSchema.parse(request.model)
    if (!this.allowedModels.includes(request.model as KrillImageModel)) {
      throw new Error(`Krill model “${request.model}” is outside this authorization.`)
    }
    if (request.count !== 1) throw new Error('Krill asynchronous image tasks currently support exactly one image per AI Canvas job.')
    if (request.references.length > 0) throw new Error('Krill reference generation is not verified and remains disabled.')
    return {
      url: new URL('images/generations', this.#baseUrl).toString(),
      body: {
        model: request.model,
        prompt: compiledPrompt(request),
        size: `${request.outputWidth}x${request.outputHeight}`,
        n: 1,
        async: true,
        stream: false,
        response_format: 'url'
      }
    }
  }

  buildTaskStatusRequest(taskId: string): KrillGetRequest {
    return { url: new URL(`images/${taskIdSchema.parse(taskId)}`, this.#baseUrl).toString() }
  }

  buildTaskContentRequest(taskId: string): KrillGetRequest {
    return { url: new URL(`images/${taskIdSchema.parse(taskId)}/content`, this.#baseUrl).toString() }
  }

  parseModelList(value: unknown): readonly KrillImageModel[] {
    const ids = new Set(modelListSchema.parse(value).data.map((model) => model.id))
    return this.allowedModels.filter((model) => ids.has(model))
  }

  parseSubmission(value: unknown): KrillTaskState {
    return this.#parseEnvelope(value, null)
  }

  parseTask(value: unknown, expectedTaskId: string): KrillTaskState {
    return this.#parseEnvelope(value, taskIdSchema.parse(expectedTaskId))
  }

  #parseEnvelope(value: unknown, fallbackTaskId: string | null): KrillTaskState {
    const parsed = envelopeSchema.parse(value)
    if (parsed.error !== undefined || failedStatus(parsed.status)) throw safeFailure(parsed)
    const taskId = taskIdFrom(parsed, fallbackTaskId)
    const images = normalizedImages(parsed)
    if (images.length > 0) return { kind: 'completed', taskId, images }
    if (taskId !== null && completedStatus(parsed.status)) return { kind: 'completed', taskId, images: [] }
    if (taskId !== null) return { kind: 'pending', taskId, status: parsed.status ?? 'pending' }
    throw new Error('Krill response contained neither image data nor an asynchronous task identifier.')
  }
}
