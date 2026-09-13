import { randomUUID } from 'node:crypto'
import { isTerminalGenerationJobStatus, type GenerationJob } from '../../shared/generation'
import type { GenerationSubscription } from '../../shared/generation-workflow'
import {
  agentEventSchema,
  agentGoalContractSchema,
  agentHarnessSnapshotSchema,
  agentGoalScopeSchema,
  agentItemSchema,
  agentQueueEntrySchema,
  agentRunBudgetSchema,
  agentThreadSchema,
  agentTurnSchema,
  agentTurnStatusSchema,
  dispatchModeSchema,
  isTerminalAgentTurnStatus,
  taskRelationSchema,
  temporaryTryStateSchema,
  turnInputModeSchema,
  type AgentEvent,
  type AgentGoalContract,
  type AgentHarnessSnapshot,
  type AgentGoalScope,
  type AgentItem,
  type AgentItemStatus,
  type AgentItemType,
  type AgentMode,
  type AgentQueueEntry,
  type AgentRunBudget,
  type AgentThread,
  type AgentTurn,
  type AgentTurnStatus,
  type DispatchMode,
  type TaskRelation,
  type TemporaryTryState,
  type TurnInputMode
} from '../../shared/agent-harness'
import {
  openDatabase,
  type AgentEventRow,
  type AgentGoalRow,
  type AgentItemRow,
  type AgentQueueEntryRow,
  type AgentThreadRow,
  type AgentTurnV2Row,
  type DatabaseConnection
} from '../storage/database'

export class AgentHarnessRepositoryError extends Error {
  readonly code: 'ACTIVE_TURN_EXISTS' | 'THREAD_NOT_FOUND' | 'TURN_NOT_FOUND' | 'ITEM_NOT_FOUND'

  constructor(code: AgentHarnessRepositoryError['code'], message: string) {
    super(message)
    this.name = 'AgentHarnessRepositoryError'
    this.code = code
  }
}

export interface CreateGoalInput {
  readonly objective: string
  readonly completionDefinition: readonly string[]
  readonly mode: AgentMode
  readonly scope: AgentGoalScope
  readonly permissionProfileId: string | null
  readonly budget: AgentRunBudget
  readonly prohibitions: readonly string[]
}

export interface StartTurnInput {
  readonly goalId: string | null
  readonly inputMessageId: string | null
  readonly taskId?: string
  readonly taskRelation?: TaskRelation
  readonly dispatchMode?: DispatchMode
  readonly baseTaskId?: string | null
  readonly temporaryState?: TemporaryTryState | null
  readonly sceneRevisionAtStart: number
}

export interface AppendItemInput {
  readonly type: AgentItemType
  readonly status: AgentItemStatus
  readonly payloadVersion: number
  readonly payload: unknown
}

interface TransitionTurnOptions {
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
}

export interface AgentTurnUsageDelta {
  readonly modelTurns?: number
  readonly toolCalls?: number
  readonly sceneWriteBatches?: number
  readonly recoveryAttempts?: number
}

function mapThread(row: AgentThreadRow): AgentThread {
  return agentThreadSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    activeGoalId: row.active_goal_id,
    activeTurnId: row.active_turn_id,
    lastSequence: row.last_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapGoal(row: AgentGoalRow): AgentGoalContract {
  return agentGoalContractSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    objective: row.objective,
    completionDefinition: JSON.parse(row.completion_definition_json),
    mode: row.mode,
    scope: JSON.parse(row.scope_json),
    permissionProfileId: row.permission_profile_id,
    budget: JSON.parse(row.budget_json),
    prohibitions: JSON.parse(row.prohibitions_json),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapTurn(row: AgentTurnV2Row, timeLimitMs: number | null = null): AgentTurn {
  return agentTurnSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    goalId: row.goal_id,
    inputMessageId: row.input_message_id,
    taskId: row.task_id,
    taskRelation: row.task_relation,
    dispatchMode: row.dispatch_mode,
    baseTaskId: row.base_task_id,
    temporaryState: row.temporary_state,
    status: row.status,
    timeLimitMs,
    sceneRevisionAtStart: row.scene_revision_at_start,
    contextManifestId: row.context_manifest_id,
    writeLeaseId: row.write_lease_id,
    modelTurnsUsed: row.model_turns_used,
    toolCallsUsed: row.tool_calls_used,
    sceneWriteBatchesUsed: row.scene_write_batches_used,
    recoveryAttemptsUsed: row.recovery_attempts_used,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  })
}

function mapItem(row: AgentItemRow): AgentItem {
  return agentItemSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    type: row.type,
    status: row.status,
    ordinal: row.ordinal,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapEvent(row: AgentEventRow): AgentEvent {
  return agentEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    sequence: row.sequence,
    type: row.type,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at
  })
}

function mapQueue(row: AgentQueueEntryRow): AgentQueueEntry {
  return agentQueueEntrySchema.parse({
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    mode: row.mode,
    taskId: row.task_id,
    taskRelation: row.task_relation,
    dispatchMode: row.dispatch_mode,
    baseTaskId: row.base_task_id,
    position: row.position,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export class AgentHarnessRepository {
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

  async ensureThread(projectId: string, title = '创作助手'): Promise<AgentThread> {
    const existing = this.#connection.sqlite.prepare('SELECT * FROM agent_threads WHERE project_id = ?').get(projectId) as AgentThreadRow | undefined
    if (existing !== undefined) return mapThread(existing)
    const now = this.#now()
    const row: AgentThreadRow = {
      id: this.#idFactory(), project_id: projectId, title, status: 'active', active_goal_id: null,
      active_turn_id: null, last_sequence: 0, created_at: now, updated_at: now
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_threads(id, project_id, title, status, active_goal_id, active_turn_id, last_sequence, created_at, updated_at)
      VALUES (@id, @project_id, @title, @status, @active_goal_id, @active_turn_id, @last_sequence, @created_at, @updated_at)
    `).run(row)
    return mapThread(row)
  }

  async getThread(threadId: string): Promise<AgentThread> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_threads WHERE id = ?').get(threadId) as AgentThreadRow | undefined
    if (row === undefined) throw new AgentHarnessRepositoryError('THREAD_NOT_FOUND', `Agent thread ${threadId} does not exist.`)
    return mapThread(row)
  }

  async createGoal(threadId: string, input: CreateGoalInput): Promise<AgentGoalContract> {
    await this.getThread(threadId)
    const scope = agentGoalScopeSchema.parse(input.scope)
    const budget = agentRunBudgetSchema.parse(input.budget)
    const now = this.#now()
    const row: AgentGoalRow = {
      id: this.#idFactory(), thread_id: threadId, objective: input.objective,
      completion_definition_json: JSON.stringify(input.completionDefinition), mode: input.mode,
      scope_json: JSON.stringify(scope), permission_profile_id: input.permissionProfileId,
      budget_json: JSON.stringify(budget), prohibitions_json: JSON.stringify(input.prohibitions),
      status: 'active', version: 1, created_at: now, updated_at: now
    }
    const parsed = mapGoal(row)
    const transaction = this.#connection.sqlite.transaction(() => {
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_goals(
          id, thread_id, objective, completion_definition_json, mode, scope_json, permission_profile_id,
          budget_json, prohibitions_json, status, version, created_at, updated_at
        ) VALUES (
          @id, @thread_id, @objective, @completion_definition_json, @mode, @scope_json, @permission_profile_id,
          @budget_json, @prohibitions_json, @status, @version, @created_at, @updated_at
        )
      `).run(row)
      this.#connection.sqlite.prepare('UPDATE agent_threads SET active_goal_id = ?, updated_at = ? WHERE id = ?')
        .run(row.id, now, threadId)
    })
    transaction()
    return parsed
  }

  async getGoal(goalId: string): Promise<AgentGoalContract> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_goals WHERE id = ?').get(goalId) as AgentGoalRow | undefined
    if (row === undefined) throw new Error(`Agent goal ${goalId} does not exist.`)
    return mapGoal(row)
  }

  async startTurn(threadId: string, input: StartTurnInput): Promise<AgentTurn> {
    const now = this.#now()
    const id = this.#idFactory()
    const taskRelation = taskRelationSchema.parse(input.taskRelation ?? 'new_task')
    const row: AgentTurnV2Row = {
      id, thread_id: threadId, goal_id: input.goalId, input_message_id: input.inputMessageId,
      task_id: input.taskId ?? id, task_relation: taskRelation, dispatch_mode: dispatchModeSchema.parse(input.dispatchMode ?? 'apply_now'),
      base_task_id: input.baseTaskId ?? null,
      temporary_state: input.temporaryState ?? (taskRelation === 'temporary_try' ? 'pending' : null),
      status: 'queued', scene_revision_at_start: input.sceneRevisionAtStart, context_manifest_id: null,
      write_lease_id: null, model_turns_used: 0, tool_calls_used: 0, scene_write_batches_used: 0,
      recovery_attempts_used: 0, error_code: null, error_message: null, created_at: now, updated_at: now,
      completed_at: null
    }
    const parsed = this.#mapTurn(row)
    const transaction = this.#connection.sqlite.transaction(() => {
      const thread = this.#requireThreadRow(threadId)
      const active = this.#connection.sqlite.prepare(`
        SELECT id FROM agent_turns_v2 WHERE thread_id = ?
          AND status IN ('queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job')
        LIMIT 1
      `).get(threadId) as { id: string } | undefined
      if (active !== undefined) {
        throw new AgentHarnessRepositoryError('ACTIVE_TURN_EXISTS', `Agent thread ${threadId} already has active turn ${active.id}.`)
      }
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_turns_v2(
          id, thread_id, goal_id, input_message_id, task_id, task_relation, dispatch_mode, base_task_id, temporary_state,
          status, scene_revision_at_start, context_manifest_id,
          write_lease_id, model_turns_used, tool_calls_used, scene_write_batches_used, recovery_attempts_used,
          error_code, error_message, created_at, updated_at, completed_at
        ) VALUES (
          @id, @thread_id, @goal_id, @input_message_id, @task_id, @task_relation, @dispatch_mode, @base_task_id, @temporary_state,
          @status, @scene_revision_at_start, @context_manifest_id,
          @write_lease_id, @model_turns_used, @tool_calls_used, @scene_write_batches_used, @recovery_attempts_used,
          @error_code, @error_message, @created_at, @updated_at, @completed_at
        )
      `).run(row)
      this.#connection.sqlite.prepare('UPDATE agent_threads SET active_turn_id = ?, updated_at = ? WHERE id = ?')
        .run(row.id, now, threadId)
      this.#appendEvent(thread, { turnId: row.id, itemId: null, type: 'turn.started', payload: { status: row.status } }, now)
    })
    transaction()
    return parsed
  }

  async getTurn(turnId: string): Promise<AgentTurn> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_turns_v2 WHERE id = ?').get(turnId) as AgentTurnV2Row | undefined
    if (row === undefined) throw new AgentHarnessRepositoryError('TURN_NOT_FOUND', `Agent turn ${turnId} does not exist.`)
    return this.#mapTurn(row)
  }

  async getActiveTurn(threadId: string): Promise<AgentTurn | null> {
    const row = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_turns_v2 WHERE thread_id = ?
        AND status IN ('queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(threadId) as AgentTurnV2Row | undefined
    return row === undefined ? null : this.#mapTurn(row)
  }

  async setTurnContextManifest(turnId: string, manifestId: string): Promise<AgentTurn> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      const manifest = this.#connection.sqlite.prepare(`
        SELECT id FROM agent_context_manifests WHERE id = ? AND turn_id = ? AND thread_id = ?
      `).get(manifestId, turnId, thread.id) as { readonly id: string } | undefined
      if (manifest === undefined) throw new Error(`Context manifest ${manifestId} does not belong to turn ${turnId}.`)
      this.#connection.sqlite.prepare('UPDATE agent_turns_v2 SET context_manifest_id = ?, updated_at = ? WHERE id = ?')
        .run(manifestId, now, turnId)
      this.#appendEvent(thread, {
        turnId,
        itemId: null,
        type: 'context.manifest.created',
        payload: { manifestId }
      }, now)
    })
    transaction()
    return this.getTurn(turnId)
  }

  async findTurnByInputMessageId(threadId: string, inputMessageId: string): Promise<AgentTurn | null> {
    const row = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_turns_v2 WHERE thread_id = ? AND input_message_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(threadId, inputMessageId) as AgentTurnV2Row | undefined
    return row === undefined ? null : this.#mapTurn(row)
  }

  async listTurns(threadId: string): Promise<readonly AgentTurn[]> {
    const rows = this.#connection.sqlite.prepare('SELECT * FROM agent_turns_v2 WHERE thread_id = ? ORDER BY created_at DESC, id DESC')
      .all(threadId) as AgentTurnV2Row[]
    return rows.map((row) => this.#mapTurn(row))
  }

  async setTemporaryState(turnId: string, stateInput: TemporaryTryState): Promise<AgentTurn> {
    const state = temporaryTryStateSchema.parse(stateInput)
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      if (turn.task_relation !== 'temporary_try') throw new Error('Only a temporary try can be accepted or rejected.')
      const thread = this.#requireThreadRow(turn.thread_id)
      this.#connection.sqlite.prepare('UPDATE agent_turns_v2 SET temporary_state = ?, updated_at = ? WHERE id = ?')
        .run(state, now, turnId)
      this.#appendEvent(thread, {
        turnId,
        itemId: null,
        type: `temporary.${state}`,
        payload: { taskId: turn.task_id, baseTaskId: turn.base_task_id }
      }, now)
    })
    transaction()
    return this.getTurn(turnId)
  }

  async transitionTurn(turnId: string, statusInput: AgentTurnStatus, options: TransitionTurnOptions = {}): Promise<AgentTurn> {
    const status = agentTurnStatusSchema.parse(statusInput)
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      const terminal = isTerminalAgentTurnStatus(status)
      const errorCode = Object.prototype.hasOwnProperty.call(options, 'errorCode') ? options.errorCode ?? null : turn.error_code
      const errorMessage = Object.prototype.hasOwnProperty.call(options, 'errorMessage') ? options.errorMessage ?? null : turn.error_message
      this.#connection.sqlite.prepare(`
        UPDATE agent_turns_v2 SET status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(status, errorCode, errorMessage, now, terminal ? now : null, turnId)
      if (terminal && thread.active_turn_id === turnId) {
        this.#connection.sqlite.prepare('UPDATE agent_threads SET active_turn_id = NULL, updated_at = ? WHERE id = ?').run(now, thread.id)
      }
      if (terminal && !['completed', 'completed_with_notes'].includes(status)) {
        this.#connection.sqlite.prepare("UPDATE agent_queue_entries SET status = 'paused', updated_at = ? WHERE thread_id = ? AND status = 'queued'")
          .run(now, thread.id)
      }
      this.#appendEvent(thread, {
        turnId, itemId: null, type: terminal ? 'turn.completed' : 'turn.status',
        payload: { status, errorCode }
      }, now)
    })
    transaction()
    return this.getTurn(turnId)
  }

  async incrementTurnUsage(turnId: string, delta: AgentTurnUsageDelta): Promise<AgentTurn> {
    const values = {
      modelTurns: Math.max(0, Math.floor(delta.modelTurns ?? 0)),
      toolCalls: Math.max(0, Math.floor(delta.toolCalls ?? 0)),
      sceneWriteBatches: Math.max(0, Math.floor(delta.sceneWriteBatches ?? 0)),
      recoveryAttempts: Math.max(0, Math.floor(delta.recoveryAttempts ?? 0))
    }
    if (Object.values(values).every((value) => value === 0)) return this.getTurn(turnId)
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      this.#connection.sqlite.prepare(`
        UPDATE agent_turns_v2 SET
          model_turns_used = model_turns_used + ?,
          tool_calls_used = tool_calls_used + ?,
          scene_write_batches_used = scene_write_batches_used + ?,
          recovery_attempts_used = recovery_attempts_used + ?,
          updated_at = ?
        WHERE id = ?
      `).run(values.modelTurns, values.toolCalls, values.sceneWriteBatches, values.recoveryAttempts, now, turnId)
      this.#appendEvent(thread, {
        turnId,
        itemId: null,
        type: 'turn.usage',
        payload: values
      }, now)
    })
    transaction()
    return this.getTurn(turnId)
  }

  async appendItem(turnId: string, input: AppendItemInput): Promise<AgentItem> {
    const now = this.#now()
    let row: AgentItemRow | null = null
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      const ordinalRow = this.#connection.sqlite.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM agent_items WHERE turn_id = ?')
        .get(turnId) as { ordinal: number }
      row = {
        id: this.#idFactory(), thread_id: thread.id, turn_id: turnId, type: input.type, status: input.status,
        ordinal: ordinalRow.ordinal, payload_version: input.payloadVersion, payload_json: JSON.stringify(input.payload ?? null),
        created_at: now, updated_at: now
      }
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_items(id, thread_id, turn_id, type, status, ordinal, payload_version, payload_json, created_at, updated_at)
        VALUES (@id, @thread_id, @turn_id, @type, @status, @ordinal, @payload_version, @payload_json, @created_at, @updated_at)
      `).run(row)
      this.#appendEvent(thread, { turnId, itemId: row.id, type: `item.${input.status}`, payload: { itemType: input.type } }, now)
    })
    transaction()
    if (row === null) throw new Error('Agent item transaction did not produce a row.')
    return mapItem(row)
  }

  async transitionItem(itemId: string, status: AgentItemStatus, payload?: unknown): Promise<AgentItem> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const item = this.#connection.sqlite.prepare('SELECT * FROM agent_items WHERE id = ?').get(itemId) as AgentItemRow | undefined
      if (item === undefined) throw new AgentHarnessRepositoryError('ITEM_NOT_FOUND', `Agent item ${itemId} does not exist.`)
      const thread = this.#requireThreadRow(item.thread_id)
      const nextPayload = payload === undefined ? item.payload_json : JSON.stringify(payload)
      this.#connection.sqlite.prepare('UPDATE agent_items SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?')
        .run(status, nextPayload, now, itemId)
      this.#appendEvent(thread, { turnId: item.turn_id, itemId, type: `item.${status}`, payload: { itemType: item.type } }, now)
    })
    transaction()
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_items WHERE id = ?').get(itemId) as AgentItemRow
    return mapItem(row)
  }

  async listItems(threadId: string): Promise<readonly AgentItem[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_items WHERE thread_id = ? ORDER BY created_at, turn_id, ordinal, id
    `).all(threadId) as AgentItemRow[]
    return rows.map(mapItem)
  }

  async listTurnItems(turnId: string): Promise<readonly AgentItem[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_items WHERE turn_id = ? ORDER BY ordinal, id
    `).all(turnId) as AgentItemRow[]
    return rows.map(mapItem)
  }

  async applyGenerationObservation(subscription: GenerationSubscription, job: GenerationJob): Promise<boolean> {
    if (!isTerminalGenerationJobStatus(job.status)) return false
    const now = this.#now()
    return this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(subscription.turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      if (thread.project_id !== job.projectId || subscription.projectId !== job.projectId
        || subscription.threadId !== thread.id || subscription.jobId !== job.id) throw new Error('Generation observation scope mismatch.')
      if (isTerminalAgentTurnStatus(mapTurn(turn).status)) return false
      const item = this.#connection.sqlite.prepare(`
        SELECT * FROM agent_items WHERE turn_id = ? AND type = 'generation_subscription'
          AND json_extract(payload_json, '$.jobId') = ? ORDER BY ordinal DESC LIMIT 1
      `).get(turn.id, job.id) as AgentItemRow | undefined
      // The producer has not yet persisted its waiting item. It re-reads the
      // Job after installing the wait, so this race cannot consume a wakeup.
      if (item === undefined) return false
      const latestWait = this.#connection.sqlite.prepare(`
        SELECT id FROM agent_items WHERE turn_id = ? AND type = 'generation_subscription'
        ORDER BY ordinal DESC LIMIT 1
      `).get(turn.id) as { id: string } | undefined
      if (latestWait?.id !== item.id) return false
      const anotherWait = this.#connection.sqlite.prepare(`
        SELECT id FROM agent_items WHERE turn_id = ? AND type = 'generation_subscription'
          AND status = 'waiting' AND id <> ? LIMIT 1
      `).get(turn.id, item.id)
      // An old Job's duplicate terminal must not wake a Turn waiting for its
      // next Job. Only the current unresolved wait can advance the loop.
      if (item.status === 'completed' && anotherWait !== undefined) return false
      const observed = this.#connection.sqlite.prepare(`
        SELECT id FROM agent_events WHERE turn_id = ? AND type = 'job.observed'
          AND json_extract(payload_json, '$.jobId') = ? LIMIT 1
      `).get(turn.id, job.id)
      // A failed Job keeps the durable wait until failure finalization succeeds.
      // If that later transaction fails, the observed subscription is still a
      // replayable source for finalization, both live and after restart.
      const wake = turn.status === 'waiting_job' && anotherWait === undefined && job.status === 'completed'
      const changed = item.status !== 'completed' || wake || observed === undefined
      if (!changed) return anotherWait === undefined && (turn.status === 'waiting_job' || turn.status === 'building_context')
      const stored = JSON.parse(item.payload_json) as Record<string, unknown>
      const nextPayload = { ...stored, subscriptionId: subscription.id, intentId: subscription.intentId,
        jobId: job.id, lastJobStatus: job.status, observedAt: subscription.observedAt ?? now }
      this.#connection.sqlite.prepare(`UPDATE agent_items SET status = 'completed', payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(nextPayload), now, item.id)
      this.#connection.sqlite.prepare(`UPDATE generation_subscriptions SET status = 'observed', last_job_status = ?,
        observed_at = COALESCE(observed_at, ?), updated_at = ? WHERE id = ?`)
        .run(job.status, now, now, subscription.id)
      if (wake) {
        this.#connection.sqlite.prepare(`UPDATE agent_turns_v2 SET status = 'building_context', error_code = NULL,
          error_message = NULL, updated_at = ? WHERE id = ?`).run(now, turn.id)
        this.#appendEvent(thread, { turnId: turn.id, itemId: null, type: 'turn.status', payload: { status: 'building_context' } }, now)
      }
      if (observed === undefined) this.#appendEvent(thread, { turnId: turn.id, itemId: item.id, type: 'job.observed',
        payload: { jobId: job.id, status: job.status, resultCount: job.results.length, subscriptionId: subscription.id } }, now)
      return anotherWait === undefined
    })()
  }

  async cancelPendingItems(turnId: string, reason: string): Promise<number> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const turn = this.#requireTurnRow(turnId)
      const thread = this.#requireThreadRow(turn.thread_id)
      const rows = this.#connection.sqlite.prepare(`
        SELECT * FROM agent_items WHERE turn_id = ? AND status IN ('queued', 'started', 'waiting')
          AND type NOT IN ('user_message', 'tool_result', 'scene_change', 'completion_assessment')
      `).all(turnId) as AgentItemRow[]
      for (const row of rows) {
        this.#connection.sqlite.prepare(`UPDATE agent_items SET status = 'interrupted', updated_at = ? WHERE id = ?`).run(now, row.id)
        this.#appendEvent(thread, {
          turnId,
          itemId: row.id,
          type: 'item.interrupted',
          payload: { itemType: row.type, reason }
        }, now)
      }
      return rows.length
    })
    return transaction()
  }

  async enqueue(threadId: string, input: {
    readonly messageId: string
    readonly mode: TurnInputMode
    readonly taskId?: string
    readonly taskRelation?: TaskRelation
    readonly dispatchMode?: DispatchMode
    readonly baseTaskId?: string | null
  }): Promise<AgentQueueEntry> {
    const mode = turnInputModeSchema.parse(input.mode)
    const taskRelation = taskRelationSchema.parse(input.taskRelation ?? (mode === 'append_current' ? 'supplement_current' : mode === 'correct_current' ? 'revise_current' : 'continue_current'))
    const dispatchMode = dispatchModeSchema.parse(input.dispatchMode ?? 'queue_after_current')
    const now = this.#now()
    let row: AgentQueueEntryRow | null = null
    const transaction = this.#connection.sqlite.transaction(() => {
      const thread = this.#requireThreadRow(threadId)
      const position = (this.#connection.sqlite.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_queue_entries WHERE thread_id = ?')
        .get(threadId) as { position: number }).position
      const id = this.#idFactory()
      row = {
        id, thread_id: threadId, message_id: input.messageId, mode, position,
        task_id: input.taskId ?? id, task_relation: taskRelation, dispatch_mode: dispatchMode, base_task_id: input.baseTaskId ?? null,
        status: 'queued', created_at: now, updated_at: now
      }
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_queue_entries(
          id, thread_id, message_id, mode, task_id, task_relation, dispatch_mode, base_task_id,
          position, status, created_at, updated_at
        ) VALUES (
          @id, @thread_id, @message_id, @mode, @task_id, @task_relation, @dispatch_mode, @base_task_id,
          @position, @status, @created_at, @updated_at
        )
      `).run(row)
      this.#appendEvent(thread, {
        turnId: thread.active_turn_id,
        itemId: null,
        type: 'queue.queued',
        payload: {
          queueEntryId: row.id,
          messageId: row.message_id,
          mode,
          taskId: row.task_id,
          taskRelation,
          dispatchMode,
          position
        }
      }, now)
    })
    transaction()
    if (row === null) throw new Error('Agent queue transaction did not produce a row.')
    return mapQueue(row)
  }

  async listQueue(threadId: string): Promise<readonly AgentQueueEntry[]> {
    const rows = this.#connection.sqlite.prepare('SELECT * FROM agent_queue_entries WHERE thread_id = ? ORDER BY position, id')
      .all(threadId) as AgentQueueEntryRow[]
    return rows.map(mapQueue)
  }

  async resumeQueue(threadId: string): Promise<number> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const thread = this.#requireThreadRow(threadId)
      const result = this.#connection.sqlite.prepare("UPDATE agent_queue_entries SET status = 'queued', updated_at = ? WHERE thread_id = ? AND status = 'paused'")
        .run(now, threadId)
      if (result.changes > 0) {
        this.#appendEvent(thread, { turnId: null, itemId: null, type: 'queue.resumed', payload: { count: result.changes } }, now)
      }
      return result.changes
    })
    return transaction()
  }

  async claimNextQueueEntry(threadId: string): Promise<AgentQueueEntry | null> {
    const now = this.#now()
    let claimed: AgentQueueEntryRow | null = null
    const transaction = this.#connection.sqlite.transaction(() => {
      const thread = this.#requireThreadRow(threadId)
      if (thread.active_turn_id !== null) return
      const row = this.#connection.sqlite.prepare(`
        SELECT * FROM agent_queue_entries WHERE thread_id = ? AND status = 'queued'
        ORDER BY position, id LIMIT 1
      `).get(threadId) as AgentQueueEntryRow | undefined
      if (row === undefined) return
      this.#connection.sqlite.prepare("UPDATE agent_queue_entries SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, row.id)
      claimed = { ...row, status: 'claimed', updated_at: now }
      this.#appendEvent(thread, {
        turnId: null,
        itemId: null,
        type: 'queue.claimed',
        payload: { queueEntryId: row.id, messageId: row.message_id, position: row.position }
      }, now)
    })
    transaction()
    return claimed === null ? null : mapQueue(claimed)
  }

  async completeQueueEntry(entryId: string): Promise<AgentQueueEntry> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const row = this.#connection.sqlite.prepare('SELECT * FROM agent_queue_entries WHERE id = ?')
        .get(entryId) as AgentQueueEntryRow | undefined
      if (row === undefined) throw new Error(`Agent queue entry ${entryId} does not exist.`)
      const thread = this.#requireThreadRow(row.thread_id)
      this.#connection.sqlite.prepare("UPDATE agent_queue_entries SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, entryId)
      this.#appendEvent(thread, {
        turnId: null,
        itemId: null,
        type: 'queue.completed',
        payload: { queueEntryId: entryId, messageId: row.message_id }
      }, now)
    })
    transaction()
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_queue_entries WHERE id = ?').get(entryId) as AgentQueueEntryRow
    return mapQueue(row)
  }

  async appendEvent(
    threadId: string,
    input: { readonly turnId: string | null; readonly itemId: string | null; readonly type: string; readonly payload: unknown }
  ): Promise<AgentEvent> {
    const now = this.#now()
    let sequence = 0
    const transaction = this.#connection.sqlite.transaction(() => {
      const thread = this.#requireThreadRow(threadId)
      this.#appendEvent(thread, input, now)
      sequence = this.#requireThreadRow(threadId).last_sequence
    })
    transaction()
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_events WHERE thread_id = ? AND sequence = ?')
      .get(threadId, sequence) as AgentEventRow
    return mapEvent(row)
  }

  async replayEvents(threadId: string, afterSequence: number, limit = 1_000): Promise<readonly AgentEvent[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_events WHERE thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(threadId, Math.max(0, afterSequence), Math.max(1, Math.min(10_000, limit))) as AgentEventRow[]
    return rows.map(mapEvent)
  }

  async getSnapshot(threadId: string): Promise<AgentHarnessSnapshot> {
    const thread = await this.getThread(threadId)
    const [turns, items, queue] = await Promise.all([
      this.listTurns(threadId),
      this.listItems(threadId),
      this.listQueue(threadId)
    ])
    const activeGoal = thread.activeGoalId === null ? null : await this.getGoal(thread.activeGoalId)
    return agentHarnessSnapshotSchema.parse({ thread, activeGoal, turns, items, queue, lastSequence: thread.lastSequence })
  }

  async recoverInterrupted(projectId: string): Promise<number> {
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      const rows = this.#connection.sqlite.prepare(`
        SELECT turns.* FROM agent_turns_v2 turns
        JOIN agent_threads threads ON threads.id = turns.thread_id
        WHERE threads.project_id = ? AND turns.status IN ('queued', 'building_context', 'planning', 'running')
      `).all(projectId) as AgentTurnV2Row[]
      for (const turn of rows) {
        const thread = this.#requireThreadRow(turn.thread_id)
        this.#connection.sqlite.prepare(`
          UPDATE agent_turns_v2 SET status = 'interrupted', error_code = 'APP_INTERRUPTED',
            error_message = 'The app stopped before this agent turn finished.', updated_at = ?, completed_at = ? WHERE id = ?
        `).run(now, now, turn.id)
        this.#connection.sqlite.prepare('UPDATE agent_threads SET active_turn_id = NULL, updated_at = ? WHERE id = ?')
          .run(now, thread.id)
        this.#connection.sqlite.prepare("UPDATE agent_queue_entries SET status = 'paused', updated_at = ? WHERE thread_id = ? AND status = 'queued'")
          .run(now, thread.id)
        this.#appendEvent(thread, { turnId: turn.id, itemId: null, type: 'turn.interrupted', payload: { code: 'APP_INTERRUPTED' } }, now)
      }
      return rows.length
    })
    return transaction()
  }

  async close(): Promise<void> {
    // This repository intentionally uses the synchronous SQLite transaction
    // surface. Kysely is never initialized here, so destroying its lazy driver
    // can wait for an acquisition that never happened. Close the owned native
    // connection directly instead.
    this.#connection.sqlite.close()
  }

  #requireThreadRow(threadId: string): AgentThreadRow {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_threads WHERE id = ?').get(threadId) as AgentThreadRow | undefined
    if (row === undefined) throw new AgentHarnessRepositoryError('THREAD_NOT_FOUND', `Agent thread ${threadId} does not exist.`)
    return row
  }

  #mapTurn(row: AgentTurnV2Row): AgentTurn {
    const goal = row.goal_id === null ? undefined : this.#connection.sqlite.prepare('SELECT budget_json FROM agent_goals WHERE id = ?').get(row.goal_id) as { budget_json: string } | undefined
    let limit: number | null = null
    if (goal !== undefined) {
      try { limit = agentRunBudgetSchema.parse(JSON.parse(goal.budget_json)).maxWallTimeMs } catch { /* Legacy uncertainty is explicit in readback. */ }
    }
    return mapTurn(row, limit)
  }

  #requireTurnRow(turnId: string): AgentTurnV2Row {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_turns_v2 WHERE id = ?').get(turnId) as AgentTurnV2Row | undefined
    if (row === undefined) throw new AgentHarnessRepositoryError('TURN_NOT_FOUND', `Agent turn ${turnId} does not exist.`)
    return row
  }

  #appendEvent(
    thread: AgentThreadRow,
    input: { readonly turnId: string | null; readonly itemId: string | null; readonly type: string; readonly payload: unknown },
    now: string
  ): void {
    const current = this.#requireThreadRow(thread.id)
    const sequence = current.last_sequence + 1
    const row: AgentEventRow = {
      id: this.#idFactory(), project_id: current.project_id, thread_id: current.id,
      turn_id: input.turnId, item_id: input.itemId, sequence, type: input.type, payload_version: 1,
      payload_json: JSON.stringify(input.payload ?? null), created_at: now
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_events(id, project_id, thread_id, turn_id, item_id, sequence, type, payload_version, payload_json, created_at)
      VALUES (@id, @project_id, @thread_id, @turn_id, @item_id, @sequence, @type, @payload_version, @payload_json, @created_at)
    `).run(row)
    this.#connection.sqlite.prepare('UPDATE agent_threads SET last_sequence = ?, updated_at = ? WHERE id = ?')
      .run(sequence, now, current.id)
  }
}
