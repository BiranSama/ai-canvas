import type { AgentEvent, AgentHarnessSnapshot, AgentItem, AgentItemStatus, AgentTurn, AgentTurnStatus } from '../../../shared/agent-harness'
import type { AgentActivity, AgentActivityState } from '../../../shared/agent'
import { completionFactsSchema } from '../../../shared/design-capability'
import {
  parseAgentObservableEvent,
  type AgentPlanLifecycleEventV1,
  type AgentProviderAttemptEventV1,
  type AgentRecoveryLifecycleEventV1
} from '../../../shared/agent-observability'

export type AgentExecutionStageKind =
  | 'request'
  | 'context'
  | 'planning'
  | 'tool'
  | 'decision'
  | 'scene'
  | 'generation'
  | 'recovery'
  | 'assessment'

export type AgentExecutionStageState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type AgentExecutionStallLevel = 'normal' | 'slow' | 'long' | 'terminal'

export interface AgentExecutionStage {
  readonly id: string
  readonly kind: AgentExecutionStageKind
  readonly state: AgentExecutionStageState
  readonly label: string
  readonly detail: string
  readonly categoryLabel: string | null
  readonly scopeLabel: string | null
  readonly durationMs: number | null
  readonly sourceItemId: string | null
}

export interface AgentExecutionFlow {
  readonly turnId: string
  readonly state: AgentExecutionStageState
  readonly headline: string
  readonly summary: string
  readonly statusLabel: string
  readonly stallLevel: AgentExecutionStallLevel
  readonly elapsedMs: number
  readonly lastProgressAgeMs: number
  readonly remainingWallTimeMs: number | null
  readonly timeLimitMs?: number | null
  readonly providerSummary: string | null
  readonly stages: readonly AgentExecutionStage[]
  readonly totalStageCount: number
  readonly hiddenStageCount: number
  readonly canCancel: boolean
  readonly canRestoreRequest: boolean
}

interface ProjectionOptions {
  readonly expanded?: boolean
  readonly activities?: readonly AgentActivity[]
  readonly events?: readonly AgentEvent[]
}

interface ToolDisplayInfo {
  readonly label: string
  readonly categoryLabel: string
}

const ACTIVE_TURN_STATUSES = new Set<AgentTurnStatus>([
  'queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job'
])

const COMPLETED_TURN_STATUSES = new Set<AgentTurnStatus>([
  'completed', 'completed_with_notes', 'needs_user_review'
])

const TOOL_DISPLAY: Readonly<Record<string, ToolDisplayInfo>> = {
  'scene.get_summary': { label: '读取画布摘要', categoryLabel: '画布' },
  'scene.get_elements': { label: '读取元素详情', categoryLabel: '画布' },
  'scene.set_canvas': { label: '调整画布比例', categoryLabel: '画布' },
  'scene.create_elements': { label: '添加画布元素', categoryLabel: '画布' },
  'scene.update_elements': { label: '更新画布元素', categoryLabel: '画布' },
  'scene.reorder_elements': { label: '调整图层顺序', categoryLabel: '画布' },
  'scene.group_elements': { label: '组合画布元素', categoryLabel: '画布' },
  'scene.remove_elements': { label: '删除画布元素', categoryLabel: '画布' },
  'history.undo_batch': { label: '撤销最近的画布修改', categoryLabel: '历史' },
  'result.place_on_canvas': { label: '将生成结果放入画布', categoryLabel: '结果' },
  scene_batch: { label: '批量更新画布', categoryLabel: '画布' },
  read_scene: { label: '读取画布状态', categoryLabel: '画布' },
  generation: { label: '创建图片生成任务', categoryLabel: '图片任务' },
  canvas_generation: { label: '创建画布图片任务', categoryLabel: '图片任务' },
  canvas_edit: { label: '按标注修改图片', categoryLabel: '图片任务' },
  cancel_generation: { label: '停止图片任务', categoryLabel: '图片任务' },
  memory_candidate: { label: '提出项目记忆候选', categoryLabel: '项目记忆' },
  directive_create: { label: '写入已确认的项目规则', categoryLabel: '项目规则' },
  place_generation_result: { label: '将生成结果放入画布', categoryLabel: '结果' }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function safeText(value: unknown, fallback: string, maxLength = 180): string {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return fallback
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function statusState(status: AgentItemStatus): AgentExecutionStageState {
  if (status === 'started') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled'
  return 'queued'
}

function activityState(state: AgentActivityState, undoneAt: string | null): AgentExecutionStageState {
  if (undoneAt !== null) return 'cancelled'
  if (state === 'running') return 'running'
  if (state === 'waiting') return 'waiting'
  if (state === 'completed') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled' || state === 'interrupted') return 'cancelled'
  return 'queued'
}

function activityDuration(activity: AgentActivity): number | null {
  const start = Date.parse(activity.startedAt ?? activity.createdAt)
  const end = Date.parse(activity.endedAt ?? activity.updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
}

/**
 * Activity Ledger contains a few user-originated product actions that do not
 * belong to a Harness model/tool turn. Only project those explicit allowlisted
 * facts here; ordinary tool/generation activities are already represented by
 * Harness items and would otherwise appear twice.
 */
function supplementalActivityStages(activities: readonly AgentActivity[]): AgentExecutionStage[] {
  return activities
    .filter((activity) => activity.eventType.startsWith('direction.'))
    .map((activity) => ({
      id: `activity-${activity.id}`,
      kind: 'scene' as const,
      state: activityState(activity.state, activity.undoneAt),
      label: activity.undoneAt === null ? safeText(activity.label, '设计方向已更新', 160) : '设计方向切换已撤销',
      detail: activity.undoneAt === null
        ? safeText(activity.impactLabel, '作品与结构化计划已同步。')
        : '作品已恢复到切换前的可验证状态。',
      categoryLabel: '作品',
      scopeLabel: activity.scopeLabel,
      durationMs: activityDuration(activity),
      sourceItemId: null
    }))
}

function providerEventStage(event: AgentEvent, payload: AgentProviderAttemptEventV1): AgentExecutionStage {
  const copy = {
    reserved: ['检查模型与工具', '本轮模型请求已在 Main 中预留；尚未连接供应商。'],
    connecting: ['连接文字模型', '正在连接已配置的文字模型；尚未收到响应。'],
    headers: ['等待首个响应', '模型响应已建立，正在等待第一项可验证内容。'],
    first_event: ['接收创作方案', '已收到第一项合法模型事件；参数完整前不会执行。'],
    receiving: ['接收创作方案', '正在接收结构化画布操作；尚未把未完成参数交给工具。'],
    completed: ['创作方案接收完成', '供应商已明确完成本次响应，正在进入本地校验。'],
    failed: ['文字模型请求未完成', '请求已停在明确失败节点；应用没有自动提交第二个 POST。'],
    cancelled: ['文字模型请求已停止', '当前请求已经停止，未开始的操作不会继续。']
  } as const
  const [label, detail] = copy[payload.phase]
  return {
    id: `provider-${event.id}`,
    kind: 'planning',
    state: payload.phase === 'connecting' || payload.phase === 'receiving'
      ? 'running'
      : payload.phase === 'headers'
        ? 'waiting'
        : payload.phase === 'failed'
          ? 'failed'
          : payload.phase === 'cancelled'
            ? 'cancelled'
            : 'completed',
    label,
    detail,
    categoryLabel: payload.providerLabel,
    scopeLabel: `${payload.protocol} · ${payload.transportMode === 'stream' ? '流式' : '完整响应'}`,
    durationMs: payload.elapsedMs,
    sourceItemId: null
  }
}

function eventStages(events: readonly AgentEvent[]): AgentExecutionStage[] {
  const providers = events.flatMap((event) => {
    const parsed = parseAgentObservableEvent(event.type, event.payload)
    return parsed !== null && parsed.type.startsWith('provider.attempt.')
      ? [{ event, payload: parsed.payload as AgentProviderAttemptEventV1 }] : []
  })
  return events.flatMap((event, eventIndex): AgentExecutionStage[] => {
    const parsed = parseAgentObservableEvent(event.type, event.payload)
    if (parsed === null) return []
    if (parsed.type.startsWith('provider.attempt.')) {
      const payload = parsed.payload as AgentProviderAttemptEventV1
      const attempt = providers.filter((entry) => entry.payload.attemptId === payload.attemptId)
      const latest = attempt.at(-1)
      if (payload.phase === 'receiving' && attempt.filter((entry) => entry.payload.phase === 'receiving').at(-1)?.event.id !== event.id) return []
      if (payload.phase === 'first_event' && attempt.some((entry) => entry.payload.phase === 'receiving')) return []
      const stage = providerEventStage(event, payload)
      if (latest?.event.id !== event.id && (stage.state === 'running' || stage.state === 'waiting')) {
        const interrupted = payload.phase === 'receiving' && (latest?.payload.phase === 'failed' || latest?.payload.phase === 'cancelled')
        return [{ ...stage, state: interrupted ? 'cancelled' : 'completed',
          detail: interrupted ? '接收已停止；未完成参数没有交给工具。' : '这一传输阶段已经结束，后续进展见下方。' }]
      }
      return [stage]
    }
    if (parsed.type.startsWith('plan.validation.')) {
      const payload = parsed.payload as AgentPlanLifecycleEventV1
      const phase = parsed.type.split('.').at(-1)
      const nextValidation = events.slice(eventIndex + 1).map((next) => parseAgentObservableEvent(next.type, next.payload))
        .find((next) => next?.type.startsWith('plan.validation.') && next.payload.requestCorrelationId === payload.requestCorrelationId)
      if (phase === 'started' && nextValidation !== undefined && nextValidation?.type !== 'plan.validation.started') return []
      return [{
        id: `validation-${event.id}`,
        kind: 'planning',
        state: phase === 'started' ? 'running' : phase === 'failed' ? 'failed' : 'completed',
        label: phase === 'started' ? '校验创作方案' : phase === 'failed' ? '创作方案校验未通过' : '创作方案已校验',
        detail: phase === 'started'
          ? '正在核对操作范围、元素身份与画布版本。'
          : phase === 'failed'
            ? '画布尚未修改；只会在允许的恢复范围内继续。'
            : `${payload.toolCount ?? 0} 项操作通过结构化校验。`,
        categoryLabel: '本地校验', scopeLabel: '当前方案', durationMs: payload.elapsedMs, sourceItemId: null
      }]
    }
    const payload = parsed.payload as AgentRecoveryLifecycleEventV1
    const phase = parsed.type.split('.').at(-1)
    const laterRecovery = events.slice(eventIndex + 1).some((next) => {
      const later = parseAgentObservableEvent(next.type, next.payload)
      return later?.type.startsWith('recovery.') && later.payload.requestCorrelationId === payload.requestCorrelationId
    })
    if (phase === 'started' && laterRecovery) return []
    return [{
      id: `recovery-event-${event.id}`,
      kind: 'recovery',
      state: phase === 'started' ? 'running' : phase === 'exhausted' ? 'failed' : 'completed',
      label: phase === 'started' ? '修正可恢复问题' : phase === 'exhausted' ? '修正次数已用尽' : '修正已记录',
      detail: phase === 'exhausted'
        ? '相同问题仍未改善，应用已停止自动纠正。'
        : `只修正本次失败范围 · ${payload.attempt}/${payload.maxAttempts}`,
      categoryLabel: '恢复', scopeLabel: '本轮', durationMs: null, sourceItemId: null
    }]
  })
}

function toolRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value)
  const nested = asRecord(direct?.tool)
  return nested ?? direct
}

export function toolDisplayInfo(value: unknown): ToolDisplayInfo {
  const tool = toolRecord(value)
  const kind = typeof tool?.kind === 'string' ? tool.kind : ''
  return TOOL_DISPLAY[kind] ?? { label: '执行本地创作步骤', categoryLabel: '工具' }
}

function itemPayload(item: AgentItem | undefined): Record<string, unknown> | null {
  return item === undefined ? null : asRecord(item.payload)
}

function itemTime(item: AgentItem | undefined): number | null {
  if (item === undefined) return null
  const value = Date.parse(item.updatedAt)
  return Number.isFinite(value) ? value : null
}

function durationBetween(start: AgentItem | undefined, end: AgentItem | undefined): number | null {
  const startTime = start === undefined ? null : Date.parse(start.createdAt)
  const endTime = itemTime(end ?? start)
  if (startTime === null || endTime === null || !Number.isFinite(startTime)) return null
  return Math.max(0, endTime - startTime)
}

function outcomeFor(call: AgentItem, results: readonly AgentItem[]): { readonly result: AgentItem | undefined; readonly outcome: Record<string, unknown> | null } {
  const callPayload = itemPayload(call)
  const index = typeof callPayload?.toolIndex === 'number' ? callPayload.toolIndex : null
  const result = results.find((candidate) => {
    const stored = itemPayload(candidate)
    if (stored?.toolCallItemId === call.id) return true
    const outcome = asRecord(stored?.outcome)
    return index !== null && outcome?.toolIndex === index
  })
  return { result, outcome: asRecord(itemPayload(result)?.outcome) }
}

function scopeFor(outcome: Record<string, unknown> | null): string | null {
  const affected = Array.isArray(outcome?.affectedElementIds) ? outcome.affectedElementIds.length : 0
  if (affected > 0) return `${affected} 个元素`
  if (typeof outcome?.jobId === 'string' && outcome.jobId.length > 0) return '1 个图片任务'
  if (typeof outcome?.batchId === 'string' && outcome.batchId.length > 0) return '当前作品'
  return null
}

function toolStage(call: AgentItem, results: readonly AgentItem[]): AgentExecutionStage {
  const payload = itemPayload(call)
  const tool = toolRecord(payload)
  const display = toolDisplayInfo(tool)
  const { result, outcome } = outcomeFor(call, results)
  const finalStatus = result?.status ?? call.status
  const affected = Array.isArray(outcome?.affectedElementIds) ? outcome.affectedElementIds.length : 0
  const detail = finalStatus === 'completed'
    ? typeof outcome?.jobId === 'string' && outcome.jobId.length > 0
      ? '图片任务已创建并进入可追溯队列。'
      : affected > 0
        ? `修改已写入 ${affected} 个元素。`
        : typeof outcome?.batchId === 'string' && outcome.batchId.length > 0
          ? '修改已写入当前作品。'
          : '这项创作操作已完成。'
    : finalStatus === 'failed'
      ? safeText(outcome?.message, '这项操作没有完成，作品保持在可恢复状态。')
      : finalStatus === 'waiting'
        ? '正在等待继续条件。'
        : '正在执行这项创作操作。'
  return {
    id: `tool-${call.id}`,
    kind: 'tool',
    state: statusState(finalStatus),
    label: display.label,
    detail,
    categoryLabel: display.categoryLabel,
    scopeLabel: scopeFor(outcome),
    durationMs: durationBetween(call, result),
    sourceItemId: call.id
  }
}

function plannedToolStage(item: AgentItem): AgentExecutionStage | null {
  const step = asRecord(itemPayload(item)?.step)
  if (step?.kind !== 'tool') return null
  const display = toolDisplayInfo(step.call)
  return {
    id: `planned-tool-${item.id}`,
    kind: 'tool',
    state: 'queued',
    label: display.label,
    detail: '方案已返回；尚未开始执行。',
    categoryLabel: display.categoryLabel,
    scopeLabel: null,
    durationMs: null,
    sourceItemId: item.id
  }
}

function observableStages(items: readonly AgentItem[], results: readonly AgentItem[]): AgentExecutionStage[] {
  const calls = items.filter((item) => item.type === 'tool_call')
  const representedIndexes = new Set(calls.flatMap((call) => {
    const index = itemPayload(call)?.toolIndex
    return typeof index === 'number' ? [index] : []
  }))
  const stages: AgentExecutionStage[] = []
  for (const item of items) {
    if (item.type === 'plan') {
      const step = asRecord(itemPayload(item)?.step)
      if (typeof step?.toolIndex !== 'number' || representedIndexes.has(step.toolIndex)) continue
      const stage = plannedToolStage(item)
      if (stage !== null) stages.push(stage)
      continue
    }
    if (item.type === 'tool_call') stages.push(toolStage(item, results))
    else if (item.type === 'decision') stages.push(decisionStage(item))
    else if (item.type === 'recovery') stages.push(recoveryStage(item))
    else if (item.type === 'scene_change') stages.push(sceneStage(item))
    else if (item.type === 'generation_subscription') stages.push(generationStage(item))
    else if (item.type === 'completion_assessment') stages.push(assessmentStage(item))
  }
  return stages
}

function fixedStages(turn: AgentTurn, hasPlan: boolean, hasTool: boolean, elapsedMs: number, stallLevel: AgentExecutionStallLevel): AgentExecutionStage[] {
  const contextRunning = turn.status === 'building_context'
  const contextCompleted = !['queued', 'building_context'].includes(turn.status)
  const planningRunning = turn.status === 'planning'
  const planningCompleted = hasPlan || hasTool || [
    'running', 'waiting_decision', 'waiting_job', 'completed', 'completed_with_notes', 'needs_user_review'
  ].includes(turn.status)
  const failedBeforePlan = turn.status === 'failed' && !hasPlan && !hasTool
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const planningDetail = !planningRunning
    ? planningCompleted
      ? '模型已返回可验证的下一步。'
      : failedBeforePlan
        ? '文字模型没有返回可验证方案。'
        : '将在上下文准备完成后请求方案。'
    : stallLevel === 'long'
      ? `等待时间较长；可以继续等待，或停止后检查连接与超时设置 · ${elapsedSeconds} 秒`
      : stallLevel === 'slow'
        ? `响应比平时慢，仍在等待 · ${elapsedSeconds} 秒`
        : `等待模型返回可验证方案 · ${elapsedSeconds} 秒`
  return [
    {
      id: `${turn.id}-request`, kind: 'request', state: 'completed', label: '已接收要求',
      detail: '要求已进入当前作品，不代表已经执行。', categoryLabel: null, scopeLabel: '当前作品', durationMs: null, sourceItemId: null
    },
    {
      id: `${turn.id}-context`, kind: 'context', state: contextCompleted ? 'completed' : contextRunning ? 'running' : 'queued',
      label: '准备创作上下文',
      detail: contextCompleted ? '画布、选择与相关项目上下文已准备。' : contextRunning ? '正在整理这次操作真正需要的上下文。' : '等待开始整理上下文。',
      categoryLabel: null, scopeLabel: '有界上下文', durationMs: null, sourceItemId: null
    },
    {
      id: `${turn.id}-planning`, kind: 'planning', state: planningCompleted ? 'completed' : failedBeforePlan ? 'failed' : planningRunning ? 'running' : 'queued',
      label: failedBeforePlan ? '规划未完成' : '请求创作方案', detail: planningDetail,
      categoryLabel: '文字模型', scopeLabel: null, durationMs: planningRunning ? elapsedMs : null, sourceItemId: null
    }
  ]
}

function decisionStage(item: AgentItem): AgentExecutionStage {
  const proposal = asRecord(itemPayload(item)?.proposal)
  const waiting = item.status === 'waiting'
  return {
    id: `decision-${item.id}`,
    kind: 'decision',
    state: statusState(item.status),
    label: waiting ? '等待你的决定' : '已确认下一步',
    detail: safeText(waiting ? proposal?.consequence : proposal?.title, waiting ? '需要确认后才能继续。' : '决定已记录，流程可以继续。'),
    categoryLabel: '决定',
    scopeLabel: '当前任务',
    durationMs: null,
    sourceItemId: item.id
  }
}

function recoveryStage(item: AgentItem): AgentExecutionStage {
  const payload = itemPayload(item)
  const failure = asRecord(payload?.failure)
  const attempt = typeof failure?.attempt === 'number' ? failure.attempt : 1
  const maxAttempts = typeof failure?.maxAttempts === 'number' ? failure.maxAttempts : 2
  const stopped = item.status === 'failed' || item.status === 'cancelled'
  const category = stopped
    ? '流程已停止；没有自动提交新的模型请求。'
    : failure?.category === 'schema'
    ? '已把参数约束反馈给模型；等待可验证的修正。'
    : failure?.category === 'revision'
      ? '画布已变化，已刷新本轮上下文。'
      : failure?.category === 'model_output'
        ? '已把可用工具反馈给模型；等待可验证的修正。'
        : '本地可恢复步骤已重新校验。'
  return {
    id: `recovery-${item.id}`,
    kind: 'recovery',
    state: statusState(item.status),
    label: stopped ? '需要处理' : '修正工具调用',
    detail: `${category} ${attempt}/${maxAttempts}`,
    categoryLabel: '恢复',
    scopeLabel: '本轮',
    durationMs: null,
    sourceItemId: item.id
  }
}

function generationStage(item: AgentItem): AgentExecutionStage {
  const payload = itemPayload(item)
  const jobStatus = safeText(payload?.lastJobStatus, '', 60)
  return {
    id: `generation-${item.id}`,
    kind: 'generation',
    state: statusState(item.status),
    label: item.status === 'waiting' ? '等待图片任务' : item.status === 'failed' ? '图片任务未完成' : '图片任务已返回',
    detail: item.status === 'waiting' ? '图片任务已创建，正在等待真实结果。' : jobStatus.length > 0 ? `任务状态：${jobStatus}` : '图片任务状态已记录。',
    categoryLabel: '图片任务',
    scopeLabel: '1 个任务',
    durationMs: null,
    sourceItemId: item.id
  }
}

function sceneStage(item: AgentItem): AgentExecutionStage {
  return {
    id: `scene-${item.id}`,
    kind: 'scene',
    state: statusState(item.status),
    label: '同步作品',
    detail: item.status === 'completed' ? '已将这项修改写入同一份画布。' : '正在同步画布状态。',
    categoryLabel: '画布',
    scopeLabel: '当前作品',
    durationMs: null,
    sourceItemId: item.id
  }
}

function assessmentStage(item: AgentItem): AgentExecutionStage {
  const payload = itemPayload(item)
  const status = payload?.status
  const needsReview = status === 'needs_user_review'
  return {
    id: `assessment-${item.id}`,
    kind: 'assessment',
    state: needsReview ? 'waiting' : statusState(item.status),
    label: '核对本轮结果',
    detail: needsReview ? '结果需要你检查；详细变化保留在本轮回执。' : '结果已核对；详细变化保留在本轮回执。',
    categoryLabel: needsReview ? '需要检查' : '完成',
    scopeLabel: '当前任务',
    durationMs: null,
    sourceItemId: item.id
  }
}

function terminalStage(turn: AgentTurn): AgentExecutionStage {
  const completed = COMPLETED_TURN_STATUSES.has(turn.status)
  const cancelled = turn.status === 'cancelled' || turn.status === 'interrupted'
  const limited = turn.status === 'blocked' || turn.status === 'budget_limited' || turn.status === 'usage_limited'
  return {
    id: `${turn.id}-terminal`,
    kind: 'assessment',
    state: completed ? 'completed' : cancelled ? 'cancelled' : limited ? 'waiting' : 'failed',
    label: turn.status === 'needs_user_review' ? '操作已结束，结果待复核' : completed ? '本轮操作已完成' : cancelled ? '本轮已停止' : limited ? '本轮需要处理' : '本轮未完成',
    detail: completed
      ? '已完成的修改与结果都保留在当前作品中。'
      : cancelled
        ? '已完成内容保留，未开始的步骤不会继续。'
        : limited
          ? '流程已在预算、权限或产品边界前停止。'
          : '画布保持在最后一次可验证状态。',
    categoryLabel: completed ? '完成' : '状态',
    scopeLabel: '当前任务',
    durationMs: null,
    sourceItemId: null
  }
}

function flowState(turn: AgentTurn): AgentExecutionStageState {
  if (COMPLETED_TURN_STATUSES.has(turn.status)) return 'completed'
  if (turn.status === 'waiting_decision' || turn.status === 'waiting_job' || turn.status === 'blocked' || turn.status === 'budget_limited' || turn.status === 'usage_limited') return 'waiting'
  if (turn.status === 'failed') return 'failed'
  if (turn.status === 'cancelled' || turn.status === 'interrupted') return 'cancelled'
  if (turn.status === 'queued') return 'queued'
  return 'running'
}

function isTimeout(turn: AgentTurn): boolean {
  return /TIME(?:D)?_?OUT/i.test(turn.errorCode ?? '')
}

function flowCopy(
  turn: AgentTurn,
  timeout: boolean,
  latestProvider: AgentProviderAttemptEventV1 | null
): Pick<AgentExecutionFlow, 'headline' | 'summary' | 'statusLabel'> {
  if (turn.errorCode === 'BUDGET_WALL_TIME') return { headline: '本轮时限已到', statusLabel: '已停止',
    summary: '后续操作已停止，已完成的作品保留。已提交图片继续受原任务时限约束，可在生成页查看或停止。' }
  if (turn.errorCode === 'TURN_TIME_UNVERIFIED') return { headline: '原任务时限待核对', statusLabel: '已停止', summary: '旧任务没有可核对的时限，未补一段新的执行时间。现有作品仍可查看。' }
  if (timeout) {
    return {
      headline: '规划未完成',
      summary: '文字模型在设定时间内没有返回可验证方案。画布没有修改，原要求已保留。',
      statusLabel: '已超时'
    }
  }
  if (turn.status === 'planning' && latestProvider?.phase === 'connecting') return { headline: '正在连接文字模型', summary: '请求已经预留并发送，尚未收到响应头。', statusLabel: '连接中' }
  if (turn.status === 'planning' && latestProvider?.phase === 'headers') return { headline: '等待首个响应', summary: '连接已经建立，参数完整前不会执行任何工具。', statusLabel: '等待响应' }
  if (turn.status === 'planning' && (latestProvider?.phase === 'first_event' || latestProvider?.phase === 'receiving')) return { headline: '正在接收创作方案', summary: '已经收到真实模型事件，正在等待完整、可校验的操作。', statusLabel: '接收中' }
  if (turn.status === 'planning') return { headline: '正在形成创作方案', summary: '等待文字模型返回可验证的下一步。', statusLabel: '规划中' }
  if (turn.status === 'building_context') return { headline: '正在准备作品上下文', summary: '只整理这次创作需要的画布与项目信息。', statusLabel: '准备中' }
  if (turn.status === 'running') return { headline: '正在处理当前作品', summary: '工具调用与画布变化会在这里逐项出现。', statusLabel: '执行中' }
  if (turn.status === 'waiting_decision') return { headline: '需要你的决定', summary: 'Agent 已停在确认边界，不会自行越过。', statusLabel: '等待决定' }
  if (turn.status === 'waiting_job') return { headline: '正在等待图片结果', summary: '图片任务已经创建；不会重复提交未知请求。', statusLabel: '等待图片' }
  if (COMPLETED_TURN_STATUSES.has(turn.status)) {
    return {
      headline: turn.status === 'needs_user_review' ? '结果等待检查' : '本轮已完成',
      summary: turn.status === 'needs_user_review' ? '可验证操作已停止，详细结果等待你检查。' : '本轮可验证操作已经完成，详细变化保留在操作回执。',
      statusLabel: turn.status === 'needs_user_review' ? '待检查' : '已完成'
    }
  }
  if (turn.status === 'cancelled' || turn.status === 'interrupted') return { headline: '本轮已停止', summary: '已完成内容保留，未开始的步骤不会继续。', statusLabel: '已停止' }
  if (turn.status === 'budget_limited' || turn.status === 'usage_limited' || turn.status === 'blocked') return { headline: '本轮需要处理', summary: 'Agent 已在明确边界前停止，等待你的决定。', statusLabel: '需要处理' }
  if (turn.status === 'failed') return { headline: '本轮未完成', summary: '画布保持在最后一次可验证状态，原要求可恢复。', statusLabel: '未完成' }
  return { headline: '要求已进入队列', summary: 'Agent 将按顺序开始处理。', statusLabel: '排队中' }
}

export function projectAgentExecutionFlow(
  snapshot: AgentHarnessSnapshot | null,
  turnId: string | null,
  nowMs = Date.now(),
  options: ProjectionOptions = {}
): AgentExecutionFlow | null {
  if (snapshot === null || turnId === null) return null
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId)
  if (turn === undefined) return null
  const items = snapshot.items.filter((item) => item.turnId === turn.id).sort((left, right) => left.ordinal - right.ordinal)
  const finalAssessment = items.filter((item) => item.type === 'completion_assessment').at(-1)
  const facts = completionFactsSchema.safeParse(finalAssessment === undefined ? undefined : itemPayload(finalAssessment)?.facts)
  if (COMPLETED_TURN_STATUSES.has(turn.status) && turn.toolCallsUsed === 0 && facts.success && facts.data.operationStatus === 'not_requested') return null
  const planItems = items.filter((item) => item.type === 'plan')
  const results = items.filter((item) => item.type === 'tool_result')
  const active = ACTIVE_TURN_STATUSES.has(turn.status)
  const turnStart = Date.parse(turn.createdAt)
  const turnEnd = active ? nowMs : Date.parse(turn.completedAt ?? turn.updatedAt)
  const elapsedMs = Number.isFinite(turnStart) && Number.isFinite(turnEnd) ? Math.max(0, turnEnd - turnStart) : 0
  const observableEvents = (options.events ?? []).filter((event) => event.turnId === turn.id)
  const parsedProviderEvents = observableEvents.flatMap((event) => {
    const parsed = parseAgentObservableEvent(event.type, event.payload)
    return parsed !== null && parsed.type.startsWith('provider.attempt.') ? [parsed.payload as AgentProviderAttemptEventV1] : []
  })
  const latestProvider = parsedProviderEvents.at(-1) ?? null
  const latestProgressAt = Math.max(
    Date.parse(turn.updatedAt),
    ...observableEvents.map((event) => Date.parse(event.createdAt)).filter(Number.isFinite),
    ...items.map((item) => Date.parse(item.updatedAt)).filter(Number.isFinite)
  )
  const lastProgressAgeMs = active && Number.isFinite(latestProgressAt) ? Math.max(0, nowMs - latestProgressAt) : 0
  const timeout = isTimeout(turn)
  const stallLevel: AgentExecutionStallLevel = timeout
    ? 'terminal'
    : turn.status !== 'planning'
      ? 'normal'
      : lastProgressAgeMs >= 30_000
        ? 'long'
        : lastProgressAgeMs >= 12_000
          ? 'slow'
          : 'normal'
  const stages = fixedStages(turn, planItems.length > 0, items.some((item) => item.type === 'tool_call'), elapsedMs, stallLevel)
    .filter((stage) => latestProvider === null || stage.kind !== 'planning')
  const eventTimes = new Map(observableEvents.flatMap((event) => ['provider-', 'validation-', 'recovery-event-']
    .map((prefix) => [prefix + event.id, Date.parse(event.createdAt)] as const)))
  const itemTimes = new Map(items.map((item) => [item.id, Date.parse(item.createdAt)] as const))
  const stageTime = (stage: AgentExecutionStage): number => eventTimes.get(stage.id)
    ?? (stage.sourceItemId === null ? undefined : itemTimes.get(stage.sourceItemId)) ?? 0
  stages.push(...[...eventStages(observableEvents), ...observableStages(items, results)]
    .sort((left, right) => stageTime(left) - stageTime(right)))
  const assessment = items.filter((item) => item.type === 'completion_assessment').at(-1)
  if (assessment === undefined && !ACTIVE_TURN_STATUSES.has(turn.status)) stages.push(terminalStage(turn))
  stages.push(...supplementalActivityStages(options.activities ?? []))

  // A stopped turn cannot retain a live marker if interruption happened before
  // its matching lifecycle event was durably recorded. Never infer success.
  if (!active) {
    stages.forEach((stage, index) => {
      if (stage.state === 'running') stages[index] = {
        ...stage, state: 'cancelled', detail: '本轮已经结束；此阶段未记录成功终态，不会继续执行。'
      }
    })
  }

  const limit = options.expanded === true ? 24 : 6
  const visibleStages = stages.length > limit ? stages.slice(-limit) : stages
  const copy = flowCopy(turn, timeout, latestProvider)
  const latestLifecycle = observableEvents.flatMap((event) => {
    const parsed = parseAgentObservableEvent(event.type, event.payload)
    return parsed === null ? [] : [parsed]
  }).at(-1)
  if (turn.status === 'planning' && latestLifecycle?.type === 'plan.validation.started') {
    Object.assign(copy, { headline: '正在校验创作方案', summary: '正在核对操作范围、元素身份与画布版本。', statusLabel: '校验中' })
  } else if (active && latestLifecycle?.type === 'recovery.started') {
    const recovery = latestLifecycle.payload as AgentRecoveryLifecycleEventV1
    Object.assign(copy, { headline: '正在修正可恢复问题', summary: `原请求已返回，正在修正工具调用 ${recovery.attempt}/${recovery.maxAttempts}；已完成的画布操作不会重放。`, statusLabel: '修正中' })
  }
  const budget = snapshot.activeGoal?.id === turn.goalId ? snapshot.activeGoal.budget : null
  const timeLimitMs = turn.timeLimitMs === undefined ? budget?.maxWallTimeMs ?? null : turn.timeLimitMs
  const remainingWallTimeMs = timeLimitMs === null ? null : Math.max(0, timeLimitMs - elapsedMs)
  return {
    turnId: turn.id,
    state: flowState(turn),
    ...copy,
    stallLevel,
    elapsedMs,
    lastProgressAgeMs,
    remainingWallTimeMs,
    timeLimitMs,
    providerSummary: latestProvider === null
      ? null
      : `${latestProvider.providerLabel} · ${latestProvider.protocol} · ${latestProvider.model}`,
    stages: visibleStages,
    totalStageCount: stages.length,
    hiddenStageCount: Math.max(0, stages.length - visibleStages.length),
    canCancel: ACTIVE_TURN_STATUSES.has(turn.status),
    canRestoreRequest: timeout || turn.status === 'failed' || turn.status === 'cancelled' || turn.status === 'interrupted' || turn.errorCode === 'BUDGET_WALL_TIME' || turn.errorCode === 'TURN_TIME_UNVERIFIED'
  }
}
