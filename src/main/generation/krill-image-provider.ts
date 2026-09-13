import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import type { ImageProvider, ProviderGenerateContext, ProviderOutput } from './provider'
import { ProviderError } from './provider'
import {
  KRILL_IMAGE_CAPABILITIES,
  KRILL_IMAGE_MODELS,
  KRILL_PROVIDER_ID,
  type KrillGetRequest,
  type KrillImagesProtocol,
  type KrillJsonRequest,
  type NormalizedKrillImage,
  type KrillTaskState
} from './krill-images-protocol'

interface AsyncImagesProtocol {
  readonly allowedModels: readonly string[]
  buildGenerationRequest(request: GenerationRequest): KrillJsonRequest
  buildTaskStatusRequest(taskId: string): KrillGetRequest
  buildTaskContentRequest(taskId: string): KrillGetRequest
  parseSubmission(value: unknown): KrillTaskState
  parseTask(value: unknown, expectedTaskId: string): KrillTaskState
}

export interface KrillImageDownload {
  readonly bytes: Buffer
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}

/** A future authorized Main-only transport supplies credentials and HTTP. */
export interface KrillTransport {
  postJson(request: KrillJsonRequest, signal: AbortSignal): Promise<unknown>
  getJson(request: KrillGetRequest, signal: AbortSignal): Promise<unknown>
  getImage(request: KrillGetRequest, signal: AbortSignal): Promise<KrillImageDownload>
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function extensionFor(mimeType: ProviderOutput['mimeType']): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType === 'image/png' ? 'png' : 'webp'
}

function providerFailure(error: unknown, stage: 'submitting' | 'generating' | 'localizing'): ProviderError {
  if (error instanceof ProviderError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'KRILL_IMAGE_ERROR'
  return new ProviderError(code, error instanceof Error ? error.message : 'Asynchronous image request failed.', stage)
}

export class KrillImageProvider implements ImageProvider {
  readonly id: string
  readonly label: string
  readonly capabilities: ProviderCapabilities
  readonly #protocol: AsyncImagesProtocol
  readonly #transport: KrillTransport
  readonly #stagingDirectory: string
  readonly #pollIntervalMs: number
  readonly #maxPollRequests: number
  readonly #allowArbitraryModels: boolean

  constructor(options: {
    readonly protocol: KrillImagesProtocol | AsyncImagesProtocol
    readonly transport: KrillTransport
    readonly stagingDirectory: string
    readonly pollIntervalMs?: number
    readonly maxPollRequests?: number
    readonly id?: string
    readonly label?: string
    readonly capabilities?: ProviderCapabilities
    readonly allowArbitraryModels?: boolean
  }) {
    this.id = options.id ?? KRILL_PROVIDER_ID
    this.label = options.label ?? 'Krill AI · Images'
    this.capabilities = options.capabilities ?? KRILL_IMAGE_CAPABILITIES
    this.#protocol = options.protocol
    this.#transport = options.transport
    this.#stagingDirectory = options.stagingDirectory
    this.#pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 3_000)
    this.#maxPollRequests = Math.max(1, Math.floor(options.maxPollRequests ?? 40))
    this.#allowArbitraryModels = options.allowArbitraryModels ?? false
  }

  async generate(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.#validate(request)
    let stage: 'submitting' | 'generating' | 'localizing' = 'submitting'
    try {
      await context.onStage('submitting')
      const scopeId = this.#scopeId(request)
      const raw = await this.#transport.postJson({
        ...this.#protocol.buildGenerationRequest(request),
        authorizationScopeId: scopeId
      }, context.signal)
      const submission = this.#protocol.parseSubmission(raw)
      if (submission.kind === 'completed') {
        stage = 'localizing'
        await context.onStage('localizing')
        return this.#localizeCompleted(submission.images, submission.taskId, context, scopeId)
      }
      await context.onExternalTaskId(submission.taskId)
      stage = 'generating'
      return this.#resumeTask(submission.taskId, context, scopeId)
    } catch (error) {
      throw providerFailure(error, stage)
    }
  }

  async resume(request: GenerationRequest | EditRequest, externalTaskId: string, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    if ('kind' in request && request.kind === 'edit') {
      throw new ProviderError('KRILL_EDIT_NOT_VERIFIED', `${this.label}当前配置不支持蒙版编辑。`, 'validating')
    }
    this.#validate(request)
    try {
      return await this.#resumeTask(externalTaskId, context, this.#scopeId(request))
    } catch (error) {
      throw providerFailure(error, 'generating')
    }
  }

  async edit(): Promise<readonly ProviderOutput[]> {
    throw new ProviderError('KRILL_EDIT_NOT_VERIFIED', `${this.label}当前配置不支持蒙版编辑。`, 'validating')
  }

  #validate(request: GenerationRequest): void {
    const isKnownKrillModel = KRILL_IMAGE_MODELS.includes(request.model as typeof KRILL_IMAGE_MODELS[number])
    if ((!this.#allowArbitraryModels && !isKnownKrillModel) || !this.#protocol.allowedModels.includes(request.model)) {
      throw new ProviderError('KRILL_MODEL_UNAVAILABLE', `模型“${request.model}”不在当前图片模块配置中。`, 'validating')
    }
    if (request.count !== 1) {
      throw new ProviderError('KRILL_SINGLE_IMAGE_ONLY', '异步任务式 Images 当前每个任务只允许一张图片。', 'validating')
    }
    if (request.references.length > 0) {
      throw new ProviderError('KRILL_REFERENCE_NOT_VERIFIED', '异步任务式 Images 当前不支持参考图。', 'validating')
    }
  }

  #scopeId(request: GenerationRequest): string {
    const candidate = request.parameters.workflowIntentId
      ?? request.parameters.workflowInvocationId
      ?? request.sourceMessageId
    return typeof candidate === 'string' && candidate.trim() !== ''
      ? `krill-job:${candidate.trim()}`
      : `krill-job:${randomUUID()}`
  }

  async #resumeTask(taskId: string, context: ProviderGenerateContext, scopeId: string): Promise<readonly ProviderOutput[]> {
    let stage: 'generating' | 'localizing' = 'generating'
    try {
      await context.onStage('generating')
      for (let pollCount = 0; pollCount < this.#maxPollRequests; pollCount += 1) {
        if (context.signal.aborted) throw context.signal.reason
        const raw = await this.#transport.getJson({
          ...this.#protocol.buildTaskStatusRequest(taskId),
          authorizationScopeId: scopeId
        }, context.signal)
        const state = this.#protocol.parseTask(raw, taskId)
        if (state.kind === 'completed') {
          stage = 'localizing'
          await context.onStage('localizing')
          return this.#localizeCompleted(state.images, taskId, context, scopeId)
        }
        await wait(this.#pollIntervalMs, context.signal)
      }
      throw new ProviderError(
        'KRILL_POLL_LIMIT_REACHED',
        `${this.label}的图片任务在授权的 ${this.#maxPollRequests} 次状态查询内没有完成。`,
        'generating'
      )
    } catch (error) {
      throw providerFailure(error, stage)
    }
  }

  async #localizeCompleted(
    images: readonly NormalizedKrillImage[],
    taskId: string | null,
    context: ProviderGenerateContext,
    scopeId: string
  ): Promise<readonly ProviderOutput[]> {
    if (images.length > 1) {
      throw new ProviderError('KRILL_UNEXPECTED_IMAGE_COUNT', `${this.label}返回的图片数超过本次授权数量。`, 'localizing')
    }
    const base64 = images.find((image) => image.kind === 'base64')
    if (base64 !== undefined) return [await this.#writeVerified(Buffer.from(base64.value, 'base64'))]
    if (taskId === null) {
      throw new ProviderError(
        'KRILL_DIRECT_URL_NOT_LOCALIZED',
        `${this.label}只返回了外部图片地址且没有任务 ID；AI Canvas 不会跟随未固定到已保存 Provider 的结果地址。`,
        'localizing'
      )
    }
    const downloaded = await this.#transport.getImage({
      ...this.#protocol.buildTaskContentRequest(taskId),
      authorizationScopeId: scopeId
    }, context.signal)
    return [await this.#writeVerified(downloaded.bytes, downloaded.mimeType)]
  }

  async #writeVerified(bytes: Buffer, declaredMimeType?: ProviderOutput['mimeType']): Promise<ProviderOutput> {
    if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
      throw new ProviderError('KRILL_IMAGE_SIZE', `${this.label}返回的图片为空或超过 50 MB 安全上限。`, 'localizing')
    }
    const metadata = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
    if (metadata.format !== 'png' && metadata.format !== 'jpeg' && metadata.format !== 'webp') {
      throw new ProviderError('KRILL_IMAGE_FORMAT', `${this.label}返回了不支持的图片格式。`, 'localizing')
    }
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 80_000_000) {
      throw new ProviderError('KRILL_IMAGE_DIMENSIONS', `${this.label}返回的图片尺寸超过本地安全上限。`, 'localizing')
    }
    const mimeType: ProviderOutput['mimeType'] = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`
    if (declaredMimeType !== undefined && declaredMimeType !== mimeType) {
      throw new ProviderError('KRILL_IMAGE_TYPE_MISMATCH', `${this.label}返回的图片内容与声明格式不一致。`, 'localizing')
    }
    await mkdir(this.#stagingDirectory, { recursive: true })
    const filePath = join(this.#stagingDirectory, `${randomUUID()}.${extensionFor(mimeType)}`)
    await writeFile(filePath, bytes, { flag: 'wx' })
    return { filePath, mimeType }
  }
}
