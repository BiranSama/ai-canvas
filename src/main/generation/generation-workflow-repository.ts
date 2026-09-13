import { createHash, randomUUID } from 'node:crypto'
import { actualCostCny, parseGenerationCost, unknownGenerationCost, type GenerationCost } from '../../shared/generation-cost'
import type { AgentRunBudget } from '../../shared/agent-harness'
import { assertTurnGenerationReservation, captureTurnGenerationBudget, readTurnGenerationBudget, readTurnGenerationUsage, TurnGenerationBudgetError, type GenerationTurnScope } from './generation-turn-budget'
import { isTerminalAgentTurnStatus, type AgentTurnStatus } from '../../shared/agent-harness'
import { isTerminalGenerationJobStatus, type GenerationJob } from '../../shared/generation'
import { promptPackageSchema } from '../../shared/reference'
import {
  generationBudgetReservationSchema,
  generationResultFamilySchema,
  generationResultRecordSchema,
  generationSubscriptionSchema,
  generationWorkflowIntentSchema,
  generationWorkflowSpecSchema,
  providerCompiledRequestSchema,
  type GenerationBudgetReservation,
  type GenerationResultFamily,
  type GenerationResultRecord,
  type GenerationSubscription,
  type GenerationWorkflowIntent,
  type GenerationWorkflowIntentStatus,
  type GenerationWorkflowSpec,
  type ProviderCompiledRequest
} from '../../shared/generation-workflow'
import {
  openDatabase,
  type AgentBudgetReservationRow,
  type DatabaseConnection,
  type GenerationResultRecordRow,
  type GenerationSubscriptionRow,
  type GenerationWorkflowIntentRow
} from '../storage/database'

const ACTIVE_JOB_STATUSES = new Set(['queued', 'preparing', 'generating', 'downloading'])

export class GenerationWorkflowRepositoryError extends Error {
  readonly code: 'INTENT_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_STATE' | 'NO_REPOST' | 'BUDGET_EXCEEDED'

  constructor(code: GenerationWorkflowRepositoryError['code'], message: string) {
    super(message)
    this.name = 'GenerationWorkflowRepositoryError'
    this.code = code
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]))
  }
  return value
}

function sourceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function mapIntent(row: GenerationWorkflowIntentRow): GenerationWorkflowIntent {
  return generationWorkflowIntentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    toolCallItemId: row.tool_call_item_id,
    sourceMessageId: row.source_message_id,
    spec: JSON.parse(row.spec_json),
    compiledRequest: JSON.parse(row.compiled_request_json),
    promptPackage: row.prompt_package_json === null ? null : JSON.parse(row.prompt_package_json),
    sourceHash: row.source_hash,
    status: row.status,
    jobId: row.job_id,
    dispatchAttempts: row.dispatch_attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at
  })
}

function mapReservation(row: AgentBudgetReservationRow, cost = unknownGenerationCost()): GenerationBudgetReservation {
  return generationBudgetReservationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    turnId: row.turn_id,
    intentId: row.intent_id,
    requestLimit: row.request_limit,
    imageLimit: row.image_limit,
    costLimitCny: row.cost_limit_cny,
    actualRequests: row.actual_requests,
    actualImages: row.actual_images,
    actualCostCny: actualCostCny(cost),
    cost,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapSubscription(row: GenerationSubscriptionRow): GenerationSubscription {
  return generationSubscriptionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    intentId: row.intent_id,
    jobId: row.job_id,
    status: row.status,
    lastJobStatus: row.last_job_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observedAt: row.observed_at
  })
}

function mapResultRecord(row: GenerationResultRecordRow & { cost_json: string | null }): GenerationResultRecord {
  const cost = parseGenerationCost(row.cost_json)
  return generationResultRecordSchema.parse({
    resultId: row.result_id,
    intentId: row.intent_id,
    promptPackageHash: row.prompt_package_hash,
    promptPackage: row.prompt_package_json === null ? null : JSON.parse(row.prompt_package_json),
    sourceSceneRevision: row.source_scene_revision,
    profileId: row.profile_id,
    providerId: row.provider_id,
    model: row.model,
    operation: row.operation,
    actualCostCny: actualCostCny(cost),
    cost,
    createdAt: row.created_at
  })
}

export interface PrepareGenerationIntentInput {
  readonly projectId: string
  readonly threadId?: string | null
  readonly turnId?: string | null
  readonly toolCallItemId?: string | null
  readonly sourceMessageId?: string | null
  readonly spec: GenerationWorkflowSpec
  readonly compiledRequest: ProviderCompiledRequest
  readonly promptPackage?: unknown | null
  readonly estimatedCostCny: number
}

export class GenerationWorkflowRepository {
  readonly #connection: DatabaseConnection
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(databasePath: string, options: { readonly idFactory?: () => string; readonly now?: () => string } = {}) {
    this.#connection = openDatabase(databasePath)
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  getTurnBudget(turnId: string): AgentRunBudget | null { return readTurnGenerationBudget(this.#connection, turnId) }

  getTurnUsage(turnId: string) { return readTurnGenerationUsage(this.#connection, turnId) }

  captureTurnBudget(scope: GenerationTurnScope, proposed: AgentRunBudget, grantItemId: string | null): AgentRunBudget {
    return captureTurnGenerationBudget(this.#connection, scope, proposed, grantItemId, this.#now())
  }

  assertJobBudget(job: GenerationJob): void {
    const row = this.#connection.sqlite.prepare(`SELECT i.turn_id, i.project_id, i.thread_id, i.job_id, i.idempotency_key,
      r.turn_id AS reservation_turn, r.request_limit, r.image_limit
      FROM generation_workflow_intents i JOIN agent_budget_reservations r ON r.intent_id = i.id
      WHERE i.id = ?`).get(job.request.parameters.workflowIntentId) as {
        turn_id: string | null; project_id: string; thread_id: string | null; job_id: string | null; reservation_turn: string | null;
        idempotency_key: string; request_limit: number; image_limit: number
      } | undefined
    if (row?.turn_id == null) {
      // A user-triggered retry has its own durable manual reservation and a
      // verified parent Job. It does not revive or reset the original Turn.
      // Merely copying workflowInvocationId into a request grants no authority.
      if (job.parentJobId !== null && row?.thread_id === null && row.reservation_turn === null
        && row.job_id === job.id && row.project_id === job.projectId
        && row.idempotency_key === `retry:${job.parentJobId}:attempt:${job.attempt}`
        && row.request_limit >= 1 && row.image_limit >= job.request.count) {
        const parent = this.#connection.sqlite.prepare(`SELECT project_id, provider_id, attempt, status, submission_state, external_task_id
          FROM generation_jobs WHERE id = ?`).get(job.parentJobId) as {
            project_id: string; provider_id: string; attempt: number; status: GenerationJob['status']; submission_state: string; external_task_id: string | null
          } | undefined
        if (parent?.project_id === job.projectId && parent.provider_id === job.providerId && parent.attempt + 1 === job.attempt
          && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(parent.status)
          && (parent.provider_id === 'mock' || parent.submission_state === 'not_sent' && parent.external_task_id === null)) return
      }
      const oldCall = this.#connection.sqlite.prepare(`SELECT 1 FROM agent_items WHERE (id = ? AND type = 'tool_call')
        OR (type = 'tool_result' AND json_extract(payload_json, '$.outcome.jobId') = ?) LIMIT 1`)
        .get(job.request.parameters.workflowInvocationId ?? null, job.id)
      if (!oldCall) return
      throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '旧生成任务缺少可核对的任务预算，已暂停执行。')
    }
    const limit = this.getTurnBudget(row.turn_id)
    const usage = this.getTurnUsage(row.turn_id)
    const turn = this.#connection.sqlite.prepare('SELECT status FROM agent_turns_v2 WHERE id = ?').get(row.turn_id) as { status: AgentTurnStatus } | undefined
    if (limit === null || row.reservation_turn !== row.turn_id || row.project_id !== job.projectId
      || (row.job_id !== null && row.job_id !== job.id) || turn === undefined || isTerminalAgentTurnStatus(turn.status)
      || usage.jobs > limit.maxGenerationJobs || usage.images > limit.maxGeneratedImages) {
      throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '原任务累计预算或执行权无法核对，已暂停生成。')
    }
  }

  async prepare(inputValue: PrepareGenerationIntentInput): Promise<{
    readonly intent: GenerationWorkflowIntent
    readonly reservation: GenerationBudgetReservation
    readonly reused: boolean
  }> {
    const spec = generationWorkflowSpecSchema.parse(inputValue.spec)
    const compiledRequest = providerCompiledRequestSchema.parse(inputValue.compiledRequest)
    if (compiledRequest.request.count > spec.limits.maxImages || spec.limits.maxJobs < 1) {
      throw new GenerationWorkflowRepositoryError('BUDGET_EXCEEDED', 'Generation request exceeds the workflow image/job limit.')
    }
    if (inputValue.estimatedCostCny < 0 || inputValue.estimatedCostCny > spec.limits.maxCostCny) {
      throw new GenerationWorkflowRepositoryError('BUDGET_EXCEEDED', 'Generation request exceeds the workflow cost limit.')
    }
    const stableSpec = Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'id'))
    const payloadHash = sourceHash({ spec: stableSpec, compiledRequest, promptPackage: inputValue.promptPackage ?? null })
    const now = this.#now()
    const intentRow: GenerationWorkflowIntentRow = {
      id: spec.id,
      project_id: inputValue.projectId,
      thread_id: inputValue.threadId ?? null,
      turn_id: inputValue.turnId ?? null,
      tool_call_item_id: inputValue.toolCallItemId ?? null,
      source_message_id: inputValue.sourceMessageId ?? null,
      spec_json: JSON.stringify(spec),
      compiled_request_json: JSON.stringify(compiledRequest),
      prompt_package_json: inputValue.promptPackage === undefined || inputValue.promptPackage === null ? null : JSON.stringify(inputValue.promptPackage),
      source_hash: payloadHash,
      idempotency_key: spec.idempotencyKey,
      status: 'prepared',
      job_id: null,
      dispatch_attempts: 0,
      error_code: null,
      error_message: null,
      created_at: now,
      updated_at: now,
      dispatched_at: null,
      completed_at: null
    }
    const reservationRow: AgentBudgetReservationRow = {
      id: this.#idFactory(),
      project_id: inputValue.projectId,
      turn_id: inputValue.turnId ?? null,
      intent_id: intentRow.id,
      request_limit: spec.limits.maxJobs,
      image_limit: spec.limits.maxImages,
      cost_limit_cny: spec.limits.maxCostCny,
      actual_requests: 0,
      actual_images: 0,
      actual_cost_cny: 0,
      status: 'reserved',
      created_at: now,
      updated_at: now
    }
    return this.#connection.sqlite.transaction(() => {
      const existing = this.#connection.sqlite.prepare(`
        SELECT * FROM generation_workflow_intents WHERE project_id = ? AND idempotency_key = ?
      `).get(inputValue.projectId, spec.idempotencyKey) as GenerationWorkflowIntentRow | undefined
      if (existing !== undefined) {
        if (existing.source_hash !== payloadHash || existing.turn_id !== (inputValue.turnId ?? null)
          || existing.thread_id !== (inputValue.threadId ?? null) || existing.tool_call_item_id !== (inputValue.toolCallItemId ?? null)) {
          throw new GenerationWorkflowRepositoryError('IDEMPOTENCY_CONFLICT', 'Generation idempotency key was reused with different inputs or authority.')
        }
        const reservation = this.#connection.sqlite.prepare('SELECT * FROM agent_budget_reservations WHERE intent_id = ?')
          .get(existing.id) as AgentBudgetReservationRow
        return { intent: mapIntent(existing), reservation: mapReservation(reservation, this.#costForIntent(existing.id)), reused: true }
      }
      if (inputValue.turnId != null || inputValue.threadId != null || inputValue.toolCallItemId != null) {
        if (!inputValue.turnId || !inputValue.threadId || !inputValue.toolCallItemId) {
          throw new GenerationWorkflowRepositoryError('INVALID_STATE', 'Agent generation requires complete persisted Turn authority before reservation.')
        }
        assertTurnGenerationReservation(this.#connection, {
          projectId: inputValue.projectId, threadId: inputValue.threadId, turnId: inputValue.turnId, toolCallItemId: inputValue.toolCallItemId
        }, compiledRequest.request.count, inputValue.estimatedCostCny)
      }
      this.#connection.sqlite.prepare(`
        INSERT INTO generation_workflow_intents(
          id, project_id, thread_id, turn_id, tool_call_item_id, source_message_id,
          spec_json, compiled_request_json, prompt_package_json, source_hash, idempotency_key,
          status, job_id, dispatch_attempts, error_code, error_message,
          created_at, updated_at, dispatched_at, completed_at
        ) VALUES (
          @id, @project_id, @thread_id, @turn_id, @tool_call_item_id, @source_message_id,
          @spec_json, @compiled_request_json, @prompt_package_json, @source_hash, @idempotency_key,
          @status, @job_id, @dispatch_attempts, @error_code, @error_message,
          @created_at, @updated_at, @dispatched_at, @completed_at
        )
      `).run(intentRow)
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_budget_reservations(
          id, project_id, turn_id, intent_id, request_limit, image_limit, cost_limit_cny,
          actual_requests, actual_images, actual_cost_cny, status, created_at, updated_at
        ) VALUES (
          @id, @project_id, @turn_id, @intent_id, @request_limit, @image_limit, @cost_limit_cny,
          @actual_requests, @actual_images, @actual_cost_cny, @status, @created_at, @updated_at
        )
      `).run(reservationRow)
      return { intent: mapIntent(intentRow), reservation: mapReservation(reservationRow), reused: false }
    }).immediate()
  }

  async getIntent(intentId: string): Promise<GenerationWorkflowIntent> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM generation_workflow_intents WHERE id = ?')
      .get(intentId) as GenerationWorkflowIntentRow | undefined
    if (row === undefined) throw new GenerationWorkflowRepositoryError('INTENT_NOT_FOUND', `Generation workflow intent ${intentId} does not exist.`)
    return mapIntent(row)
  }

  async getIntentByKey(projectId: string, key: string): Promise<GenerationWorkflowIntent | null> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM generation_workflow_intents WHERE project_id = ? AND idempotency_key = ?')
      .get(projectId, key) as GenerationWorkflowIntentRow | undefined
    return row === undefined ? null : mapIntent(row)
  }

  async getIntentByJob(jobId: string): Promise<GenerationWorkflowIntent | null> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM generation_workflow_intents WHERE job_id = ?')
      .get(jobId) as GenerationWorkflowIntentRow | undefined
    return row === undefined ? null : mapIntent(row)
  }

  async getReservation(intentId: string): Promise<GenerationBudgetReservation> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_budget_reservations WHERE intent_id = ?')
      .get(intentId) as AgentBudgetReservationRow | undefined
    if (row === undefined) throw new GenerationWorkflowRepositoryError('INTENT_NOT_FOUND', `Budget reservation for intent ${intentId} does not exist.`)
    return mapReservation(row, this.#costForIntent(intentId))
  }

  async bindIntentToTurn(intentId: string, input: {
    readonly projectId: string
    readonly threadId: string
    readonly turnId: string
    readonly toolCallItemId: string
    readonly sourceMessageId: string
  }): Promise<GenerationWorkflowIntent> {
    const row = this.#requireIntentRow(intentId)
    if (row.project_id !== input.projectId) {
      throw new GenerationWorkflowRepositoryError('INVALID_STATE', 'Generation intent belongs to a different project.')
    }
    if ((row.thread_id !== null && row.thread_id !== input.threadId)
      || (row.turn_id !== null && row.turn_id !== input.turnId)
      || (row.tool_call_item_id !== null && row.tool_call_item_id !== input.toolCallItemId)) {
      throw new GenerationWorkflowRepositoryError('IDEMPOTENCY_CONFLICT', 'Generation intent is already bound to a different Agent Turn or Tool Item.')
    }
    this.#connection.sqlite.prepare(`
      UPDATE generation_workflow_intents
      SET thread_id = ?, turn_id = ?, tool_call_item_id = ?, source_message_id = COALESCE(source_message_id, ?), updated_at = ?
      WHERE id = ?
    `).run(input.threadId, input.turnId, input.toolCallItemId, input.sourceMessageId, this.#now(), intentId)
    return this.getIntent(intentId)
  }

  async markDispatching(intentId: string): Promise<GenerationWorkflowIntent> {
    const now = this.#now()
    this.#connection.sqlite.transaction(() => {
      const row = this.#requireIntentRow(intentId)
      if (row.status !== 'prepared' || row.dispatch_attempts !== 0) {
        throw new GenerationWorkflowRepositoryError('NO_REPOST', 'Generation creation has already crossed the dispatch boundary; automatic repost is forbidden.')
      }
      this.#connection.sqlite.prepare(`
        UPDATE generation_workflow_intents
        SET status = 'dispatching', dispatch_attempts = 1, dispatched_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, intentId)
    })()
    return this.getIntent(intentId)
  }

  async attachJob(intentId: string, jobId: string): Promise<GenerationWorkflowIntent> {
    const now = this.#now()
    const row = this.#requireIntentRow(intentId)
    // A fast Job may already have been attached and observed by its event
    // consumer before the creating call returns. Its receipt remains valid.
    if (row.job_id === jobId) return this.getIntent(intentId)
    if (!['dispatching', 'external_unknown', 'dispatched', 'waiting'].includes(row.status)) {
      throw new GenerationWorkflowRepositoryError('INVALID_STATE', `Intent ${intentId} cannot attach a Job from ${row.status}.`)
    }
    if (row.job_id !== null && row.job_id !== jobId) {
      throw new GenerationWorkflowRepositoryError('IDEMPOTENCY_CONFLICT', 'Generation workflow attempted to attach a different Job.')
    }
    this.#connection.sqlite.prepare(`
      UPDATE generation_workflow_intents
      SET job_id = ?, status = 'dispatched', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(jobId, now, intentId)
    return this.getIntent(intentId)
  }

  async markExternalUnknown(intentId: string, code: string, message: string): Promise<GenerationWorkflowIntent> {
    const row = this.#requireIntentRow(intentId)
    if (!['dispatching', 'external_unknown'].includes(row.status)) {
      throw new GenerationWorkflowRepositoryError('INVALID_STATE', `Intent ${intentId} cannot become external_unknown from ${row.status}.`)
    }
    this.#connection.sqlite.prepare(`
      UPDATE generation_workflow_intents
      SET status = 'external_unknown', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
    `).run(code.slice(0, 120), message.slice(0, 1_000), this.#now(), intentId)
    return this.getIntent(intentId)
  }

  async observeJob(job: GenerationJob): Promise<GenerationWorkflowIntent | null> {
    // Notifications may arrive after a newer persisted transition. Read the
    // authority instead of allowing an old running event to reopen a Job.
    const current = this.#connection.sqlite.prepare('SELECT status, cost_json FROM generation_jobs WHERE id = ?').get(job.id) as { status: string; cost_json: string | null } | undefined
    if (current !== undefined && current.status !== job.status) return this.getIntentByJob(job.id)
    const cost = current === undefined ? job.cost ?? unknownGenerationCost(true) : parseGenerationCost(current.cost_json)
    const settledCny = actualCostCny(cost)
    let intent = await this.getIntentByJob(job.id)
    if (intent === null) {
      const linked = job.request.parameters.workflowIntentId
      if (typeof linked !== 'string') return null
      intent = await this.getIntent(linked).catch(() => null)
      if (intent === null) return null
      await this.attachJob(intent.id, job.id)
      intent = await this.getIntent(intent.id)
    }
    const now = this.#now()
    const status: GenerationWorkflowIntentStatus = ACTIVE_JOB_STATUSES.has(job.status)
      ? 'waiting'
      : job.status === 'completed'
        ? 'completed'
        : job.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
    const resultCountMismatch = job.status === 'completed'
      && job.results.length !== intent.compiledRequest.request.count
    const errorCode = resultCountMismatch ? 'RESULT_COUNT_MISMATCH' : job.error?.code ?? null
    const errorMessage = resultCountMismatch
      ? `Provider returned ${job.results.length} result(s); ${intent.compiledRequest.request.count} were requested.`
      : job.error?.message ?? null
    this.#connection.sqlite.transaction(() => {
      this.#connection.sqlite.prepare(`
        UPDATE generation_workflow_intents
        SET status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(
        status,
        errorCode,
        errorMessage,
        now,
        isTerminalGenerationJobStatus(job.status) ? now : null,
        intent!.id
      )
      if (isTerminalGenerationJobStatus(job.status)) {
        this.#connection.sqlite.prepare(`
          UPDATE agent_budget_reservations
          SET actual_requests = ?, actual_images = ?, actual_cost_cny = COALESCE(?, actual_cost_cny), status = 'committed', updated_at = ?
          WHERE intent_id = ?
        `).run(job.submissionState === 'not_sent' ? 0 : 1, job.results.length, settledCny, now, intent!.id)
      }
      if (job.status === 'completed') {
        const insert = this.#connection.sqlite.prepare(`
          INSERT OR IGNORE INTO generation_result_records(
            result_id, intent_id, prompt_package_hash, prompt_package_json, source_scene_revision,
            profile_id, provider_id, model, operation, actual_cost_cny, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const result of job.results) {
          insert.run(
            result.id,
            intent!.id,
            intent!.spec.promptPackageHash,
            intent!.promptPackage === null ? null : JSON.stringify(intent!.promptPackage),
            intent!.spec.sourceSceneRevision,
            intent!.spec.profileId,
            job.providerId,
            job.model,
            intent!.spec.operation,
            settledCny ?? 0,
            result.createdAt
          )
        }
      }
    })()
    return this.getIntent(intent.id)
  }

  async subscribe(input: {
    readonly projectId: string
    readonly threadId: string
    readonly turnId: string
    readonly intentId: string
    readonly jobId: string
    readonly jobStatus: GenerationJob['status']
  }): Promise<GenerationSubscription> {
    const existing = this.#connection.sqlite.prepare('SELECT * FROM generation_subscriptions WHERE turn_id = ? AND job_id = ?')
      .get(input.turnId, input.jobId) as GenerationSubscriptionRow | undefined
    if (existing !== undefined) return mapSubscription(existing)
    const now = this.#now()
    const row: GenerationSubscriptionRow = {
      id: this.#idFactory(), project_id: input.projectId, thread_id: input.threadId, turn_id: input.turnId,
      intent_id: input.intentId, job_id: input.jobId, status: 'waiting', last_job_status: input.jobStatus,
      created_at: now, updated_at: now, observed_at: null
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO generation_subscriptions(
        id, project_id, thread_id, turn_id, intent_id, job_id, status,
        last_job_status, created_at, updated_at, observed_at
      ) VALUES (
        @id, @project_id, @thread_id, @turn_id, @intent_id, @job_id, @status,
        @last_job_status, @created_at, @updated_at, @observed_at
      )
    `).run(row)
    return mapSubscription(row)
  }

  async observeSubscriptions(job: GenerationJob): Promise<readonly GenerationSubscription[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM generation_subscriptions WHERE job_id = ? AND status IN ('waiting', 'observed')
    `).all(job.id) as GenerationSubscriptionRow[]
    if (rows.length === 0) return []
    const terminal = isTerminalGenerationJobStatus(job.status)
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      UPDATE generation_subscriptions
      SET status = ?, last_job_status = ?, updated_at = ?, observed_at = ?
      WHERE job_id = ? AND status = 'waiting'
    `).run(terminal ? 'observed' : 'waiting', job.status, now, terminal ? now : null, job.id)
    return rows.map((row) => mapSubscription({
      ...row,
      status: row.status === 'observed' || terminal ? 'observed' : 'waiting',
      last_job_status: row.status === 'observed' ? row.last_job_status : job.status,
      updated_at: row.status === 'observed' ? row.updated_at : now,
      observed_at: row.observed_at ?? (terminal ? now : null)
    }))
  }

  async listWaitingSubscriptions(): Promise<readonly GenerationSubscription[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM generation_subscriptions WHERE status = 'waiting' ORDER BY created_at, id
    `).all() as GenerationSubscriptionRow[]
    return rows.map(mapSubscription)
  }

  async listSubscriptionsToReconcile(projectId: string): Promise<readonly GenerationSubscription[]> {
    // Includes the old crash window: Workflow observed, Agent still waiting.
    const rows = this.#connection.sqlite.prepare(`
      SELECT subscriptions.* FROM generation_subscriptions subscriptions
      JOIN agent_turns_v2 turns ON turns.id = subscriptions.turn_id
      WHERE subscriptions.project_id = ? AND subscriptions.status IN ('waiting', 'observed')
        AND turns.status = 'waiting_job'
      ORDER BY subscriptions.created_at, subscriptions.id
    `).all(projectId) as GenerationSubscriptionRow[]
    return rows.map(mapSubscription)
  }

  async cancelSubscriptionsForTurn(turnId: string): Promise<number> {
    const now = this.#now()
    const result = this.#connection.sqlite.prepare(`
      UPDATE generation_subscriptions
      SET status = 'cancelled', updated_at = ?, observed_at = ?
      WHERE turn_id = ? AND status = 'waiting'
    `).run(now, now, turnId)
    return result.changes
  }

  async listResultRecords(): Promise<readonly GenerationResultRecord[]> {
    const rows = this.#connection.sqlite.prepare(`SELECT r.*, j.cost_json FROM generation_result_records r
      JOIN generation_results result ON result.id = r.result_id
      JOIN generation_jobs j ON j.id = result.job_id ORDER BY r.created_at, r.result_id`)
      .all() as (GenerationResultRecordRow & { cost_json: string | null })[]
    return rows.map(mapResultRecord)
  }

  async buildResultFamilies(jobs: readonly GenerationJob[]): Promise<readonly GenerationResultFamily[]> {
    const records = new Map((await this.listResultRecords()).map((record) => [record.resultId, record]))
    const results = jobs.flatMap((job) => job.results.map((result) => ({ job, result })))
    const byId = new Map(results.map((entry) => [entry.result.id, entry]))
    const lineageCache = new Map<string, {
      readonly sourceBriefId: string | null
      readonly sourceDirectionId: string | null
      readonly promptPackageHash: string | null
    }>()
    const lineageOf = (resultId: string, visiting = new Set<string>()): {
      readonly sourceBriefId: string | null
      readonly sourceDirectionId: string | null
      readonly promptPackageHash: string | null
    } => {
      const cached = lineageCache.get(resultId)
      if (cached !== undefined) return cached
      if (visiting.has(resultId)) return { sourceBriefId: null, sourceDirectionId: null, promptPackageHash: null }
      const entry = byId.get(resultId)
      if (entry === undefined) return { sourceBriefId: null, sourceDirectionId: null, promptPackageHash: null }
      visiting.add(resultId)
      const record = records.get(resultId)
      const promptPackage = promptPackageSchema.safeParse(record?.promptPackage ?? entry.job.request.parameters.promptPackage)
      const parentLineage = entry.result.parentResultId === null
        ? null
        : lineageOf(entry.result.parentResultId, visiting)
      const lineage = promptPackage.success
        ? {
            sourceBriefId: promptPackage.data.provenance.briefId,
            sourceDirectionId: promptPackage.data.provenance.directionId ?? null,
            promptPackageHash: record?.promptPackageHash ?? parentLineage?.promptPackageHash ?? null
          }
        : {
            sourceBriefId: parentLineage?.sourceBriefId ?? null,
            sourceDirectionId: parentLineage?.sourceDirectionId ?? null,
            promptPackageHash: record?.promptPackageHash ?? parentLineage?.promptPackageHash ?? null
          }
      visiting.delete(resultId)
      lineageCache.set(resultId, lineage)
      return lineage
    }
    const rootOf = (resultId: string): string => {
      let current = resultId
      const seen = new Set<string>()
      while (!seen.has(current)) {
        seen.add(current)
        const parent = byId.get(current)?.result.parentResultId
        if (parent === null || parent === undefined || !byId.has(parent)) return current
        current = parent
      }
      return resultId
    }
    const groups = new Map<string, typeof results>()
    for (const entry of results) {
      const root = rootOf(entry.result.id)
      const group = groups.get(root) ?? []
      group.push(entry)
      groups.set(root, group)
    }
    return [...groups.entries()].map(([rootResultId, entries]) => {
      const members = entries
        .sort((left, right) => left.result.createdAt.localeCompare(right.result.createdAt) || left.result.id.localeCompare(right.result.id))
        .map(({ job, result }) => {
          const record = records.get(result.id)
          const lineage = lineageOf(result.id)
          return {
            resultId: result.id,
            jobId: job.id,
            assetId: result.assetId,
            parentResultId: result.parentResultId,
            rootResultId,
            variantIndex: result.variantIndex,
            favorite: result.favorite,
            profileId: record?.profileId ?? (typeof job.request.parameters.generationProfileId === 'string' ? job.request.parameters.generationProfileId : null),
            operation: record?.operation ?? null,
            sourceSceneRevision: record?.sourceSceneRevision ?? null,
            promptPackageHash: lineage.promptPackageHash,
            sourceBriefId: lineage.sourceBriefId,
            sourceDirectionId: lineage.sourceDirectionId,
            providerId: job.providerId,
            model: job.model,
            actualCostCny: actualCostCny(job.cost ?? unknownGenerationCost(true)),
            cost: job.cost ?? unknownGenerationCost(true),
            copiedFromProjectId: job.copiedFromProjectId ?? null,
            referenceMode: job.request.referenceMode,
            variationInstruction: job.request.variationInstruction,
            preserveConstraints: job.request.preserveConstraints,
            createdAt: result.createdAt
          }
        })
      return generationResultFamilySchema.parse({
        id: rootResultId,
        rootResultId,
        members,
        favoriteResultIds: members.filter((member) => member.favorite).map((member) => member.resultId),
        latestResultId: members.at(-1)!.resultId
      })
    })
  }

  async close(): Promise<void> {
    this.#connection.sqlite.close()
  }

  #costForIntent(intentId: string): GenerationCost {
    const row = this.#connection.sqlite.prepare(`SELECT j.cost_json FROM generation_workflow_intents i
      LEFT JOIN generation_jobs j ON j.id = i.job_id WHERE i.id = ?`).get(intentId) as { cost_json: string | null } | undefined
    return parseGenerationCost(row?.cost_json)
  }

  #requireIntentRow(intentId: string): GenerationWorkflowIntentRow {
    const row = this.#connection.sqlite.prepare('SELECT * FROM generation_workflow_intents WHERE id = ?')
      .get(intentId) as GenerationWorkflowIntentRow | undefined
    if (row === undefined) throw new GenerationWorkflowRepositoryError('INTENT_NOT_FOUND', `Generation workflow intent ${intentId} does not exist.`)
    return row
  }
}
