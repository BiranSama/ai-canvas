import { z } from 'zod'
import type { GenerationRequest, ProviderCapabilities } from '../../shared/generation'

export const TASK_IMAGES_CAPABILITIES: ProviderCapabilities = {
  textToImage: true,
  imageReferences: false,
  maskEditing: false,
  multipleReferences: false,
  transparentOutput: false,
  maxImages: 1,
  supportedRatios: ['custom'],
  supportedFormats: ['png', 'jpeg', 'webp']
}

const modelSchema = z.string().trim().min(1).max(200)
const taskIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const statusSchema = z.string().trim().min(1).max(80).transform((value) => value.toLowerCase().replaceAll('-', '_'))
const imageSchema = z.object({
  url: z.string().url().max(8_192).optional(),
  b64_json: z.string().min(1).max(70 * 1024 * 1024).optional()
}).passthrough().refine((value) => value.url !== undefined || value.b64_json !== undefined, {
  message: 'Task image result must contain url or b64_json.'
})
const envelopeSchema = z.object({
  id: z.string().optional(),
  image_id: z.string().optional(),
  task_id: z.string().optional(),
  status: statusSchema.optional(),
  data: z.array(imageSchema).optional(),
  result: z.object({ data: z.array(imageSchema).optional() }).passthrough().optional(),
  output: z.array(imageSchema).optional(),
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().max(2_000).optional()
  }).passthrough().optional()
}).passthrough()

export interface TaskImagesJsonRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
  readonly authorizationScopeId?: string
}

export interface TaskImagesGetRequest {
  readonly url: string
  readonly authorizationScopeId?: string
}

export interface NormalizedTaskImage {
  readonly kind: 'base64' | 'url'
  readonly value: string
}

export type TaskImageState =
  | { readonly kind: 'completed'; readonly taskId: string | null; readonly images: readonly NormalizedTaskImage[] }
  | { readonly kind: 'pending'; readonly taskId: string; readonly status: string }

function validatedBaseUrl(value: string): URL {
  const direct = new URL(value)
  if (direct.protocol !== 'https:' || direct.username !== '' || direct.password !== '' || direct.search !== '' || direct.hash !== '') {
    throw new Error('Asynchronous Images Base URL must use credential-free HTTPS.')
  }
  const normalizedPath = direct.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith('/images/generations')) {
    direct.pathname = normalizedPath.slice(0, -'/images/generations'.length) || '/'
  }
  return new URL(direct.toString().endsWith('/') ? direct.toString() : `${direct.toString()}/`)
}

function compiledPrompt(request: GenerationRequest): string {
  const ratio = `画幅比例严格保持 ${request.aspectWidth}:${request.aspectHeight}。`
  const negative = request.negativePrompt.trim()
  return negative === '' ? `${ratio}\n${request.prompt}` : `${ratio}\n${request.prompt}\n\n避免出现：${negative}`
}

function failedStatus(status: string | undefined): boolean {
  return status !== undefined && ['failed', 'error', 'cancelled', 'canceled'].includes(status)
}

function completedStatus(status: string | undefined): boolean {
  return status !== undefined && ['completed', 'succeeded', 'success'].includes(status)
}

export class TaskImagesProtocol {
  readonly id = 'task-images'
  readonly label = '异步任务式 Images'
  readonly capabilities = TASK_IMAGES_CAPABILITIES
  readonly allowedModels: readonly string[]
  readonly #baseUrl: URL

  constructor(config: { readonly baseUrl: string; readonly allowedModels: readonly string[] }) {
    this.#baseUrl = validatedBaseUrl(config.baseUrl)
    if (config.allowedModels.length === 0) throw new Error('Asynchronous Images requires a configured model.')
    this.allowedModels = Object.freeze([...new Set(config.allowedModels.map((model) => modelSchema.parse(model)))])
  }

  buildGenerationRequest(request: GenerationRequest): TaskImagesJsonRequest {
    if (!this.allowedModels.includes(request.model)) throw new Error(`Model “${request.model}” is not the configured asynchronous Images model.`)
    if (request.count !== 1) throw new Error('Asynchronous Images currently supports one image per AI Canvas job.')
    if (request.references.length > 0) throw new Error('Asynchronous Images reference generation is not supported by this protocol.')
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

  buildTaskStatusRequest(taskId: string): TaskImagesGetRequest {
    return { url: new URL(`images/${taskIdSchema.parse(taskId)}`, this.#baseUrl).toString() }
  }

  buildTaskContentRequest(taskId: string): TaskImagesGetRequest {
    return { url: new URL(`images/${taskIdSchema.parse(taskId)}/content`, this.#baseUrl).toString() }
  }

  parseSubmission(value: unknown): TaskImageState {
    return this.#parseEnvelope(value, null)
  }

  parseTask(value: unknown, expectedTaskId: string): TaskImageState {
    return this.#parseEnvelope(value, taskIdSchema.parse(expectedTaskId))
  }

  #parseEnvelope(value: unknown, fallbackTaskId: string | null): TaskImageState {
    const parsed = envelopeSchema.parse(value)
    const taskId = taskIdSchema.nullable().parse(parsed.id ?? parsed.image_id ?? parsed.task_id ?? fallbackTaskId)
    if (parsed.error !== undefined || failedStatus(parsed.status)) {
      const detail = [parsed.error?.code, parsed.error?.message].filter((part) => part !== undefined && part !== '').join(': ')
      throw new Error(detail || 'Asynchronous image task failed.')
    }
    const items = parsed.data ?? parsed.result?.data ?? parsed.output ?? []
    const images = items.map((image) => image.b64_json !== undefined
      ? { kind: 'base64' as const, value: image.b64_json }
      : { kind: 'url' as const, value: image.url! })
    if (images.length > 0) return { kind: 'completed', taskId, images }
    if (taskId !== null && completedStatus(parsed.status)) return { kind: 'completed', taskId, images: [] }
    if (taskId !== null) return { kind: 'pending', taskId, status: parsed.status ?? 'pending' }
    throw new Error('Asynchronous image response contained neither image data nor a task identifier.')
  }
}

