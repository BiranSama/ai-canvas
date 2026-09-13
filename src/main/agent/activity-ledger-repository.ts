import { executeSynchronous } from '../storage/database'
import { randomUUID } from 'node:crypto'
import type { AgentPlan, AgentToolOutcome, AgentActivity, AgentActivityKind, AgentActivityState, AgentDecision, AgentDecisionOption, ActivityBudgetImpact } from '../../shared/agent'
import type { GenerationJob } from '../../shared/generation'
import { redactSensitive } from '../security/redacted-logger'
import { openDatabase, type AgentActivityEventRow, type AgentActivityRow, type AgentDecisionRow, type DatabaseConnection } from '../storage/database'

export interface CreateActivityInput {
  readonly projectId: string
  readonly runId?: string | null
  readonly ordinal?: number | null
  readonly kind: AgentActivityKind
  readonly eventType: string
  readonly label: string
  readonly state: AgentActivityState
  readonly progress?: number | null
  readonly objectLabel: string
  readonly actionLabel: string
  readonly impactLabel: string
  readonly scopeLabel?: string | null
  readonly affectedIds?: readonly string[]
  readonly operationBatchId?: string | null
  readonly jobId?: string | null
  readonly budgetImpact?: ActivityBudgetImpact | null
  readonly recoverable?: boolean
}

export interface CreateDecisionInput {
  readonly projectId: string
  readonly runId: string
  readonly activityId: string
  readonly kind: AgentDecision['kind']
  readonly title: string
  readonly consequence: string
  readonly options: readonly AgentDecisionOption[]
  readonly defaultOptionId: string
}

function safeCopy(value: string, fallback: string): string {
  const redacted = redactSensitive(value).replace(/[\r\n\t]+/g, ' ').trim()
  return (redacted || fallback).slice(0, 500)
}

function mapDecision(row: AgentDecisionRow): AgentDecision {
  return {
    id: row.id,
    runId: row.run_id,
    activityId: row.activity_id,
    kind: row.kind,
    title: row.title,
    consequence: row.consequence,
    options: JSON.parse(row.options_json) as AgentDecisionOption[],
    defaultOptionId: row.default_option_id,
    status: row.status,
    selectedOptionId: row.selected_option_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

function mapActivity(
  row: AgentActivityRow,
  events: readonly AgentActivityEventRow[],
  decision: AgentDecisionRow | undefined
): AgentActivity {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    kind: row.kind,
    eventType: row.event_type,
    label: row.label,
    state: row.state,
    progress: row.progress,
    objectLabel: row.object_label,
    actionLabel: row.action_label,
    impactLabel: row.impact_label,
    scopeLabel: row.scope_label,
    affectedIds: JSON.parse(row.affected_ids_json) as string[],
    operationBatchId: row.operation_batch_id,
    jobId: row.job_id,
    budgetImpact: row.budget_impact_json === null ? null : JSON.parse(row.budget_impact_json) as ActivityBudgetImpact,
    recoverable: row.recoverable === 1,
    undoneAt: row.undone_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      state: event.state,
      summary: event.summary,
      createdAt: event.created_at
    })),
    decision: decision === undefined ? null : mapDecision(decision)
  }
}

type AtomicActivityTool = Extract<AgentPlan['tools'][number], {
  kind: 'scene.set_canvas' | 'scene.create_elements' | 'scene.update_elements' | 'scene.reorder_elements' | 'scene.group_elements' | 'scene.remove_elements'
}>

function isAtomicActivityTool(tool: AgentPlan['tools'][number]): tool is AtomicActivityTool {
  return tool.kind === 'scene.set_canvas'
    || tool.kind === 'scene.create_elements'
    || tool.kind === 'scene.update_elements'
    || tool.kind === 'scene.reorder_elements'
    || tool.kind === 'scene.group_elements'
    || tool.kind === 'scene.remove_elements'
}

function toolProjection(tool: AgentPlan['tools'][number]): Pick<CreateActivityInput, 'kind' | 'label' | 'objectLabel' | 'actionLabel' | 'impactLabel' | 'scopeLabel' | 'budgetImpact'> {
  if (tool.kind === 'scene_batch') {
    return {
      kind: 'tool',
      label: '更新画布结构',
      objectLabel: '语义画布',
      actionLabel: tool.summary,
      impactLabel: '等待 CommandBus 原子执行',
      scopeLabel: `${tool.commands.length} 项画布命令`,
      budgetImpact: null
    }
  }
  if (tool.kind === 'canvas_edit') {
    return {
      kind: 'tool',
      label: '创建局部修改',
      objectLabel: '选中图片',
      actionLabel: '编译本轮圈选并创建编辑任务',
      impactLabel: '源图保持不变，结果另存为新版本',
      scopeLabel: '当前选区',
      budgetImpact: { requests: 1, images: tool.count, maxCny: 0 }
    }
  }
  if (tool.kind === 'cancel_generation') {
    return {
      kind: 'tool',
      label: '停止生成任务',
      objectLabel: '生成队列',
      actionLabel: '请求取消任务',
      impactLabel: '已完成的结果会保留',
      scopeLabel: '当前任务',
      budgetImpact: null
    }
  }
  if (tool.kind === 'memory_candidate') {
    return {
      kind: 'tool',
      label: '提出记忆候选',
      objectLabel: '项目记忆',
      actionLabel: tool.content,
      impactLabel: '等待用户确认后才进入长期上下文',
      scopeLabel: tool.memoryKind,
      budgetImpact: null
    }
  }
  if (tool.kind === 'directive_create') {
    return {
      kind: 'tool',
      label: '写入项目规则',
      objectLabel: '项目规则',
      actionLabel: tool.text,
      impactLabel: '后续 Agent 轮次会采用这条已确认规则',
      scopeLabel: tool.category,
      budgetImpact: null
    }
  }
  if (tool.kind === 'place_generation_result' || tool.kind === 'result.place_on_canvas') {
    return {
      kind: 'tool',
      label: '将结果放入画布',
      objectLabel: '生成结果',
      actionLabel: '创建可编辑图片层',
      impactLabel: '保留原结果并形成可撤销画布批次',
      scopeLabel: tool.resultId,
      budgetImpact: null
    }
  }
  if (tool.kind === 'scene.get_summary' || tool.kind === 'scene.get_elements') {
    return {
      kind: 'tool',
      label: '读取画布信息',
      objectLabel: '语义画布',
      actionLabel: tool.kind === 'scene.get_summary' ? '读取场景摘要' : '读取元素详情',
      impactLabel: '只读操作，不修改作品',
      scopeLabel: tool.kind === 'scene.get_elements' && tool.elementIds.length > 0 ? `${tool.elementIds.length} 个元素` : '当前场景',
      budgetImpact: null
    }
  }
  if (isAtomicActivityTool(tool) || tool.kind === 'history.undo_batch') {
    return {
      kind: 'tool',
      label: tool.kind === 'history.undo_batch' ? '撤销画布批次' : '精确调整画布',
      objectLabel: '语义画布',
      actionLabel: tool.kind === 'history.undo_batch' ? '撤销最近修改' : tool.summary,
      impactLabel: '通过 Main 原子执行并保留撤销能力',
      scopeLabel: tool.kind,
      budgetImpact: null
    }
  }
  const count = tool.kind === 'generation' ? tool.request.count : tool.count
  return {
    kind: 'tool',
    label: tool.kind === 'canvas_generation' ? '编译画布并生成' : '创建生成任务',
    objectLabel: '图片生成',
    actionLabel: tool.kind === 'canvas_generation' ? '编译参考图与语义提示' : '提交文生图任务',
    impactLabel: `将创建 ${count} 张图片`,
    scopeLabel: tool.kind === 'generation'
      ? `${tool.request.aspectWidth}:${tool.request.aspectHeight} · ${tool.request.model}`
      : `当前画布 · ${tool.model}`,
    budgetImpact: { requests: 1, images: count, maxCny: 0 }
  }
}

function generationProjection(job: GenerationJob): { state: AgentActivityState; progress: number | null; eventType: string; impact: string; recoverable: boolean } {
  if (job.status === 'queued') return { state: 'queued', progress: 0, eventType: 'generation.queued', impact: '任务已进入图片生成队列', recoverable: false }
  if (job.status === 'preparing') return { state: 'running', progress: 0.12, eventType: 'generation.validating', impact: '正在校验尺寸、模型与输入资产', recoverable: false }
  if (job.status === 'generating') return { state: 'running', progress: 0.55, eventType: 'generation.running', impact: '图片 Provider 正在生成结果', recoverable: false }
  if (job.status === 'downloading') return { state: 'running', progress: 0.82, eventType: 'generation.localizing', impact: '正在保存结果与缩略图', recoverable: false }
  if (job.status === 'completed') return { state: 'completed', progress: 1, eventType: 'generation.completed', impact: `已保存 ${job.results.length} 张结果`, recoverable: false }
  if (job.status === 'cancelled') return { state: 'cancelled', progress: null, eventType: 'generation.cancelled', impact: '任务已停止，已有结果保持不变', recoverable: true }
  if (job.status === 'interrupted') return { state: 'interrupted', progress: null, eventType: 'generation.interrupted', impact: '上次运行被中断，可以从生成页重试', recoverable: true }
  return { state: 'failed', progress: null, eventType: `generation.${job.status}`, impact: job.status === 'timed_out' ? '任务等待过久，可以重试' : '生成失败，可以检查设置后重试', recoverable: true }
}

export class ActivityLedgerRepository {
  readonly #connection: DatabaseConnection
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(databasePath: string, options: { readonly idFactory?: () => string; readonly now?: () => string } = {}) {
    this.#connection = openDatabase(databasePath)
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async create(input: CreateActivityInput): Promise<string> {
    const id = this.#idFactory()
    const now = this.#now()
    const row: AgentActivityRow = {
      id,
      project_id: input.projectId,
      run_id: input.runId ?? null,
      ordinal: input.ordinal ?? null,
      kind: input.kind,
      event_type: input.eventType,
      label: safeCopy(input.label, '活动'),
      state: input.state,
      progress: input.progress ?? null,
      object_label: safeCopy(input.objectLabel, '当前作品'),
      action_label: safeCopy(input.actionLabel, '执行操作'),
      impact_label: safeCopy(input.impactLabel, '等待处理'),
      scope_label: input.scopeLabel == null ? null : safeCopy(input.scopeLabel, '当前范围'),
      affected_ids_json: JSON.stringify(input.affectedIds ?? []),
      operation_batch_id: input.operationBatchId ?? null,
      job_id: input.jobId ?? null,
      budget_impact_json: input.budgetImpact == null ? null : JSON.stringify(input.budgetImpact),
      recoverable: input.recoverable === true ? 1 : 0,
      undone_at: null,
      started_at: input.state === 'running' ? now : null,
      ended_at: ['completed', 'failed', 'cancelled', 'interrupted'].includes(input.state) ? now : null,
      created_at: now,
      updated_at: now
    }
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction.insertInto('agent_activities').values(row))
      executeSynchronous(this.#connection, transaction.insertInto('agent_activity_events').values({
        id: this.#idFactory(), activity_id: id, event_type: input.eventType, state: input.state,
        summary: row.impact_label, created_at: now
      }))
    })()
    return id
  }

  async transition(
    activityId: string,
    eventType: string,
    state: AgentActivityState,
    updates: Partial<Pick<CreateActivityInput, 'progress' | 'impactLabel' | 'affectedIds' | 'operationBatchId' | 'jobId' | 'recoverable'>> = {}
  ): Promise<void> {
    const current = await this.#connection.kysely.selectFrom('agent_activities').selectAll().where('id', '=', activityId).executeTakeFirst()
    if (current === undefined) throw new Error(`Activity ${activityId} does not exist.`)
    const now = this.#now()
    const impact = updates.impactLabel === undefined ? current.impact_label : safeCopy(updates.impactLabel, current.impact_label)
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction.updateTable('agent_activities').set({
        event_type: eventType,
        state,
        progress: updates.progress === undefined ? current.progress : updates.progress,
        impact_label: impact,
        affected_ids_json: updates.affectedIds === undefined ? current.affected_ids_json : JSON.stringify(updates.affectedIds),
        operation_batch_id: updates.operationBatchId === undefined ? current.operation_batch_id : updates.operationBatchId,
        job_id: updates.jobId === undefined ? current.job_id : updates.jobId,
        recoverable: updates.recoverable === undefined ? current.recoverable : updates.recoverable ? 1 : 0,
        started_at: current.started_at ?? (state === 'running' ? now : null),
        ended_at: ['completed', 'failed', 'cancelled', 'interrupted'].includes(state) ? now : null,
        updated_at: now
      }).where('id', '=', activityId))
      executeSynchronous(this.#connection, transaction.insertInto('agent_activity_events').values({
        id: this.#idFactory(), activity_id: activityId, event_type: eventType, state, summary: impact, created_at: now
      }))
    })()
  }

  async createToolActivities(projectId: string, runId: string, plan: AgentPlan): Promise<void> {
    for (const [ordinal, tool] of plan.tools.entries()) {
      const projection = toolProjection(tool)
      const existing = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
        .where('run_id', '=', runId).where('kind', '=', 'tool').where('ordinal', '=', ordinal).executeTakeFirst()
      if (existing === undefined) {
        await this.create({
          projectId, runId, ordinal, eventType: 'tool.queued', state: 'queued', ...projection
        })
        continue
      }
      const now = this.#now()
      const impact = safeCopy(projection.impactLabel, '等待执行重规划步骤')
      this.#connection.sqlite.transaction(() => {
        const transaction = this.#connection.kysely
        executeSynchronous(this.#connection, transaction.updateTable('agent_activities').set({
          event_type: 'tool.replanned',
          label: safeCopy(projection.label, '更新画布'),
          state: 'queued',
          progress: 0,
          object_label: safeCopy(projection.objectLabel, '当前作品'),
          action_label: safeCopy(projection.actionLabel, '执行重规划步骤'),
          impact_label: impact,
          scope_label: projection.scopeLabel == null ? null : safeCopy(projection.scopeLabel, '当前范围'),
          affected_ids_json: '[]',
          operation_batch_id: null,
          job_id: null,
          budget_impact_json: projection.budgetImpact == null ? null : JSON.stringify(projection.budgetImpact),
          recoverable: 0,
          undone_at: null,
          started_at: null,
          ended_at: null,
          updated_at: now
        }).where('id', '=', existing.id))
        executeSynchronous(this.#connection, transaction.insertInto('agent_activity_events').values({
          id: this.#idFactory(),
          activity_id: existing.id,
          event_type: 'tool.replanned',
          state: 'queued',
          summary: impact,
          created_at: now
        }))
      })()
    }
  }

  async ensureToolActivity(projectId: string, runId: string, ordinal: number, tool: AgentPlan['tools'][number]): Promise<void> {
    const existing = await this.#connection.kysely.selectFrom('agent_activities').select('id')
      .where('run_id', '=', runId).where('kind', '=', 'tool').where('ordinal', '=', ordinal).executeTakeFirst()
    if (existing !== undefined) return
    await this.create({ projectId, runId, ordinal, eventType: 'tool.queued', state: 'queued', ...toolProjection(tool) })
  }

  async transitionTool(runId: string, ordinal: number, eventType: string, state: AgentActivityState, outcome?: AgentToolOutcome): Promise<void> {
    const activity = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('run_id', '=', runId).where('kind', '=', 'tool').where('ordinal', '=', ordinal)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst()
    if (activity === undefined) throw new Error(`Tool activity ${runId}:${ordinal} does not exist.`)
    await this.transition(activity.id, eventType, state, outcome === undefined ? {} : {
      progress: outcome.ok ? 1 : null,
      impactLabel: safeCopy(outcome.message, outcome.ok ? '操作已完成' : '操作未完成'),
      affectedIds: outcome.affectedElementIds,
      operationBatchId: outcome.batchId,
      jobId: outcome.jobId,
      recoverable: !outcome.ok
    })
  }

  async cancelToolActivities(runId: string, impactLabel: string): Promise<number> {
    const activities = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('run_id', '=', runId).where('kind', '=', 'tool').where('state', 'in', ['queued', 'running', 'waiting']).execute()
    for (const activity of activities) {
      await this.transition(activity.id, 'tool.superseded', 'cancelled', { impactLabel, recoverable: true })
    }
    return activities.length
  }

  async transitionRunActivity(
    runId: string,
    kind: Extract<AgentActivityKind, 'plan' | 'decision' | 'receipt' | 'recovery'>,
    eventType: string,
    state: AgentActivityState,
    updates: Partial<Pick<CreateActivityInput, 'progress' | 'impactLabel' | 'affectedIds' | 'operationBatchId' | 'jobId' | 'recoverable'>> = {}
  ): Promise<void> {
    const activity = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('run_id', '=', runId).where('kind', '=', kind).orderBy('created_at', 'desc').executeTakeFirst()
    if (activity === undefined) return
    await this.transition(activity.id, eventType, state, updates)
  }

  async cancelRun(runId: string, impactLabel = '操作已停止，未执行的步骤不会继续'): Promise<void> {
    const activities = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('run_id', '=', runId).where('state', 'in', ['queued', 'running', 'waiting']).execute()
    for (const activity of activities) {
      await this.transition(activity.id, `${activity.kind}.cancelled`, 'cancelled', { impactLabel, recoverable: true })
    }
  }

  async createDecision(input: CreateDecisionInput): Promise<AgentDecision> {
    if (!input.options.some((option) => option.id === input.defaultOptionId)) throw new Error('Decision default option must exist.')
    const now = this.#now()
    const row: AgentDecisionRow = {
      id: this.#idFactory(), project_id: input.projectId, run_id: input.runId, activity_id: input.activityId,
      kind: input.kind, title: safeCopy(input.title, '需要你的决定'), consequence: safeCopy(input.consequence, '确认后继续'),
      options_json: JSON.stringify(input.options.map((option) => ({ ...option, label: safeCopy(option.label, '选项'), consequence: safeCopy(option.consequence, '继续') }))),
      default_option_id: input.defaultOptionId, status: 'waiting', selected_option_id: null, created_at: now, resolved_at: null
    }
    // agent_decisions is the legacy/current decision projection for a run.
    // Persistent turns may legitimately ask more than one sequential question
    // (for example, review approval followed by generation confirmation), so a
    // later decision replaces the resolved projection instead of violating the
    // historical UNIQUE(run_id) constraint. Full decision history remains in
    // agent_items and agent_activity_events.
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_decisions (
        id, project_id, run_id, activity_id, kind, title, consequence, options_json,
        default_option_id, status, selected_option_id, created_at, resolved_at
      ) VALUES (
        @id, @project_id, @run_id, @activity_id, @kind, @title, @consequence, @options_json,
        @default_option_id, @status, @selected_option_id, @created_at, @resolved_at
      )
      ON CONFLICT(run_id) DO UPDATE SET
        project_id = excluded.project_id,
        activity_id = excluded.activity_id,
        kind = excluded.kind,
        title = excluded.title,
        consequence = excluded.consequence,
        options_json = excluded.options_json,
        default_option_id = excluded.default_option_id,
        status = excluded.status,
        selected_option_id = excluded.selected_option_id,
        created_at = excluded.created_at,
        resolved_at = excluded.resolved_at
    `).run(row)
    const stored = await this.#connection.kysely.selectFrom('agent_decisions').selectAll().where('run_id', '=', input.runId).executeTakeFirstOrThrow()
    return mapDecision(stored)
  }

  async resolveDecision(runId: string, optionId: string, cancelled = false): Promise<void> {
    const decision = await this.#connection.kysely.selectFrom('agent_decisions').selectAll().where('run_id', '=', runId).executeTakeFirst()
    if (decision === undefined || decision.status !== 'waiting') return
    const options = JSON.parse(decision.options_json) as AgentDecisionOption[]
    if (!options.some((option) => option.id === optionId)) throw new Error('Decision option does not exist.')
    const now = this.#now()
    await this.#connection.kysely.updateTable('agent_decisions').set({
      status: cancelled ? 'cancelled' : 'resolved', selected_option_id: optionId, resolved_at: now
    }).where('id', '=', decision.id).executeTakeFirstOrThrow()
    await this.transition(decision.activity_id, cancelled ? 'decision.cancelled' : 'decision.resolved', cancelled ? 'cancelled' : 'completed', {
      progress: cancelled ? null : 1,
      impactLabel: options.find((option) => option.id === optionId)?.consequence ?? '决定已记录',
      recoverable: false
    })
  }

  async getDecision(runId: string): Promise<AgentDecision | null> {
    const row = await this.#connection.kysely.selectFrom('agent_decisions').selectAll().where('run_id', '=', runId).executeTakeFirst()
    return row === undefined ? null : mapDecision(row)
  }

  async upsertGeneration(job: GenerationJob): Promise<void> {
    const projection = generationProjection(job)
    const existing = await this.#connection.kysely.selectFrom('agent_activities').selectAll().where('job_id', '=', job.id).where('kind', '=', 'generation').executeTakeFirst()
    if (existing === undefined) {
      const run = job.sourceMessageId === null ? undefined : await this.#connection.kysely.selectFrom('agent_runs').select('id').where('user_message_id', '=', job.sourceMessageId).executeTakeFirst()
      await this.create({
        projectId: job.projectId,
        runId: run?.id ?? null,
        kind: 'generation',
        eventType: projection.eventType,
        label: '图片生成任务',
        state: projection.state,
        progress: projection.progress,
        objectLabel: `${job.request.count} 张图片`,
        actionLabel: 'kind' in job.request && job.request.kind === 'edit' ? '局部修改' : '生成图片',
        impactLabel: projection.impact,
        scopeLabel: `${job.request.aspectWidth}:${job.request.aspectHeight} · ${job.model}`,
        affectedIds: job.results.map((result) => result.assetId),
        jobId: job.id,
        budgetImpact: { requests: 1, images: job.request.count, maxCny: 0 },
        recoverable: projection.recoverable
      })
      return
    }
    if (existing.event_type === projection.eventType && existing.state === projection.state && existing.progress === projection.progress) return
    await this.transition(existing.id, projection.eventType, projection.state, {
      progress: projection.progress,
      impactLabel: projection.impact,
      affectedIds: job.results.map((result) => result.assetId),
      recoverable: projection.recoverable
    })
  }

  async markBatchUndone(projectId: string, batchId: string): Promise<void> {
    const row = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('project_id', '=', projectId).where('operation_batch_id', '=', batchId).executeTakeFirst()
    if (row === undefined || row.undone_at !== null) return
    const now = this.#now()
    await this.#connection.kysely.updateTable('agent_activities').set({ undone_at: now, updated_at: now }).where('id', '=', row.id).executeTakeFirstOrThrow()
    await this.#connection.kysely.insertInto('agent_activity_events').values({
      id: this.#idFactory(), activity_id: row.id, event_type: 'command.undo', state: row.state,
      summary: '对应画布批次已撤销', created_at: now
    }).executeTakeFirstOrThrow()
  }

  async recoverInterrupted(projectId: string): Promise<number> {
    const waitingRuns = new Set((await this.#connection.kysely.selectFrom('agent_runs').select('id')
      .where('project_id', '=', projectId).where('status', '=', 'awaiting_confirmation').execute()).map((run) => run.id))
    const rows = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('project_id', '=', projectId).where('state', 'in', ['queued', 'running']).execute()
    const interrupted = rows.filter((row) => row.run_id === null || !waitingRuns.has(row.run_id))
    for (const row of interrupted) {
      await this.transition(row.id, 'activity.interrupted', 'interrupted', {
        progress: null, impactLabel: '应用在活动完成前关闭；记录已保留，可以重新发起', recoverable: true
      })
    }
    return interrupted.length
  }

  async list(projectId: string): Promise<readonly AgentActivity[]> {
    const activities = await this.#connection.kysely.selectFrom('agent_activities').selectAll()
      .where('project_id', '=', projectId).orderBy('created_at', 'asc').orderBy('id', 'asc').execute()
    if (activities.length === 0) return []
    const activityIds = activities.map((activity) => activity.id)
    const [events, decisions] = await Promise.all([
      this.#connection.kysely.selectFrom('agent_activity_events').selectAll().where('activity_id', 'in', activityIds).orderBy('created_at', 'asc').orderBy('id', 'asc').execute(),
      this.#connection.kysely.selectFrom('agent_decisions').selectAll().where('activity_id', 'in', activityIds).execute()
    ])
    return activities.map((activity) => mapActivity(
      activity,
      events.filter((event) => event.activity_id === activity.id),
      decisions.find((decision) => decision.activity_id === activity.id)
    ))
  }

  async close(): Promise<void> {
    await this.#connection.kysely.destroy()
  }
}
