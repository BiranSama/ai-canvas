import { createHash, randomUUID } from 'node:crypto'
import type { GenerationJob, ImageTaskRequest, ProviderCapabilities } from '../../shared/generation'
import {
  generationWorkflowSpecSchema,
  type GenerationResultFamily,
  type GenerationWorkflowIntent,
  type GenerationWorkflowOperation,
  type GenerationWorkflowSpec
} from '../../shared/generation-workflow'
import { GenerationCapabilityCompiler } from './generation-capability-compiler'
import type { GenerationWorkflowRepository } from './generation-workflow-repository'
import type { GenerationExecutionIdentity } from './generation-queue'

export interface GenerationWorkflowQueuePort {
  enqueue(request: ImageTaskRequest): Promise<GenerationJob>
  prepare?(request: ImageTaskRequest, identity?: GenerationExecutionIdentity): Promise<GenerationJob>
  prepareRetry?(parentJobId: string, request: ImageTaskRequest, identity?: GenerationExecutionIdentity): Promise<GenerationJob>
  activate?(jobId: string): Promise<void>
  listJobs(): Promise<readonly GenerationJob[]>
  cancel(jobId: string): Promise<GenerationJob>
}

export interface CreateGenerationWorkflowInput {
  readonly projectId: string
  readonly threadId?: string | null
  readonly turnId?: string | null
  readonly toolCallItemId?: string | null
  readonly sourceMessageId?: string | null
  readonly request: ImageTaskRequest
  readonly capabilities: ProviderCapabilities
  readonly profileId: string
  readonly tier: 'local-sketch' | 'draft' | 'final'
  readonly operation: GenerationWorkflowOperation
  readonly sourceSceneRevision: number | null
  readonly promptPackage?: unknown | null
  readonly promptPackageHash?: string | null
  readonly idempotencyKey: string
  readonly limits: GenerationWorkflowSpec['limits']
  readonly estimatedCostCny: number
  readonly deferActivation?: boolean
  readonly parentJobId?: string | null
  readonly bindExecution?: (request: ImageTaskRequest) => Promise<GenerationExecutionIdentity>
}

export class GenerationWorkflowCoordinatorError extends Error {
  readonly code: 'DISPATCH_UNKNOWN' | 'NO_REPOST' | 'JOB_NOT_FOUND'

  constructor(code: GenerationWorkflowCoordinatorError['code'], message: string) {
    super(message)
    this.name = 'GenerationWorkflowCoordinatorError'
    this.code = code
  }
}

function promptHash(promptPackage: unknown | null | undefined): string | null {
  if (promptPackage === undefined || promptPackage === null) return null
  return createHash('sha256').update(JSON.stringify(promptPackage)).digest('hex')
}

function steps() {
  return [
    { id: 'compile', kind: 'compile-prompt' as const, label: '编译 Prompt 与 Provider 能力', required: true },
    { id: 'reserve', kind: 'reserve-budget' as const, label: '持久化预算预留', required: true },
    { id: 'create', kind: 'create-job' as const, label: '创建一次生成任务', required: true },
    { id: 'observe', kind: 'observe-job' as const, label: '订阅并观察原任务', required: true },
    { id: 'localize', kind: 'localize-results' as const, label: '本地化不可变结果', required: true },
    { id: 'lineage', kind: 'record-lineage' as const, label: '记录 Result Family 血缘', required: true }
  ]
}

export class GenerationWorkflowCoordinator {
  readonly #repository: GenerationWorkflowRepository
  readonly #queue: GenerationWorkflowQueuePort
  readonly #compiler: GenerationCapabilityCompiler
  readonly #idFactory: () => string

  constructor(options: {
    readonly repository: GenerationWorkflowRepository
    readonly queue: GenerationWorkflowQueuePort
    readonly compiler?: GenerationCapabilityCompiler
    readonly idFactory?: () => string
  }) {
    this.#repository = options.repository
    this.#queue = options.queue
    this.#compiler = options.compiler ?? new GenerationCapabilityCompiler()
    this.#idFactory = options.idFactory ?? randomUUID
  }

  async create(input: CreateGenerationWorkflowInput): Promise<{ readonly intent: GenerationWorkflowIntent; readonly job: GenerationJob; readonly reused: boolean }> {
    let spec = generationWorkflowSpecSchema.parse({
      version: 1,
      id: this.#idFactory(),
      profileId: input.profileId,
      tier: input.tier,
      operation: input.operation,
      providerId: input.request.providerId,
      model: input.request.model,
      sourceSceneRevision: input.sourceSceneRevision,
      promptPackageHash: input.promptPackageHash ?? promptHash(input.promptPackage),
      idempotencyKey: input.idempotencyKey,
      steps: steps(),
      limits: input.limits
    })
    const compiledRequest = this.#compiler.compile({ spec, request: input.request, capabilities: input.capabilities })
    const identity = await input.bindExecution?.(compiledRequest.request)
    if (identity !== undefined) spec = generationWorkflowSpecSchema.parse({ ...spec, ...identity })
    const prepared = await this.#repository.prepare({
      projectId: input.projectId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.toolCallItemId === undefined ? {} : { toolCallItemId: input.toolCallItemId }),
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      spec,
      compiledRequest,
      promptPackage: input.promptPackage,
      estimatedCostCny: input.estimatedCostCny
    })
    if (prepared.intent.jobId !== null) {
      const existing = (await this.#queue.listJobs()).find((job) => job.id === prepared.intent.jobId)
      if (existing === undefined) throw new GenerationWorkflowCoordinatorError('JOB_NOT_FOUND', 'The persisted workflow references a missing generation Job.')
      if (input.deferActivation !== true && existing.status === 'queued' && this.#queue.activate !== undefined) {
        await this.#queue.activate(existing.id)
      }
      return { intent: prepared.intent, job: existing, reused: true }
    }
    if (prepared.intent.status === 'external_unknown' || prepared.intent.dispatchAttempts > 0) {
      throw new GenerationWorkflowCoordinatorError('NO_REPOST', 'The creation boundary was crossed; reconcile the original task instead of creating another Job.')
    }
    if (input.deferActivation === true && this.#queue.prepare === undefined) {
      throw new Error('Deferred generation activation requires a queue prepare operation.')
    }
    if (input.parentJobId !== undefined && input.parentJobId !== null && this.#queue.prepareRetry === undefined) {
      throw new Error('Generation retry requires a queue prepareRetry operation.')
    }
    await this.#repository.markDispatching(prepared.intent.id)
    try {
      const request = {
        ...compiledRequest.request,
        parameters: {
          ...compiledRequest.request.parameters,
          workflowIntentId: prepared.intent.id,
          workflowIdempotencyKey: spec.idempotencyKey,
          workflowWarnings: compiledRequest.warnings
        }
      }
      const job = input.parentJobId !== undefined && input.parentJobId !== null
        ? await this.#queue.prepareRetry!(input.parentJobId, request, identity)
        : this.#queue.prepare === undefined
          ? await this.#queue.enqueue(request)
          : await this.#queue.prepare(request, identity)
      await this.#repository.attachJob(prepared.intent.id, job.id)
      const observed = await this.#repository.observeJob(job)
      if (this.#queue.prepare !== undefined && input.deferActivation !== true) {
        if (this.#queue.activate === undefined) throw new Error('Generation queue prepare requires a matching activate operation.')
        await this.#queue.activate(job.id)
      }
      return { intent: observed ?? await this.#repository.getIntent(prepared.intent.id), job, reused: prepared.reused }
    } catch (error) {
      await this.#repository.markExternalUnknown(
        prepared.intent.id,
        'GENERATION_DISPATCH_UNKNOWN',
        error instanceof Error ? error.message : 'Generation dispatch status is unknown.'
      )
      throw new GenerationWorkflowCoordinatorError(
        'DISPATCH_UNKNOWN',
        'Generation dispatch may have crossed the create boundary. Automatic repost is disabled; reconcile the original task.'
      )
    }
  }

  getIntentByKey(projectId: string, key: string): Promise<GenerationWorkflowIntent | null> {
    return this.#repository.getIntentByKey(projectId, key)
  }

  async reconcile(intentId: string): Promise<GenerationWorkflowIntent> {
    const intent = await this.#repository.getIntent(intentId)
    if (intent.jobId !== null) return intent
    const job = (await this.#queue.listJobs()).find((candidate) => candidate.request.parameters.workflowIntentId === intent.id)
    if (job === undefined) return intent
    await this.#repository.attachJob(intent.id, job.id)
    return await this.#repository.observeJob(job) ?? this.#repository.getIntent(intent.id)
  }

  observeJob(job: GenerationJob): Promise<GenerationWorkflowIntent | null> {
    return this.#repository.observeJob(job)
  }

  async activate(jobId: string): Promise<void> {
    if (this.#queue.activate === undefined) {
      throw new Error('The configured generation queue does not support prepared Job activation.')
    }
    await this.#queue.activate(jobId)
  }

  resultFamilies(): Promise<readonly GenerationResultFamily[]> {
    return this.#queue.listJobs().then((jobs) => this.#repository.buildResultFamilies(jobs))
  }
}
