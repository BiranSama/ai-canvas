import { randomUUID } from 'node:crypto'
import { generationActualCostSchema, generationCostSchema, parseGenerationCost, unknownGenerationCost, type GenerationCost, type GenerationCostEstimate, type ProviderCostReceipt } from '../../shared/generation-cost'
import type { AssetMetadata } from '../storage/project-repository'
import {
  imageTaskRequestSchema,
  generationStageSchema,
  type GenerationError,
  type GenerationJob,
  type GenerationJobStatus,
  type ImageTaskRequest,
  type GenerationResult,
  type GenerationStage
} from '../../shared/generation'
import {
  openDatabase,
  type DatabaseConnection,
  type GenerationJobRow,
  type GenerationResultRow
} from '../storage/database'

const TERMINAL_STATUSES = new Set<GenerationJobStatus>(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

const ALLOWED_TRANSITIONS: Readonly<Record<GenerationJobStatus, ReadonlySet<GenerationJobStatus>>> = {
  queued: new Set(['queued', 'preparing', 'failed', 'cancelled', 'interrupted']),
  preparing: new Set(['preparing', 'generating', 'downloading', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  generating: new Set(['generating', 'downloading', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  downloading: new Set(['downloading', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  timed_out: new Set(['timed_out']),
  interrupted: new Set(['interrupted'])
}

export interface CreateGenerationJobInput {
  readonly projectId: string
  readonly request: ImageTaskRequest
  readonly attempt?: number
  readonly parentJobId?: string | null
  readonly executionIdentityId?: string | null
  readonly effectiveTimeoutMs?: number | null
  readonly costEstimate?: GenerationCostEstimate | null
}

export interface JobTransition {
  readonly submissionState?: 'not_sent' | 'may_have_sent' | 'accepted'
  readonly status: GenerationJobStatus
  readonly stage: GenerationStage
  readonly externalTaskId?: string | null
  readonly error?: GenerationError | null
  readonly cancelRequested?: boolean
  readonly startedAt?: string | null
  readonly completedAt?: string | null
}

type ResultWithAsset = GenerationResultRow & { readonly asset_status?: 'available' | 'missing' | null }

function mapResult(row: ResultWithAsset): GenerationResult {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    assetId: row.asset_id,
    assetAvailable: row.asset_status !== 'missing' && row.asset_status !== null,
    variantIndex: row.variant_index,
    parentResultId: row.parent_result_id,
    favorite: row.favorite === 1,
    referenceDeleted: row.reference_deleted === 1,
    createdAt: row.created_at
  }
}

function mapJob(row: GenerationJobRow, results: readonly ResultWithAsset[]): GenerationJob {
  const request = imageTaskRequestSchema.parse(JSON.parse(row.request_json))
  const stage = generationStageSchema.parse(row.stage)
  return {
    id: row.id,
    projectId: row.project_id,
    executionIdentityId: row.execution_identity_id,
    copiedFromProjectId: row.copied_from_project_id,
    cost: parseGenerationCost(row.cost_json),
    effectiveTimeoutMs: row.effective_timeout_ms,
    submissionState: row.submission_state ?? (row.external_task_id !== null ? 'accepted' : row.started_at !== null ? 'may_have_sent' : 'not_sent'),
    providerId: row.provider_id,
    model: row.model,
    request,
    status: row.status,
    stage,
    externalTaskId: row.external_task_id,
    attempt: row.attempt,
    parentJobId: row.parent_job_id,
    sourceMessageId: row.source_message_id,
    cancelRequested: row.cancel_requested === 1,
    error: row.error_code === null
      ? null
      : {
          code: row.error_code,
          message: row.error_message ?? 'Generation failed.',
          stage: generationStageSchema.parse(row.error_stage ?? 'failed')
        },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    results: results.map(mapResult)
  }
}

export class GenerationJobRepository {
  readonly #connection: DatabaseConnection
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(
    databasePath: string,
    options: { readonly idFactory?: () => string; readonly now?: () => string } = {}
  ) {
    this.#connection = openDatabase(databasePath)
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async createJob(input: CreateGenerationJobInput): Promise<GenerationJob> {
    const request = imageTaskRequestSchema.parse(input.request)
    const now = this.#now()
    const id = this.#idFactory()
    const simulation = request.parameters.simulatedEstimatedCostCny
    const estimate = input.costEstimate ?? (request.providerId === 'mock' && typeof simulation === 'number' && Number.isFinite(simulation) && simulation >= 0 && simulation <= 1_000_000
      ? { amount: simulation, currency: 'CNY', source: 'offline_simulation' as const, estimatedAt: now,
          parameters: { profileId: String(request.parameters.generationProfileId ?? 'local-sketch'), model: request.model, imageCount: request.count } }
      : null)
    const cost: GenerationCost = request.providerId === 'mock'
      ? { version: 1, estimate, actual: { status: 'known_free', amount: 0, currency: 'CNY', source: 'offline_mock', evidence: { receiptId: `offline:${id}`, observedAt: now } } }
      : { ...unknownGenerationCost(), estimate }
    await this.#connection.kysely
      .insertInto('generation_jobs')
      .values({
        id,
        project_id: input.projectId,
        provider_id: request.providerId,
        model: request.model,
        request_json: JSON.stringify(request),
        status: 'queued',
        stage: 'queued',
        external_task_id: null,
        attempt: input.attempt ?? 1,
        parent_job_id: input.parentJobId ?? null,
        execution_identity_id: input.executionIdentityId ?? null,
        copied_from_project_id: null,
        cost_json: JSON.stringify(generationCostSchema.parse(cost)),
        effective_timeout_ms: input.effectiveTimeoutMs ?? null,
        submission_state: 'not_sent',
        source_message_id: request.sourceMessageId,
        cancel_requested: 0,
        error_code: null,
        error_message: null,
        error_stage: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null
      })
      .executeTakeFirstOrThrow()
    return this.getJob(id)
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const row = await this.#connection.kysely
      .selectFrom('generation_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst()
    if (row === undefined) throw new Error(`Generation job ${jobId} does not exist.`)
    const results = await this.#connection.kysely
      .selectFrom('generation_results')
      .leftJoin('assets', 'assets.id', 'generation_results.asset_id')
      .selectAll('generation_results')
      .select('assets.status as asset_status')
      .where('generation_results.job_id', '=', jobId)
      .orderBy('variant_index', 'asc')
      .execute()
    return mapJob(row, results)
  }

  async recordCostReceipt(jobId: string, value: ProviderCostReceipt): Promise<GenerationJob> {
    const receipt = generationActualCostSchema.parse(value)
    if (receipt.status === 'unknown' || receipt.source === 'offline_mock') throw new Error('A provider receipt must carry verified settlement evidence.')
    this.#connection.sqlite.transaction(() => {
      const row = this.#connection.sqlite.prepare('SELECT cost_json, copied_from_project_id FROM generation_jobs WHERE id = ?').get(jobId) as { cost_json: string | null; copied_from_project_id: string | null } | undefined
      if (row === undefined || row.copied_from_project_id !== null) throw new Error('The original active project must receive this settlement evidence.')
      const cost = parseGenerationCost(row.cost_json)
      if (cost.actual.status !== 'unknown') {
        if (cost.actual.status === receipt.status && cost.actual.source === receipt.source && cost.actual.currency === receipt.currency
          && cost.actual.amount === receipt.amount && cost.actual.evidence.receiptId === receipt.evidence.receiptId) return
        throw new Error('Conflicting settlement evidence; the existing verified receipt was preserved.')
      }
      this.#connection.sqlite.prepare('UPDATE generation_jobs SET cost_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...cost, actual: receipt }), this.#now(), jobId)
    }).immediate()
    return this.getJob(jobId)
  }

  async listJobs(projectId: string): Promise<readonly GenerationJob[]> {
    const rows = await this.#connection.kysely
      .selectFrom('generation_jobs')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute()
    const results = await this.#connection.kysely
      .selectFrom('generation_results')
      .leftJoin('assets', 'assets.id', 'generation_results.asset_id')
      .selectAll('generation_results')
      .select('assets.status as asset_status')
      .where('generation_results.project_id', '=', projectId)
      .orderBy('variant_index', 'asc')
      .execute()
    const resultsByJob = new Map<string, ResultWithAsset[]>()
    for (const result of results) {
      const group = resultsByJob.get(result.job_id) ?? []
      group.push(result)
      resultsByJob.set(result.job_id, group)
    }
    return rows.map((row) => mapJob(row, resultsByJob.get(row.id) ?? []))
  }

  async listQueuedJobs(projectId: string): Promise<readonly GenerationJob[]> {
    return (await this.listJobs(projectId)).filter((job) => job.status === 'queued')
  }

  async listActiveJobs(projectId: string): Promise<readonly GenerationJob[]> {
    return (await this.listJobs(projectId)).filter((job) => ['preparing', 'generating', 'downloading'].includes(job.status))
  }

  async transition(jobId: string, transition: JobTransition): Promise<GenerationJob> {
    const current = await this.getJob(jobId)
    if (!ALLOWED_TRANSITIONS[current.status].has(transition.status)) {
      throw new Error(`Illegal generation job transition: ${current.status} -> ${transition.status}.`)
    }
    const now = this.#now()
    await this.#connection.kysely
      .updateTable('generation_jobs')
      .set({
        status: transition.status,
        submission_state: transition.submissionState ?? current.submissionState ?? null,
        stage: transition.stage,
        external_task_id: transition.externalTaskId === undefined ? current.externalTaskId : transition.externalTaskId,
        cancel_requested: transition.cancelRequested === undefined
          ? (current.cancelRequested ? 1 : 0)
          : (transition.cancelRequested ? 1 : 0),
        error_code: transition.error?.code ?? null,
        error_message: transition.error?.message ?? null,
        error_stage: transition.error?.stage ?? null,
        updated_at: now,
        started_at: transition.startedAt === undefined ? current.startedAt : transition.startedAt,
        completed_at: transition.completedAt === undefined ? current.completedAt : transition.completedAt
      })
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow()
    return this.getJob(jobId)
  }

  async requestCancel(jobId: string): Promise<GenerationJob> {
    const job = await this.getJob(jobId)
    if (TERMINAL_STATUSES.has(job.status)) return job
    await this.#connection.kysely
      .updateTable('generation_jobs')
      .set({ cancel_requested: 1, updated_at: this.#now() })
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow()
    return this.getJob(jobId)
  }

  async markRunningInterrupted(projectId: string, preservedJobIds: readonly string[] = []): Promise<number> {
    const now = this.#now()
    let query = this.#connection.kysely
      .updateTable('generation_jobs')
      .set({
        status: 'interrupted',
        stage: 'interrupted',
        error_code: 'APP_INTERRUPTED',
        error_message: '应用在任务结束前停止。原请求及远端状态已保留；请先核对原任务，系统不会自动重新发送。',
        error_stage: 'interrupted',
        completed_at: now,
        updated_at: now
      })
      .where('project_id', '=', projectId)
      .where('status', 'in', ['preparing', 'generating', 'downloading'])
    if (preservedJobIds.length > 0) query = query.where('id', 'not in', [...preservedJobIds])
    const result = await query.executeTakeFirst()
    return Number(result.numUpdatedRows)
  }

  async completeWithAssets(jobId: string, assets: readonly AssetMetadata[]): Promise<GenerationJob> {
    const job = await this.getJob(jobId)
    if (!ALLOWED_TRANSITIONS[job.status].has('completed')) {
      throw new Error(`Illegal generation job transition: ${job.status} -> completed.`)
    }
    const now = this.#now()
    const complete = this.#connection.sqlite.transaction(() => {
      const insertResult = this.#connection.sqlite.prepare(`
        INSERT INTO generation_results(
          id, job_id, project_id, asset_id, variant_index, parent_result_id, favorite, reference_deleted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
      `)
      assets.forEach((asset, variantIndex) => {
        insertResult.run(
          this.#idFactory(),
          job.id,
          job.projectId,
          asset.id,
          variantIndex,
          job.request.parentResultId,
          now
        )
      })
      this.#connection.sqlite.prepare(`
        UPDATE generation_jobs
        SET status = 'completed', stage = 'completed', error_code = NULL, error_message = NULL,
            error_stage = NULL, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(now, now, jobId)
    })
    complete()
    return this.getJob(jobId)
  }

  async setFavorite(resultId: string, favorite: boolean): Promise<void> {
    await this.#connection.kysely
      .updateTable('generation_results')
      .set({ favorite: favorite ? 1 : 0 })
      .where('id', '=', resultId)
      .executeTakeFirstOrThrow()
  }

  async markReferenceDeleted(resultId: string): Promise<void> {
    await this.#connection.kysely
      .updateTable('generation_results')
      .set({ reference_deleted: 1 })
      .where('id', '=', resultId)
      .executeTakeFirstOrThrow()
  }

  async close(): Promise<void> {
    await this.#connection.kysely.destroy()
  }
}
