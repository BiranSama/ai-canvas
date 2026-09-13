import { agentRunBudgetSchema, isTerminalAgentTurnStatus, type AgentRunBudget, type AgentTurnStatus } from '../../shared/agent-harness'
import type { DatabaseConnection } from '../storage/database'

export interface GenerationTurnScope {
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly toolCallItemId?: string
}

export interface TurnGenerationUsage {
  readonly jobs: number
  readonly images: number
  readonly reservedCostCny: number
}

export class TurnGenerationBudgetError extends Error {
  constructor(readonly code: 'BUDGET_GENERATION_JOBS' | 'BUDGET_GENERATED_IMAGES' | 'BUDGET_GENERATION_COST' | 'TURN_BUDGET_UNVERIFIED', message: string) {
    super(message)
  }
}

function authority(connection: DatabaseConnection, scope: GenerationTurnScope) {
  const row = connection.sqlite.prepare(`SELECT t.status, t.thread_id, h.project_id, g.budget_json, g.mode
    FROM agent_turns_v2 t JOIN agent_threads h ON h.id = t.thread_id
    LEFT JOIN agent_goals g ON g.id = t.goal_id WHERE t.id = ?`).get(scope.turnId) as {
      status: AgentTurnStatus; thread_id: string; project_id: string; budget_json: string | null; mode: string | null
    } | undefined
  const call = scope.toolCallItemId === undefined ? true : connection.sqlite.prepare(`SELECT 1 FROM agent_items
    WHERE id = ? AND turn_id = ? AND thread_id = ? AND type = 'tool_call' AND status = 'started'`)
    .get(scope.toolCallItemId, scope.turnId, scope.threadId)
  if (row === undefined || row.project_id !== scope.projectId || row.thread_id !== scope.threadId
    || isTerminalAgentTurnStatus(row.status) || !call) {
    throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '本轮生成权限无法核对，已停止创建新的图片任务。')
  }
  return row
}

export function readTurnGenerationBudget(connection: DatabaseConnection, turnId: string): AgentRunBudget | null {
  const row = connection.sqlite.prepare('SELECT limits_json FROM agent_generation_limits WHERE turn_id = ?').get(turnId) as { limits_json: string } | undefined
  return row === undefined ? null : agentRunBudgetSchema.parse(JSON.parse(row.limits_json))
}

export function readTurnGenerationUsage(connection: DatabaseConnection, turnId: string): TurnGenerationUsage {
  // A reservation is a unique creation, including failed, cancelled and unknown
  // requests. Returned image count is an outcome, not a refund of permission.
  return connection.sqlite.prepare(`SELECT COUNT(*) AS jobs,
    COALESCE(SUM(json_extract(i.compiled_request_json, '$.request.count')), 0) AS images,
    COALESCE(SUM(MAX(r.cost_limit_cny, r.actual_cost_cny, CASE
      WHEN json_extract(j.cost_json, '$.actual.status') = 'actual_known' AND json_extract(j.cost_json, '$.actual.currency') = 'CNY'
      THEN json_extract(j.cost_json, '$.actual.amount') ELSE 0 END)), 0) AS reservedCostCny
    FROM generation_workflow_intents i JOIN agent_budget_reservations r ON r.intent_id = i.id
    LEFT JOIN generation_jobs j ON j.id = i.job_id
    WHERE i.turn_id = ?`).get(turnId) as TurnGenerationUsage
}

export function captureTurnGenerationBudget(connection: DatabaseConnection, scope: GenerationTurnScope,
  proposed: AgentRunBudget, grantItemId: string | null, now: string): AgentRunBudget {
  return connection.sqlite.transaction(() => {
    const owner = authority(connection, scope)
    const existing = readTurnGenerationBudget(connection, scope.turnId)
    if (existing !== null) return existing
    const oldGeneration = connection.sqlite.prepare(`SELECT 1 FROM agent_items WHERE turn_id = ? AND
      (type = 'generation_subscription' OR (type = 'tool_result' AND json_extract(payload_json, '$.outcome.jobId') IS NOT NULL)) LIMIT 1`)
      .get(scope.turnId)
    if (oldGeneration || readTurnGenerationUsage(connection, scope.turnId).jobs > 0) {
      throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '旧任务缺少可核对的累计预算，已暂停后续生成。现有作品仍可查看和编辑。')
    }
    const baseline = owner.budget_json === null ? proposed : agentRunBudgetSchema.parse(JSON.parse(owner.budget_json))
    const budget = agentRunBudgetSchema.parse(owner.mode === 'auto' ? baseline : {
      ...baseline,
      maxGenerationJobs: Math.max(baseline.maxGenerationJobs, proposed.maxGenerationJobs),
      maxGeneratedImages: Math.max(baseline.maxGeneratedImages, proposed.maxGeneratedImages)
    })
    if (grantItemId !== null && !connection.sqlite.prepare('SELECT 1 FROM agent_items WHERE id = ? AND turn_id = ?')
      .get(grantItemId, scope.turnId)) throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '生成授权记录不属于当前任务。')
    connection.sqlite.prepare(`INSERT INTO agent_generation_limits(turn_id, project_id, thread_id, limits_json, grant_item_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(scope.turnId, scope.projectId, scope.threadId, JSON.stringify(budget), grantItemId, now)
    return budget
  }).immediate()
}

/** Called inside the same immediate transaction that inserts the reservation. */
export function assertTurnGenerationReservation(connection: DatabaseConnection, scope: GenerationTurnScope, imageCount: number, costCny: number): void {
  authority(connection, scope)
  const budget = readTurnGenerationBudget(connection, scope.turnId)
  if (budget === null) throw new TurnGenerationBudgetError('TURN_BUDGET_UNVERIFIED', '生成任务缺少持久预算授权，未创建或提交请求。')
  const usage = readTurnGenerationUsage(connection, scope.turnId)
  if (usage.jobs + 1 > budget.maxGenerationJobs) throw new TurnGenerationBudgetError('BUDGET_GENERATION_JOBS', '本轮生成任务额度已用完，已保留已有结果。')
  if (usage.images + imageCount > budget.maxGeneratedImages) throw new TurnGenerationBudgetError('BUDGET_GENERATED_IMAGES', '本轮图片数量额度不足，未创建新的任务。')
  if (usage.reservedCostCny + costCny > budget.maxCostCny) throw new TurnGenerationBudgetError('BUDGET_GENERATION_COST', '本轮费用预约额度不足，未创建新的任务。')
}
