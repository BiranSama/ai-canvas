import { rm } from 'node:fs/promises'
import type { ProviderCostReceipt } from '../../shared/generation-cost'
import type { AssetStore } from '../storage/asset-store'
import {
  imageTaskRequestSchema,
  type GenerationJob,
  type ImageTaskRequest,
  type GenerationStage
} from '../../shared/generation'
import type { GenerationJobRepository } from './generation-job-repository'
import type { ImageProvider, ProviderRegistry } from './provider'
import { ProviderError } from './provider'
import { RedactedLogger, redactSensitive, type DiagnosticLogger } from '../security/redacted-logger'

type QueueAbortKind = 'cancelled' | 'timed_out' | 'suspended'

class QueueAbortError extends Error {
  readonly kind: QueueAbortKind

  constructor(kind: QueueAbortKind) {
    super(kind === 'cancelled' ? 'Generation cancelled by the user.' : kind === 'suspended'
      ? 'Local observation paused; the remote task was not cancelled.' : 'Generation exceeded the configured timeout.')
    this.name = 'QueueAbortError'
    this.kind = kind
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

export interface GenerationQueueOptions {
  readonly projectId: string
  readonly repository: GenerationJobRepository
  readonly assetStore: AssetStore
  readonly providers: ProviderRegistry
  readonly concurrency?: number
  readonly timeoutMs?: number
  readonly now?: () => string
  readonly logger?: DiagnosticLogger
  readonly resolveExecution?: (job: GenerationJob) => Promise<ImageProvider>
  readonly startPaused?: boolean
}

export interface GenerationExecutionIdentity {
  readonly executionIdentityId: string | null
  readonly effectiveTimeoutMs: number
}

export type GenerationJobListener = (job: GenerationJob) => void

export class GenerationQueue {
  readonly #projectId: string
  readonly #repository: GenerationJobRepository
  readonly #assetStore: AssetStore
  readonly #providers: ProviderRegistry
  readonly #concurrency: number
  readonly #timeoutMs: number
  readonly #now: () => string
  readonly #logger: DiagnosticLogger
  readonly #pending: string[] = []
  readonly #active = new Map<string, AbortController>()
  readonly #listeners = new Set<GenerationJobListener>()
  readonly #idleWaiters = new Set<() => void>()
  readonly #preparedProviders = new Map<string, ImageProvider | Error>()
  readonly #resolveExecution: GenerationQueueOptions['resolveExecution']
  #closed = false
  #closePromise: Promise<void> | null = null
  #ready: boolean

  constructor(options: GenerationQueueOptions) {
    this.#projectId = options.projectId
    this.#repository = options.repository
    this.#assetStore = options.assetStore
    this.#providers = options.providers
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
    this.#timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 120_000))
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#logger = options.logger ?? new RedactedLogger()
    this.#resolveExecution = options.resolveExecution
    this.#ready = options.startPaused !== true
  }

  async initialize(options: { readonly activate?: boolean } = {}): Promise<number> {
    this.#assertOpen()
    this.#ready = false
    const active = await this.#repository.listActiveJobs(this.#projectId)
    const resumable: GenerationJob[] = []
    for (const job of active) {
      if (job.externalTaskId === null || this.#active.has(job.id)) continue
      try {
        if ((await this.#providerFor(job)).resume !== undefined) resumable.push(job)
      } catch (error) {
        await this.#pauseIdentity(job.id, error)
      }
    }
    const preserved = new Set([...resumable.map((job) => job.id), ...this.#active.keys()])
    const interrupted = await this.#repository.markRunningInterrupted(this.#projectId, [...preserved])
    for (const job of active) if (!preserved.has(job.id)) this.#emit(await this.#repository.getJob(job.id))
    const queued = await this.#repository.listQueuedJobs(this.#projectId)
    for (const job of [...queued, ...resumable]) {
      if (!this.#pending.includes(job.id)) this.#pending.push(job.id)
    }
    if (options.activate !== false) this.start()
    return interrupted
  }

  start(): void {
    this.#assertOpen()
    this.#ready = true
    this.#pump()
  }

  async enqueue(requestInput: ImageTaskRequest): Promise<GenerationJob> {
    const job = await this.prepare(requestInput)
    await this.activate(job.id)
    return job
  }

  async prepare(requestInput: ImageTaskRequest, identity?: GenerationExecutionIdentity): Promise<GenerationJob> {
    this.#assertOpen()
    const request = imageTaskRequestSchema.parse(requestInput)
    const provider = this.#resolveExecution === undefined ? this.#captureProvider(request.providerId) : undefined
    const job = await this.#repository.createJob({ projectId: this.#projectId, request, ...identity })
    if (provider !== undefined) this.#preparedProviders.set(job.id, provider)
    this.#logger.write('info', 'generation.enqueued', { projectId: this.#projectId, providerId: job.providerId, model: job.model }, job.id)
    return job
  }

  async activate(jobId: string): Promise<void> {
    this.#assertOpen()
    const job = await this.#repository.getJob(jobId)
    if (job.projectId !== this.#projectId) throw new Error('Generation activation belongs to a different project.')
    if (job.status !== 'queued') return
    if (this.#pending.includes(job.id) || this.#active.has(job.id)) return
    this.#pending.push(job.id)
    this.#emit(job)
    this.#pump()
  }

  async cancel(jobId: string): Promise<GenerationJob> {
    this.#assertOpen()
    const requested = await this.#repository.requestCancel(jobId)
    if (requested.status === 'queued') {
      const index = this.#pending.indexOf(jobId)
      if (index >= 0) this.#pending.splice(index, 1)
      const cancelled = await this.#repository.transition(jobId, {
        status: 'cancelled',
        stage: 'cancelled',
        cancelRequested: true,
        completedAt: this.#now(),
        error: { code: 'USER_CANCELLED', message: 'Generation cancelled before it started.', stage: 'cancelled' }
      })
      this.#emit(cancelled)
      this.#resolveIdleIfNeeded()
      return cancelled
    }
    this.#active.get(jobId)?.abort(new QueueAbortError('cancelled'))
    return requested
  }

  async retry(
    jobId: string,
    overrides: { readonly providerId?: string; readonly model?: string } = {}
  ): Promise<GenerationJob> {
    const previous = await this.#repository.getJob(jobId)
    const request = imageTaskRequestSchema.parse({
      ...previous.request,
      providerId: overrides.providerId ?? previous.providerId,
      model: overrides.model ?? previous.model
    })
    const retry = await this.prepareRetry(jobId, request)
    await this.activate(retry.id)
    return retry
  }

  async prepareRetry(jobId: string, requestInput: ImageTaskRequest, identity?: GenerationExecutionIdentity): Promise<GenerationJob> {
    this.#assertOpen()
    const previous = await this.#repository.getJob(jobId)
    if (previous.copiedFromProjectId) throw new Error('PROJECT_COPY_REQUIRES_NEW_REQUEST: copied execution records cannot be retried.')
    if (!['failed', 'cancelled', 'timed_out', 'interrupted'].includes(previous.status)) {
      throw new Error('Only failed, cancelled, timed out or interrupted jobs can be retried.')
    }
    const request = imageTaskRequestSchema.parse(requestInput)
    this.#assertRetrySafe(previous)
    const provider = this.#resolveExecution === undefined ? this.#captureProvider(request.providerId) : undefined
    const created = await this.#repository.createJob({
      projectId: previous.projectId,
      request,
      attempt: previous.attempt + 1,
      parentJobId: previous.id,
      ...identity
    })
    if (provider !== undefined) this.#preparedProviders.set(created.id, provider)
    return created
  }

  #assertRetrySafe(previous: GenerationJob): void {
    if (previous.providerId !== 'mock' && (previous.externalTaskId !== null
      || previous.submissionState !== 'not_sent' || previous.error?.code === 'REQUEST_IDENTITY_UNAVAILABLE')) {
      throw new ProviderError('NO_REPOST', '原请求可能已经发送。请先核对原任务；重试不能创建另一份付费请求。', 'validating')
    }
  }

  async #providerFor(job: GenerationJob): Promise<ImageProvider> {
    if (this.#resolveExecution !== undefined) return this.#resolveExecution(job)
    const provider = this.#preparedProviders.get(job.id) ?? this.#captureProvider(job.providerId)
    if (provider instanceof Error) throw provider
    return provider
  }

  #captureProvider(id: string): ImageProvider | Error {
    try { return this.#providers.get(id) } catch (error) {
      return error instanceof Error ? error : new Error('Provider resolution failed.')
    }
  }

  async #pauseIdentity(jobId: string, cause?: unknown): Promise<void> {
    const budgetMissing = cause instanceof Error && 'code' in cause && cause.code === 'TURN_BUDGET_UNVERIFIED'
    const paused = await this.#repository.transition(jobId, { status: 'interrupted', stage: 'interrupted', completedAt: this.#now(),
      error: { code: budgetMissing ? 'TURN_BUDGET_UNVERIFIED' : 'REQUEST_IDENTITY_UNAVAILABLE',
        message: budgetMissing ? '原任务累计预算或执行权无法核对，已暂停生成。已有作品仍可查看。' : '原请求配置或凭据版本无法验证，已暂停外部执行。请核对原任务。', stage: 'validating' } })
    this.#emit(paused)
  }

  subscribe(listener: GenerationJobListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async waitForIdle(): Promise<void> {
    if (this.#pending.length === 0 && this.#active.size === 0) return
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve))
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    this.#pending.length = 0
    for (const controller of this.#active.values()) controller.abort(new QueueAbortError('suspended'))
    this.#closePromise = this.waitForIdle().then(() => { this.#listeners.clear() })
    return this.#closePromise
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Generation queue is closed.')
  }

  #emit(job: GenerationJob): void {
    for (const listener of this.#listeners) listener(job)
  }

  #pump(): void {
    while (this.#ready && !this.#closed && this.#active.size < this.#concurrency && this.#pending.length > 0) {
      const jobId = this.#pending.shift()
      if (jobId === undefined) break
      const controller = new AbortController()
      this.#active.set(jobId, controller)
      void this.#run(jobId, controller).finally(() => {
        this.#active.delete(jobId)
        this.#pump()
        this.#resolveIdleIfNeeded()
      })
    }
    this.#resolveIdleIfNeeded()
  }

  #resolveIdleIfNeeded(): void {
    if (this.#pending.length > 0 || this.#active.size > 0) return
    for (const resolve of this.#idleWaiters) resolve()
    this.#idleWaiters.clear()
  }

  async #transitionStage(jobId: string, stage: Extract<GenerationStage, 'submitting' | 'generating' | 'localizing'>): Promise<void> {
    const current = await this.#repository.getJob(jobId)
    if (current.status === 'downloading' && stage !== 'localizing') return
    const status = stage === 'localizing' ? 'downloading' : 'generating'
    const job = await this.#repository.transition(jobId, { status, stage,
      ...(current.providerId !== 'mock' && current.submissionState === 'not_sent' ? { submissionState: 'may_have_sent' as const } : {}) })
    this.#emit(job)
  }

  async #recordExternalTaskId(jobId: string, taskId: string): Promise<void> {
    const normalized = taskId.trim()
    if (normalized.length === 0 || normalized.length > 200 || containsControlCharacter(normalized)) {
      throw new ProviderError('INVALID_EXTERNAL_TASK_ID', 'Provider returned an invalid external task identifier.', 'submitting')
    }
    const current = await this.#repository.getJob(jobId)
    if (current.externalTaskId !== null && current.externalTaskId !== normalized) {
      throw new ProviderError('EXTERNAL_TASK_ID_CHANGED', 'Provider attempted to replace the persisted external task identifier.', 'generating')
    }
    const job = await this.#repository.transition(jobId, {
      status: current.status,
      stage: current.stage,
      externalTaskId: normalized,
      submissionState: 'accepted'
    })
    this.#emit(job)
  }

  async #run(jobId: string, controller: AbortController): Promise<void> {
    let outputPaths: string[] = []
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      const initial = await this.#repository.getJob(jobId)
      if (initial.cancelRequested) {
        const cancelled = await this.#repository.transition(jobId, {
          status: 'cancelled',
          stage: 'cancelled',
          completedAt: this.#now(),
          error: { code: 'USER_CANCELLED', message: 'Generation cancelled before it started.', stage: 'cancelled' }
        })
        this.#emit(cancelled)
        return
      }
      let provider: ImageProvider
      try { provider = await this.#providerFor(initial) } catch (error) {
        if (this.#resolveExecution === undefined) throw error
        await this.#pauseIdentity(jobId, error)
        return
      }
      const resuming = initial.externalTaskId !== null
        && ['preparing', 'generating', 'downloading'].includes(initial.status)
        && provider.resume !== undefined
      const preparing = resuming
        ? initial
        : await this.#repository.transition(jobId, {
            status: 'preparing',
            stage: 'validating',
            startedAt: this.#now()
          })
      this.#emit(preparing)
      const elapsed = resuming && initial.startedAt !== null ? Math.max(0, Date.parse(this.#now()) - Date.parse(initial.startedAt)) : 0
      const remaining = (initial.effectiveTimeoutMs ?? this.#timeoutMs) - elapsed
      if (remaining <= 0) throw new QueueAbortError('timed_out')
      timeout = setTimeout(() => controller.abort(new QueueAbortError('timed_out')), remaining)
      const isEdit = 'kind' in preparing.request && preparing.request.kind === 'edit'
      if (isEdit && !provider.capabilities.maskEditing) {
        throw new ProviderError('MASK_EDITING_UNSUPPORTED', `${provider.label} does not support mask editing.`, 'validating')
      }
      const context = {
        signal: controller.signal,
        onStage: (stage: Extract<GenerationStage, 'submitting' | 'generating' | 'localizing'>) => this.#transitionStage(jobId, stage),
        onExternalTaskId: (taskId: string) => this.#recordExternalTaskId(jobId, taskId),
        onCostReceipt: async (receipt: ProviderCostReceipt) => {
          this.#emit(await this.#repository.recordCostReceipt(jobId, receipt))
        },
        resolveAsset: (assetId: string) => this.#assetStore.resolveAsset(assetId)
      }
      const outputs = resuming
        ? await provider.resume!(preparing.request, preparing.externalTaskId!, context)
        : isEdit
          ? await provider.edit(preparing.request, context)
          : await provider.generate(preparing.request, context)
      outputPaths = outputs.map((output) => output.filePath)
      controller.signal.throwIfAborted()
      if (outputs.length === 0) throw new ProviderError('EMPTY_PROVIDER_RESULT', 'The provider returned no images.', 'localizing')
      const assets = []
      for (const output of outputs) {
        const asset = await this.#assetStore.importImage({
          sourcePath: output.filePath,
          sourceType: 'generated',
          sourceId: jobId
        })
        assets.push(asset)
        controller.signal.throwIfAborted()
      }
      const completed = await this.#repository.completeWithAssets(jobId, assets)
      this.#logger.write('info', 'generation.completed', { providerId: completed.providerId, resultCount: completed.results.length }, jobId)
      this.#emit(completed)
    } catch (error) {
      const current = await this.#repository.getJob(jobId)
      if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(current.status)) return
      const abort = error instanceof QueueAbortError ? error : controller.signal.reason
      if (abort instanceof QueueAbortError) {
        if (abort.kind === 'suspended') {
          const resumable = current.externalTaskId !== null
          const paused = await this.#repository.transition(jobId, {
            status: resumable ? current.status : 'interrupted', stage: resumable ? current.stage : 'interrupted',
            ...(resumable ? {} : { completedAt: this.#now() }),
            error: { code: resumable ? 'APP_SUSPENDED' : 'APP_INTERRUPTED', message: abort.message,
              stage: resumable ? current.stage : 'interrupted' }
          })
          this.#emit(paused)
          return
        }
        const status = abort.kind
        const terminal = await this.#repository.transition(jobId, {
          status,
          stage: status,
          cancelRequested: status === 'cancelled' ? true : current.cancelRequested,
          completedAt: this.#now(),
          error: {
            code: status === 'cancelled' ? 'USER_CANCELLED' : 'GENERATION_TIMEOUT',
            message: abort.message,
            stage: status
          }
        })
        this.#emit(terminal)
        this.#logger.write(status === 'cancelled' ? 'info' : 'warn', `generation.${status}`, { code: terminal.error?.code }, jobId)
        return
      }
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError('GENERATION_INTERNAL_ERROR', error instanceof Error ? error.message : 'Unknown generation error.', current.stage)
      if (providerError.code === 'REQUEST_IDENTITY_UNAVAILABLE') {
        await this.#pauseIdentity(jobId)
        return
      }
      const failed = await this.#repository.transition(jobId, {
        status: 'failed',
        stage: 'failed',
        completedAt: this.#now(),
        error: { code: providerError.code, message: redactSensitive(providerError.message), stage: providerError.stage }
      })
      this.#logger.write('error', 'generation.failed', {
        providerId: failed.providerId,
        code: providerError.code,
        stage: providerError.stage,
        message: providerError.message
      }, jobId)
      this.#emit(failed)
    } finally {
      if (timeout !== null) clearTimeout(timeout)
      this.#preparedProviders.delete(jobId)
      await Promise.all(outputPaths.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)))
    }
  }
}
