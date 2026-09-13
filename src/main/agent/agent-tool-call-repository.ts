import { randomUUID } from 'node:crypto'
import type { AgentToolOutcome } from '../../shared/agent'
import type {
  AgentPermissionProfile,
  AgentToolApprovalRecord,
  AgentToolDefinitionSnapshot,
  SceneApplyBatchToolInput
} from '../../shared/agent-tools'
import { openDatabase, type AgentToolCallV2Row, type AgentToolCallV2Status, type DatabaseConnection } from '../storage/database'

export interface StoredToolPreview {
  readonly publicPreview: unknown
  readonly batchInput: unknown
  readonly resultSceneDigest: string
  readonly patches: unknown
  readonly inversePatches: unknown
}
export interface AgentToolCallRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string | null
  readonly turnId: string | null
  readonly legacyRunId: string | null
  readonly ordinal: number
  readonly toolName: string
  readonly definitionVersion: number
  readonly risk: AgentToolDefinitionSnapshot['risk']
  readonly status: AgentToolCallV2Status
  readonly idempotencyKey: string
  readonly expectedSceneRevision: number | null
  readonly scope: SceneApplyBatchToolInput['scope']
  readonly arguments: unknown
  readonly permission: AgentPermissionProfile
  readonly approval: AgentToolApprovalRecord
  readonly preview: StoredToolPreview | null
  readonly executionTokenHash: string | null
  readonly rendererSessionHash: string | null
  readonly tokenExpiresAt: string | null
  readonly operationBatchId: string | null
  readonly sceneRevisionAfter: number | null
  readonly result: AgentToolOutcome | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly recoverable: boolean
  readonly createdAt: string
  readonly preparedAt: string | null
  readonly committedAt: string | null
  readonly completedAt: string | null
  readonly updatedAt: string
}

interface CreatePreparedInput {
  readonly projectId: string
  readonly threadId?: string | null
  readonly turnId?: string | null
  readonly legacyRunId: string
  readonly ordinal: number
  readonly definition: AgentToolDefinitionSnapshot
  readonly idempotencyKey: string
  readonly expectedSceneRevision: number
  readonly scope: SceneApplyBatchToolInput['scope']
  readonly arguments: unknown
  readonly permission: AgentPermissionProfile
  readonly approval: AgentToolApprovalRecord
  readonly preview: StoredToolPreview
  readonly executionTokenHash: string
  readonly rendererSessionHash: string
  readonly tokenExpiresAt: string
  readonly operationBatchId: string
  readonly sceneRevisionAfter: number
}

export interface AgentToolCallRecoveryResult {
  readonly completed: number
  readonly expired: number
  readonly failed: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function mapRecord(row: AgentToolCallV2Row): AgentToolCallRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    legacyRunId: row.legacy_run_id,
    ordinal: row.ordinal,
    toolName: row.tool_name,
    definitionVersion: row.definition_version,
    risk: row.risk,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    expectedSceneRevision: row.expected_scene_revision,
    scope: parseJson(row.scope_json),
    arguments: parseJson(row.arguments_json),
    permission: parseJson(row.permission_json),
    approval: parseJson(row.approval_json),
    preview: row.preview_json === null ? null : parseJson(row.preview_json),
    executionTokenHash: row.execution_token_hash,
    rendererSessionHash: row.renderer_session_hash,
    tokenExpiresAt: row.token_expires_at,
    operationBatchId: row.operation_batch_id,
    sceneRevisionAfter: row.scene_revision_after,
    result: row.result_json === null ? null : parseJson(row.result_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    recoverable: row.recoverable === 1,
    createdAt: row.created_at,
    preparedAt: row.prepared_at,
    committedAt: row.committed_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  }
}

export class AgentToolCallRepository {
  readonly #connection: DatabaseConnection
  readonly #now: () => string
  readonly #idFactory: () => string

  constructor(databasePath: string, options: { readonly now?: () => string; readonly idFactory?: () => string } = {}) {
    this.#connection = openDatabase(databasePath)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  get migrationResult(): DatabaseConnection['migration'] {
    return this.#connection.migration
  }

  async findByIdempotency(projectId: string, idempotencyKey: string): Promise<AgentToolCallRecord | null> {
    const row = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_tool_calls_v2 WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey) as AgentToolCallV2Row | undefined
    return row === undefined ? null : mapRecord(row)
  }

  async findByTokenHash(tokenHash: string): Promise<AgentToolCallRecord | null> {
    const row = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_tool_calls_v2 WHERE execution_token_hash = ?
    `).get(tokenHash) as AgentToolCallV2Row | undefined
    return row === undefined ? null : mapRecord(row)
  }

  async get(callId: string): Promise<AgentToolCallRecord> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_tool_calls_v2 WHERE id = ?')
      .get(callId) as AgentToolCallV2Row | undefined
    if (row === undefined) throw new Error(`Agent tool call ${callId} does not exist.`)
    return mapRecord(row)
  }

  async createPrepared(input: CreatePreparedInput): Promise<AgentToolCallRecord> {
    const now = this.#now()
    const row: AgentToolCallV2Row = {
      id: this.#idFactory(), project_id: input.projectId, thread_id: input.threadId ?? null, turn_id: input.turnId ?? null,
      legacy_run_id: input.legacyRunId, ordinal: input.ordinal, tool_name: input.definition.name,
      definition_version: input.definition.version, risk: input.definition.risk, status: 'prepared',
      idempotency_key: input.idempotencyKey, expected_scene_revision: input.expectedSceneRevision,
      scope_json: JSON.stringify(input.scope), arguments_json: JSON.stringify(input.arguments),
      permission_json: JSON.stringify(input.permission), approval_json: JSON.stringify(input.approval),
      preview_json: JSON.stringify(input.preview), execution_token_hash: input.executionTokenHash,
      renderer_session_hash: input.rendererSessionHash, token_expires_at: input.tokenExpiresAt,
      operation_batch_id: input.operationBatchId, scene_revision_after: input.sceneRevisionAfter,
      result_json: null, error_code: null, error_message: null, recoverable: 1,
      created_at: now, prepared_at: now, committed_at: null, completed_at: null, updated_at: now
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_tool_calls_v2(
        id, project_id, thread_id, turn_id, legacy_run_id, ordinal, tool_name, definition_version, risk, status,
        idempotency_key, expected_scene_revision, scope_json, arguments_json, permission_json, approval_json,
        preview_json, execution_token_hash, renderer_session_hash, token_expires_at, operation_batch_id,
        scene_revision_after, result_json, error_code, error_message, recoverable, created_at, prepared_at,
        committed_at, completed_at, updated_at
      ) VALUES (
        @id, @project_id, @thread_id, @turn_id, @legacy_run_id, @ordinal, @tool_name, @definition_version, @risk, @status,
        @idempotency_key, @expected_scene_revision, @scope_json, @arguments_json, @permission_json, @approval_json,
        @preview_json, @execution_token_hash, @renderer_session_hash, @token_expires_at, @operation_batch_id,
        @scene_revision_after, @result_json, @error_code, @error_message, @recoverable, @created_at, @prepared_at,
        @committed_at, @completed_at, @updated_at
      )
    `).run(row)
    return mapRecord(row)
  }

  async refreshPreparedToken(
    callId: string,
    executionTokenHash: string,
    rendererSessionHash: string,
    tokenExpiresAt: string
  ): Promise<AgentToolCallRecord> {
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      UPDATE agent_tool_calls_v2 SET status = 'prepared', execution_token_hash = ?, renderer_session_hash = ?,
        token_expires_at = ?, error_code = NULL, error_message = NULL, recoverable = 1,
        prepared_at = ?, updated_at = ? WHERE id = ?
    `).run(executionTokenHash, rendererSessionHash, tokenExpiresAt, now, now, callId)
    return this.get(callId)
  }

  async markCommitting(callId: string, result: AgentToolOutcome): Promise<AgentToolCallRecord> {
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      UPDATE agent_tool_calls_v2 SET status = 'committing', result_json = ?, execution_token_hash = NULL,
        renderer_session_hash = NULL, token_expires_at = NULL, committed_at = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(result), now, now, callId)
    return this.get(callId)
  }

  async markCompleted(callId: string): Promise<AgentToolCallRecord> {
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      UPDATE agent_tool_calls_v2 SET status = 'completed', recoverable = 0, error_code = NULL,
        error_message = NULL, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, callId)
    return this.get(callId)
  }

  async markFailed(callId: string, code: string, message: string, recoverable: boolean): Promise<AgentToolCallRecord> {
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      UPDATE agent_tool_calls_v2 SET status = 'failed', execution_token_hash = NULL, renderer_session_hash = NULL,
        token_expires_at = NULL, error_code = ?, error_message = ?, recoverable = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(code, message, recoverable ? 1 : 0, now, now, callId)
    return this.get(callId)
  }

  async hasOperationBatch(batchId: string): Promise<boolean> {
    const row = this.#connection.sqlite.prepare('SELECT 1 AS present FROM operation_batches WHERE id = ?')
      .get(batchId) as { present: 1 } | undefined
    return row !== undefined
  }

  async recoverInterrupted(projectId: string): Promise<AgentToolCallRecoveryResult> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_tool_calls_v2 WHERE project_id = ? AND status IN ('prepared', 'committing')
    `).all(projectId) as AgentToolCallV2Row[]
    let completed = 0
    let expired = 0
    let failed = 0
    const now = this.#now()
    const transaction = this.#connection.sqlite.transaction(() => {
      for (const row of rows) {
        if (row.status === 'committing' && row.operation_batch_id !== null) {
          const batch = this.#connection.sqlite.prepare('SELECT 1 AS present FROM operation_batches WHERE id = ?')
            .get(row.operation_batch_id) as { present: 1 } | undefined
          if (batch !== undefined && row.result_json !== null) {
            this.#connection.sqlite.prepare(`
              UPDATE agent_tool_calls_v2 SET status = 'completed', recoverable = 0, completed_at = ?, updated_at = ? WHERE id = ?
            `).run(now, now, row.id)
            completed += 1
            continue
          }
          this.#connection.sqlite.prepare(`
            UPDATE agent_tool_calls_v2 SET status = 'failed', error_code = 'APP_INTERRUPTED_BEFORE_SCENE_COMMIT',
              error_message = 'The app stopped before the prepared scene batch was committed.', recoverable = 1,
              execution_token_hash = NULL, renderer_session_hash = NULL, token_expires_at = NULL,
              completed_at = ?, updated_at = ? WHERE id = ?
          `).run(now, now, row.id)
          failed += 1
          continue
        }
        this.#connection.sqlite.prepare(`
          UPDATE agent_tool_calls_v2 SET status = 'expired', error_code = 'EXECUTION_TOKEN_INVALIDATED',
            error_message = 'The renderer session ended before the prepared batch was committed.', recoverable = 1,
            execution_token_hash = NULL, renderer_session_hash = NULL, token_expires_at = NULL,
            completed_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, row.id)
        expired += 1
      }
    })
    transaction()
    return { completed, expired, failed }
  }

  async close(): Promise<void> {
    this.#connection.sqlite.close()
  }
}
