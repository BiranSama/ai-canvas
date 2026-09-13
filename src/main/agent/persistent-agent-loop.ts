import { randomUUID } from 'node:crypto'
import { assessHonestCompletion, explicitAspectRevision } from './completion-facts'
import type { AgentPlan, AgentRequest, AgentToolOutcome, AgentToolPlan } from '../../shared/agent'
import {
  DEFAULT_AUTO_BUDGET,
  DEFAULT_COLLABORATION_BUDGET,
  DEFAULT_REVIEW_BUDGET,
  normalizeAgentTaskInput,
  isTerminalAgentTurnStatus,
  plannerStepSchema,
  type AgentCompletionAssessment,
  type AgentDecisionProposal,
  type AgentEvent,
  type AgentGoalContract,
  type AgentHarnessSnapshot,
  type AgentItem,
  type AgentMode,
  type AgentRunBudget,
  type AgentThread,
  type AgentTurn,
  type AgentTurnInput,
  type AgentTaskInput,
  type AgentTurnStatus,
  type DispatchMode,
  type TaskRelation,
  type TurnInputMode
} from '../../shared/agent-harness'
import type { ContextCompaction, ContextManifest } from '../../shared/agent-context'
import { isTerminalGenerationJobStatus, type GenerationJob } from '../../shared/generation'
import { isAutomaticAgentRecovery, normalizeAgentFailureEnvelope, type AgentFailureEnvelope } from '../../shared/agent-recovery'
import { ownerFullPermissionProfile } from './agent-tool-policy'
import { GenerationPolicy } from './generation-policy'
import type { AgentContextRepository } from './agent-context-repository'
import type { AgentHarnessRepository } from './agent-harness-repository'
import {
  ContextBuilder,
  ContextCompactor,
  RECENT_CONVERSATION_ITEM_LIMIT,
  contextSourceHash,
  type DirectiveConflict
} from './context-builder'
import type { PlannerAdapter } from './planner-adapter'
import type { GenerationWorkflowRepository } from '../generation/generation-workflow-repository'
import { createAgentFailureEnvelope } from './agent-failure'
import type { AgentObservableEvent, AgentRecoveryLifecycleEventV1 } from '../../shared/agent-observability'

function surfacedFailureCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return fallback
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(error.code) ? error.code : fallback
}

function providerAttemptIdFrom(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('providerAttemptId' in error) || typeof error.providerAttemptId !== 'string') return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(error.providerAttemptId)
    ? error.providerAttemptId
    : null
}

class AgentLoopControlError extends Error {
  readonly kind: 'interrupt' | 'replan'

  constructor(kind: AgentLoopControlError['kind']) {
    super(kind === 'interrupt' ? 'The current agent turn was interrupted.' : 'The current agent plan was superseded.')
    this.name = 'AgentLoopControlError'
    this.kind = kind
  }
}

export interface AgentLoopToolContext {
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly legacyRunId: string
  readonly sourceMessageId: string
  readonly contextManifestId: string | null
  readonly toolCallItemId: string
  readonly toolCallOrdinal: number
  readonly toolIndex: number
  /** Correlates the model attempt that authored this tool with outbound audit and terminal diagnostics. */
  readonly requestCorrelationId: string | null
  /** Stable persisted Agent Item that explicitly approved this step, when one was required. */
  readonly approvalId: string | null
  readonly sceneWritesBefore: number
  /** Frozen plan baseline advanced only by that plan's committed receipts. */
  readonly expectedSceneRevision?: number | null
  readonly request: AgentRequest
  readonly signal: AbortSignal
}

export interface AgentLoopProjection {
  onPlanningStarted?(input: { readonly turn: AgentTurn; readonly legacyRunId: string; readonly request: AgentRequest }): Promise<void>
  onPlanReady?(input: { readonly turn: AgentTurn; readonly legacyRunId: string; readonly request: AgentRequest; readonly plan: AgentPlan }): Promise<void>
  onDecisionWaiting?(input: {
    readonly turn: AgentTurn
    readonly legacyRunId: string
    readonly item: AgentItem
    readonly proposal: AgentDecisionProposal
  }): Promise<void>
  onDecisionResolved?(input: { readonly legacyRunId: string; readonly proposal: AgentDecisionProposal; readonly optionId: string }): Promise<void>
  onToolStarted?(input: { readonly legacyRunId: string; readonly toolIndex: number; readonly tool: AgentToolPlan }): Promise<void>
  onToolFinished?(input: { readonly legacyRunId: string; readonly outcome: AgentToolOutcome }): Promise<void>
  onCompleted?(input: {
    readonly turn: AgentTurn
    readonly legacyRunId: string
    readonly plan: AgentPlan | null
    readonly outcomes: readonly AgentToolOutcome[]
    readonly assessment: AgentCompletionAssessment
  }): Promise<void>
  onTerminal?(input: {
    readonly turn: AgentTurn
    readonly legacyRunId: string
    readonly status: AgentTurnStatus
    readonly code: string
    readonly message: string
  }): Promise<void>
}

export interface PersistentAgentLoopOptions {
  readonly projectId: string
  readonly repository: AgentHarnessRepository
  readonly contextRepository?: AgentContextRepository
  readonly contextBuilder?: ContextBuilder
  readonly allowedTools?: readonly string[]
  readonly planner: PlannerAdapter
  readonly executeTool: (tool: AgentToolPlan, context: AgentLoopToolContext) => Promise<AgentToolOutcome>
  readonly loadRequest: (legacyRunId: string) => Promise<AgentRequest>
  readonly refreshRequest?: (request: AgentRequest) => Promise<AgentRequest>
  readonly generationWorkflowRepository?: GenerationWorkflowRepository
  readonly loadGenerationJob?: (jobId: string) => Promise<GenerationJob>
  readonly activateGenerationJob?: (jobId: string) => Promise<void>
  readonly projection?: AgentLoopProjection
  readonly generationPolicy?: GenerationPolicy
  readonly budget?: AgentRunBudget
  readonly permissionProfileId?: string
  readonly providerIds?: readonly string[]
  readonly now?: () => string
}

interface StartInput {
  readonly legacyRunId: string
  readonly sourceMessageId: string
  readonly request: AgentRequest
  readonly mode?: AgentMode
  readonly queueEntryId?: string | null
  readonly taskId?: string | null
  readonly taskRelation?: TaskRelation
  readonly dispatchMode?: DispatchMode
  readonly baseTaskId?: string | null
}

interface StoredUserInput {
  readonly legacyRunId: string
  readonly sourceMessageId: string
  readonly mode: TurnInputMode | 'start'
  readonly taskRelation: TaskRelation
  readonly dispatchMode: DispatchMode
  readonly request: AgentRequest
}

interface StoredPlanItem {
  readonly legacyRunId: string
  readonly contextOrdinal: number
  readonly stepIndex: number
  readonly plan: AgentPlan | null
  readonly step: unknown
  readonly requestCorrelationId?: string | null
  readonly sceneRevision?: number
}

interface StoredToolResult {
  readonly planItemId: string
  readonly toolCallItemId: string
  readonly tool: AgentToolPlan
  readonly outcome: AgentToolOutcome
}

interface StoredRecovery {
  readonly code: string
  readonly message: string
  readonly request: AgentRequest
  readonly failure?: AgentFailureEnvelope
}

interface StoredDecisionPayload {
  readonly proposal: AgentDecisionProposal
  readonly planItemId: string | null
  readonly toolIndex?: number
  readonly optionId?: string
  readonly contextConflict?: DirectiveConflict
}

interface StoredGenerationSubscription {
  readonly subscriptionId: string | null
  readonly intentId: string
  readonly jobId: string
  readonly toolCallItemId: string | null
  readonly toolIndex: number | null
  readonly lastJobStatus: GenerationJob['status']
  readonly observedAt: string | null
}

const LOCAL_READ_TOOL_KINDS = new Set<AgentToolPlan['kind']>(['scene.get_summary', 'scene.get_elements'])
const TRANSIENT_LOCAL_READ_CODES = new Set(['TOOL_READ_TRANSIENT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'EBUSY'])

function payload<T>(item: AgentItem): T {
  return item.payload as T
}

function isTransientLocalReadFailure(tool: AgentToolPlan, error: unknown): boolean {
  if (!LOCAL_READ_TOOL_KINDS.has(tool.kind)) return false
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return false
  return TRANSIENT_LOCAL_READ_CODES.has(error.code)
}

function recoveryCount(items: readonly AgentItem[], retryClass: AgentFailureEnvelope['retryClass']): number {
  return items.filter((item) => {
    if (item.type !== 'recovery' || item.status !== 'completed') return false
    return payload<StoredRecovery>(item).failure?.retryClass === retryClass
  }).length
}

function recoveryLifecyclePayload(
  failureValue: AgentFailureEnvelope,
  requestCorrelationId: string | null,
  occurredAt: string
): AgentRecoveryLifecycleEventV1 {
  const failure = normalizeAgentFailureEnvelope(failureValue)
  return {
    schemaVersion: 1,
    requestCorrelationId,
    failureId: failure.failureId,
    fingerprint: failure.fingerprint,
    attempt: failure.attempt,
    maxAttempts: failure.maxAttempts,
    occurredAt,
    failureCode: failure.code,
    failure: {
      phase: failure.phase,
      category: failure.category,
      retryClass: failure.retryClass,
      externalState: failure.externalState,
      replacementScope: failure.replacementScope,
      allowedActions: [...failure.allowedActions],
      completedToolIndexes: [...failure.completedToolIndexes],
      failedToolIndex: failure.failedToolIndex,
      unstartedToolIndexes: [...failure.unstartedToolIndexes],
      remainingModelTurns: failure.remainingModelTurns,
      remainingRecoveryAttempts: failure.remainingRecoveryAttempts,
      remainingWallTimeMs: failure.remainingWallTimeMs,
      remainingCostCny: failure.remainingCostCny
    }
  }
}

function applyContextConflictResolutions(request: AgentRequest, items: readonly AgentItem[]): {
  readonly request: AgentRequest
  readonly resolvedDirectiveIds: readonly string[]
} {
  let effective = request
  const resolvedDirectiveIds: string[] = []
  for (const item of items.filter((candidate) => candidate.type === 'decision' && candidate.status === 'completed')) {
    const stored = payload<StoredDecisionPayload>(item)
    const conflict = stored.contextConflict
    if (conflict === undefined || stored.optionId === undefined) continue
    resolvedDirectiveIds.push(conflict.directiveId)
    if (stored.optionId !== 'follow_directive') continue
    if (conflict.kind === 'aspect_ratio') {
      const ratio = conflict.directiveText.match(/\b(\d{1,3})\s*[:：/]\s*(\d{1,3})\b/)
      if (ratio !== null) {
        effective = {
          ...effective,
          text: `${conflict.directiveText}\n\n本轮其余要求：${effective.text.replace(/\b\d{1,3}\s*[:：/]\s*\d{1,3}\b/g, `${Number(ratio[1])}:${Number(ratio[2])}`)}`
        }
      }
      continue
    }
    if (conflict.kind === 'generation') {
      effective = {
        ...effective,
        autoGenerate: false,
        text: `${conflict.directiveText}\n本轮只完成本地画布工作，不创建生成任务。\n其余要求：${effective.text}`
      }
      continue
    }
    effective = { ...effective, text: `${conflict.directiveText}\n本轮以该项目规则为准。\n其余要求：${effective.text}` }
  }
  return { request: effective, resolvedDirectiveIds }
}

function decisionForContextConflict(conflict: DirectiveConflict): AgentDecisionProposal {
  return {
    kind: 'clarification',
    title: '本轮要求与项目规则冲突',
    consequence: conflict.explanation,
    options: [
      { id: 'follow_request', label: '以本轮要求为准', consequence: '只在本轮覆盖这条项目规则，不修改长期规则。' },
      { id: 'follow_directive', label: '遵守项目规则', consequence: '保留长期规则，并按它调整本轮执行。' }
    ],
    defaultOptionId: 'follow_request'
  }
}

function isGenerationTool(tool: AgentToolPlan): boolean {
  return tool.kind === 'generation' || tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit'
}

function plannedImageCount(tool: AgentToolPlan): number {
  if (tool.kind === 'generation') return tool.request.count
  if (tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit') return tool.count
  return 0
}

function designMemoryContent(plan: AgentPlan): string | null {
  const contract = plan.designContract
  if (contract === undefined) return null
  const direction = contract.directions.find((candidate) => candidate.id === contract.selectedDirectionId)
  if (direction === undefined) return null
  const lines = [
    `设计方向：${direction.title}`,
    `构图：${direction.composition}`,
    `主体：${direction.subject}`,
    `文字：${direction.typography}`,
    `色彩：${direction.palette.join('、')}`,
    `光影：${direction.lighting}`,
    ...(contract.brief.keep.length === 0 ? [] : [`继续保持：${contract.brief.keep.join('；')}`])
  ]
  return lines.join('\n').slice(0, 4_000)
}

function storedTaskRelation(input: StoredUserInput): TaskRelation {
  if (input.taskRelation !== undefined) return input.taskRelation
  if (input.mode === 'correct_current') return 'revise_current'
  if (input.mode === 'append_current') return 'supplement_current'
  if (input.mode === 'queue_next') return 'continue_current'
  return 'continue_current'
}

function taskScopedItems(items: readonly AgentItem[], turns: readonly AgentTurn[], turn: AgentTurn): readonly AgentItem[] {
  if (turn.taskId === null) return items
  const allowedTaskIds = new Set([turn.taskId])
  if (turn.taskRelation === 'temporary_try' && turn.baseTaskId !== null) allowedTaskIds.add(turn.baseTaskId)
  const allowedTurnIds = new Set(turns
    .filter((candidate) => candidate.taskId !== null && allowedTaskIds.has(candidate.taskId))
    .map((candidate) => candidate.id))
  return items.filter((item) => allowedTurnIds.has(item.turnId))
}

function isTemporaryPersistentTool(tool: AgentToolPlan): boolean {
  return isSceneWriteTool(tool)
    || tool.kind === 'directive_create'
    || tool.kind === 'memory_candidate'
    || tool.kind === 'place_generation_result'
    || tool.kind === 'result.place_on_canvas'
    || tool.kind === 'history.undo_batch'
}

type SceneWriteTool = Extract<AgentToolPlan, {
  kind: 'scene_batch' | 'scene.set_canvas' | 'scene.create_elements' | 'scene.update_elements' | 'scene.reorder_elements' | 'scene.group_elements' | 'scene.remove_elements'
}>

function isSceneWriteTool(tool: AgentToolPlan): tool is SceneWriteTool {
  return tool.kind === 'scene_batch'
    || tool.kind === 'scene.set_canvas'
    || tool.kind === 'scene.create_elements'
    || tool.kind === 'scene.update_elements'
    || tool.kind === 'scene.reorder_elements'
    || tool.kind === 'scene.group_elements'
    || tool.kind === 'scene.remove_elements'
}

function isSceneMutationTool(tool: AgentToolPlan): boolean {
  return isSceneWriteTool(tool)
    || tool.kind === 'history.undo_batch'
    || tool.kind === 'place_generation_result'
    || tool.kind === 'result.place_on_canvas'
}

function compatibilityMode(input: AgentTaskInput): TurnInputMode {
  if (input.dispatchMode === 'interrupt_current') return 'interrupt_now'
  if (input.dispatchMode === 'queue_after_current') return 'queue_next'
  if (input.taskRelation === 'supplement_current') return 'append_current'
  return 'correct_current'
}

function mergeInputs(items: readonly AgentItem[]): {
  readonly request: AgentRequest
  readonly sourceMessageId: string
  readonly barrierOrdinal: number
  readonly pendingIds: readonly string[]
} {
  const userItems = items.filter((item) => item.type === 'user_message')
  const initial = userItems.find((item) => payload<StoredUserInput>(item).mode === 'start')
  if (initial === undefined) throw new Error('Agent turn has no persisted initial request.')
  const incorporated = userItems.filter((item) => payload<StoredUserInput>(item).mode !== 'interrupt_now'
    && payload<StoredUserInput>(item).mode !== 'queue_next')
  const latest = incorporated.at(-1) ?? initial
  const base = payload<StoredUserInput>(initial).request
  const newest = payload<StoredUserInput>(latest).request
  const additions = incorporated.slice(1).map((item) => {
    const stored = payload<StoredUserInput>(item)
    const relation = storedTaskRelation(stored)
    const label = relation === 'revise_current'
      ? '修正'
      : relation === 'supplement_current'
        ? '补充'
        : '继续'
    return `${label}：${stored.request.text}`
  })
  let request = {
    ...newest,
    text: additions.length === 0 ? base.text : `${base.text}\n\n本任务后续要求：\n${additions.join('\n')}`
  }
  const recovery = items.filter((item) => {
    if (item.type !== 'recovery') return false
    const failure = payload<StoredRecovery>(item).failure
    return failure === undefined || failure.retryClass !== 'local_retry'
  }).at(-1)
  const recoveryOrdinal = recovery?.ordinal ?? -1
  if (recovery !== undefined && recoveryOrdinal > latest.ordinal) {
    const recoveredRequest = payload<{ readonly request?: AgentRequest }>(recovery).request
    if (recoveredRequest !== undefined) request = { ...recoveredRequest, text: request.text }
  }
  const sceneChange = items.filter((item) => item.type === 'scene_change').at(-1)
  if (sceneChange !== undefined && sceneChange.ordinal > latest.ordinal) {
    const refreshedRequest = payload<{ readonly request?: AgentRequest }>(sceneChange).request
    if (refreshedRequest !== undefined) request = { ...refreshedRequest, text: request.text }
  }
  return {
    request,
    sourceMessageId: payload<StoredUserInput>(initial).sourceMessageId,
    barrierOrdinal: Math.max(latest.ordinal, recoveryOrdinal),
    pendingIds: incorporated.filter((item) => item.status === 'queued').map((item) => item.id)
  }
}

function decisionFor(request: AgentRequest, plan: AgentPlan, generationPolicy: GenerationPolicy): AgentDecisionProposal | null {
  const hasExplicitAspect = /\d{1,3}\s*[:：]\s*\d{1,3}/.test(request.text)
  const plannedAspect = plan.tools.flatMap((tool) => tool.kind === 'scene_batch'
    ? tool.commands.filter((command) => command.kind === 'scene.set-canvas')
    : tool.kind === 'scene.set_canvas' ? [{ kind: 'scene.set-canvas' as const, canvas: tool.canvas }] : [])[0]
  if (plannedAspect !== undefined && !hasExplicitAspect) {
    const defaultRatio = `${plannedAspect.canvas.aspectWidth}:${plannedAspect.canvas.aspectHeight}`
    const options = [
      { id: defaultRatio, label: `${defaultRatio} · 推荐`, consequence: '采用规划器为当前内容选择的纵横方向' },
      { id: '1:1', label: '1:1 · 方形', consequence: '更适合封面与头像式构图' },
      { id: '3:2', label: '3:2 · 横向', consequence: '获得更宽的叙事与环境空间' }
    ].filter((option, index, candidates) => candidates.findIndex((candidate) => candidate.id === option.id) === index)
    return {
      kind: 'aspect_ratio',
      title: '这张作品使用什么比例？',
      consequence: '比例会决定画布尺寸和所有语义元素的构图基准；确认前不会改动作品。',
      options,
      defaultOptionId: defaultRatio
    }
  }
  if (generationPolicy.requiresConfirmation(request, plan)) {
    return {
      kind: 'generation_confirmation',
      title: '要现在生成图片吗？',
      consequence: '确认后创建受当前 Provider 与费用策略约束的图片任务；保留画布则不会进入队列。',
      options: [
        { id: 'generate', label: '开始生成', consequence: '创建图片生成任务' },
        { id: 'keep_canvas', label: '先保留画布', consequence: '停止本轮，不创建生成任务' }
      ],
      defaultOptionId: 'generate'
    }
  }
  return null
}

function reviewDecisionFor(tool: AgentToolPlan): AgentDecisionProposal {
  const label = isSceneWriteTool(tool)
    ? tool.summary
    : tool.kind === 'cancel_generation'
      ? '停止当前生成任务'
      : tool.kind === 'memory_candidate'
        ? '提出项目记忆候选'
        : tool.kind === 'directive_create'
          ? '写入项目规则'
          : tool.kind === 'place_generation_result' || tool.kind === 'result.place_on_canvas'
            ? '将生成结果放入画布'
          : '创建图片生成任务'
  return {
    kind: 'clarification',
    title: '先确认这项修改',
    consequence: `${label}。审阅模式不会在你确认前执行任何写入。`,
    options: [
      { id: 'apply_once', label: '执行这一步', consequence: '只批准当前这一个工具步骤；后续写入仍会再次询问。' },
      { id: 'stop', label: '先停在这里', consequence: '保留现状并结束本轮，不执行该步骤。' }
    ],
    defaultOptionId: 'stop'
  }
}

function hasReviewApproval(items: readonly AgentItem[], toolIndex: number, barrierOrdinal: number): boolean {
  return items.some((item) => {
    if (item.type !== 'decision' || item.status !== 'completed' || item.ordinal <= barrierOrdinal) return false
    const stored = payload<StoredDecisionPayload>(item)
    return stored.toolIndex === toolIndex && stored.optionId === 'apply_once'
  })
}

function executionApprovalId(
  items: readonly AgentItem[],
  toolIndex: number,
  planItemId: string,
  barrierOrdinal: number
): string | null {
  return items
    .filter((item) => item.type === 'decision' && item.status === 'completed' && item.ordinal > barrierOrdinal)
    .sort((left, right) => right.ordinal - left.ordinal)
    .find((item) => {
      const stored = payload<StoredDecisionPayload>(item)
      const reviewApproval = stored.toolIndex === toolIndex && stored.optionId === 'apply_once'
      const generationApproval = stored.planItemId === planItemId
        && stored.proposal.kind === 'generation_confirmation'
        && stored.optionId === 'generate'
      return reviewApproval || generationApproval
    })?.id ?? null
}

function explicitlyApprovedGenerationBudget(
  items: readonly AgentItem[],
  barrierOrdinal: number
): { readonly jobs: number; readonly images: number } {
  const plans = new Map(items.filter((item) => item.type === 'plan').map((item) => [item.id, item]))
  let jobs = 0
  let images = 0
  for (const item of items) {
    if (item.type !== 'decision' || item.status !== 'completed' || item.ordinal <= barrierOrdinal) continue
    const stored = payload<StoredDecisionPayload>(item)
    if (stored.proposal.kind !== 'generation_confirmation' || stored.optionId !== 'generate' || stored.planItemId === null) continue
    const planItem = plans.get(stored.planItemId)
    if (planItem === undefined) continue
    const plan = payload<StoredPlanItem>(planItem).plan
    if (plan === null) continue
    const generationTools = plan.tools.filter(isGenerationTool)
    jobs += generationTools.length
    images += generationTools.reduce((sum, tool) => sum + plannedImageCount(tool), 0)
  }
  return { jobs, images }
}

function planGenerationBudget(plan: AgentPlan | null): { readonly jobs: number; readonly images: number } {
  if (plan === null) return { jobs: 0, images: 0 }
  const generationTools = plan.tools.filter(isGenerationTool)
  return {
    jobs: generationTools.length,
    images: generationTools.reduce((sum, tool) => sum + plannedImageCount(tool), 0)
  }
}

function resizePlan(plan: AgentPlan, optionId: string): AgentPlan {
  const match = optionId.match(/^(\d{1,3}):(\d{1,3})$/)
  if (match === null) return plan
  const aspectWidth = Number(match[1])
  const aspectHeight = Number(match[2])
  const longEdge = 1280
  const outputWidth = aspectWidth >= aspectHeight ? longEdge : Math.round(longEdge * aspectWidth / aspectHeight)
  const outputHeight = aspectWidth >= aspectHeight ? Math.round(longEdge * aspectHeight / aspectWidth) : longEdge
  return {
    ...plan,
    tools: plan.tools.map((tool) => tool.kind === 'scene_batch' ? {
      ...tool,
      commands: tool.commands.map((command) => command.kind !== 'scene.set-canvas' ? command : {
        ...command,
        canvas: { ...command.canvas, aspectWidth, aspectHeight, outputWidth, outputHeight }
      })
    } : tool.kind === 'scene.set_canvas' ? {
      ...tool,
      canvas: { ...tool.canvas, aspectWidth, aspectHeight, outputWidth, outputHeight }
    } : tool)
  }
}

export class PersistentAgentLoop {
  readonly #projectId: string
  readonly #repository: AgentHarnessRepository
  readonly #contextRepository: AgentContextRepository | null
  readonly #contextBuilder: ContextBuilder
  readonly #contextCompactor: ContextCompactor
  readonly #allowedTools: readonly string[]
  readonly #planner: PlannerAdapter
  readonly #executeTool: PersistentAgentLoopOptions['executeTool']
  readonly #loadRequest: PersistentAgentLoopOptions['loadRequest']
  readonly #refreshRequest: NonNullable<PersistentAgentLoopOptions['refreshRequest']>
  readonly #generationWorkflowRepository: GenerationWorkflowRepository | null
  readonly #loadGenerationJob: ((jobId: string) => Promise<GenerationJob>) | null
  readonly #activateGenerationJob: ((jobId: string) => Promise<void>) | null
  readonly #projection: AgentLoopProjection
  readonly #generationPolicy: GenerationPolicy
  readonly #budget: AgentRunBudget
  readonly #budgetOverride: AgentRunBudget | null
  readonly #permissionProfileId: string
  readonly #providerIds: readonly string[]
  readonly #now: () => string
  readonly #listeners = new Set<(event: AgentEvent) => void>()
  readonly #eventCursors = new Map<string, number>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #tasks = new Map<string, Promise<void>>()
  readonly #turnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #deadlineTasks = new Set<Promise<void>>()
  readonly #rerun = new Set<string>()
  #thread: AgentThread | null = null
  #closed = false

  constructor(options: PersistentAgentLoopOptions) {
    this.#projectId = options.projectId
    this.#repository = options.repository
    this.#contextRepository = options.contextRepository ?? null
    this.#contextBuilder = options.contextBuilder ?? new ContextBuilder()
    this.#contextCompactor = new ContextCompactor()
    this.#allowedTools = [...(options.allowedTools ?? [
      'scene.get_summary', 'scene.get_elements', 'assets.get_metadata', 'generation.get_jobs',
      'generation.get_results', 'capability.load', 'scene.apply_batch', 'scene.set_canvas',
      'scene.create_elements', 'scene.update_elements', 'scene.reorder_elements',
      'scene.group_elements', 'scene.remove_elements', 'history.undo_batch', 'result.place_on_canvas'
    ])]
    this.#planner = options.planner
    this.#executeTool = options.executeTool
    this.#loadRequest = options.loadRequest
    this.#refreshRequest = options.refreshRequest ?? (async (request) => request)
    this.#generationWorkflowRepository = options.generationWorkflowRepository ?? null
    this.#loadGenerationJob = options.loadGenerationJob ?? null
    this.#activateGenerationJob = options.activateGenerationJob ?? null
    this.#projection = options.projection ?? {}
    this.#generationPolicy = options.generationPolicy ?? new GenerationPolicy()
    this.#budgetOverride = options.budget ?? null
    this.#budget = options.budget ?? DEFAULT_AUTO_BUDGET
    this.#permissionProfileId = options.permissionProfileId ?? ownerFullPermissionProfile().id
    this.#providerIds = [...(options.providerIds ?? ['image-provider'])]
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async initialize(): Promise<{ readonly thread: AgentThread; readonly recovered: number }> {
    this.#assertOpen()
    const thread = await this.#repository.ensureThread(this.#projectId)
    this.#thread = thread
    this.#eventCursors.set(thread.id, thread.lastSequence)
    const recovered = await this.#repository.recoverInterrupted(this.#projectId)
    await this.#publish(thread.id)
    if (this.#generationWorkflowRepository !== null && this.#loadGenerationJob !== null) {
      const subscriptions = await this.#generationWorkflowRepository.listSubscriptionsToReconcile(this.#projectId)
      for (const subscription of subscriptions) {
        const job = await this.#loadGenerationJob(subscription.jobId).catch(() => null)
        if (job !== null) await this.observeGenerationJob(job)
      }
    }
    for (const turn of await this.#repository.listTurns(thread.id)) {
      if (!isTerminalAgentTurnStatus(turn.status)) await this.#ensureTurnDeadline(turn)
    }
    return { thread: await this.#repository.getThread(thread.id), recovered }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async snapshot(): Promise<AgentHarnessSnapshot> {
    return this.#repository.getSnapshot((await this.#requireThread()).id)
  }

  async replay(afterSequence: number, limit = 1_000): Promise<readonly AgentEvent[]> {
    return this.#repository.replayEvents((await this.#requireThread()).id, afterSequence, limit)
  }

  async #currentFormalTaskId(threadId: string): Promise<string | null> {
    const turns = await this.#repository.listTurns(threadId)
    for (const turn of turns) {
      if (turn.taskId === null) continue
      if (turn.taskRelation !== 'temporary_try') return turn.taskId
      if (turn.temporaryState === 'accepted') return turn.baseTaskId ?? turn.taskId
    }
    return null
  }

  async #resolveTaskIdentity(threadId: string, relationInput?: TaskRelation, persistedTaskId?: string | null, persistedBaseTaskId?: string | null): Promise<{
    readonly taskId: string
    readonly taskRelation: TaskRelation
    readonly baseTaskId: string | null
  }> {
    const currentTaskId = await this.#currentFormalTaskId(threadId)
    const taskRelation = relationInput ?? (currentTaskId === null ? 'new_task' : 'continue_current')
    if (persistedTaskId !== undefined && persistedTaskId !== null) {
      return { taskId: persistedTaskId, taskRelation, baseTaskId: persistedBaseTaskId ?? null }
    }
    if (taskRelation === 'new_task') return { taskId: randomUUID(), taskRelation, baseTaskId: null }
    if (taskRelation === 'temporary_try') {
      return { taskId: randomUUID(), taskRelation, baseTaskId: persistedBaseTaskId ?? currentTaskId }
    }
    return { taskId: currentTaskId ?? randomUUID(), taskRelation, baseTaskId: null }
  }

  async start(input: StartInput): Promise<AgentTurn> {
    this.#assertOpen()
    const thread = await this.#requireThread()
    const identity = await this.#resolveTaskIdentity(thread.id, input.taskRelation, input.taskId, input.baseTaskId)
    const goal = await this.#createGoal(thread.id, input.request, input.mode ?? 'collaboration')
    const turn = await this.#repository.startTurn(thread.id, {
      goalId: goal.id,
      inputMessageId: input.legacyRunId,
      taskId: identity.taskId,
      taskRelation: identity.taskRelation,
      dispatchMode: input.dispatchMode ?? 'apply_now',
      baseTaskId: identity.baseTaskId,
      temporaryState: identity.taskRelation === 'temporary_try' ? 'pending' : null,
      sceneRevisionAtStart: input.request.sceneSummary.revision
    })
    await this.#repository.appendItem(turn.id, {
      type: 'user_message',
      status: 'completed',
      payloadVersion: 1,
      payload: {
        legacyRunId: input.legacyRunId,
        sourceMessageId: input.sourceMessageId,
        mode: 'start',
        taskRelation: identity.taskRelation,
        dispatchMode: input.dispatchMode ?? 'apply_now',
        request: input.request
      } satisfies StoredUserInput
    })
    if (input.queueEntryId !== undefined && input.queueEntryId !== null) {
      await this.#repository.completeQueueEntry(input.queueEntryId)
    }
    await this.#ensureTurnDeadline(turn)
    await this.#publish(thread.id)
    this.#schedule(turn.id)
    return turn
  }

  async input(inputValue: AgentTurnInput | AgentTaskInput, persistQueuedRun: (request: AgentRequest) => Promise<{ readonly runId: string; readonly sourceMessageId: string }>): Promise<void> {
    this.#assertOpen()
    const input = normalizeAgentTaskInput(inputValue)
    const thread = await this.#requireThread()
    const active = await this.#repository.getActiveTurn(thread.id)
    if (input.dispatchMode === 'interrupt_current') {
      if (active === null) return
      const legacyRunId = active.inputMessageId
      if (legacyRunId === null) throw new Error('Active agent turn has no compatibility run identifier.')
      this.#controllers.get(active.id)?.abort(new AgentLoopControlError('interrupt'))
      await this.#interrupt(active, legacyRunId, 'USER_INTERRUPTED', '用户停止了当前回合。')
      return
    }
    if (input.taskRelation === null) throw new Error('Creative work must have a task relation.')
    if (active === null) {
      const queued = await persistQueuedRun(input.request)
      await this.start({
        legacyRunId: queued.runId,
        sourceMessageId: queued.sourceMessageId,
        request: input.request,
        taskRelation: input.taskRelation,
        dispatchMode: input.dispatchMode
      })
      return
    }
    const legacyRunId = active.inputMessageId
    if (legacyRunId === null) throw new Error('Active agent turn has no compatibility run identifier.')
    if (input.dispatchMode === 'queue_after_current') {
      const queued = await persistQueuedRun(input.request)
      const identity = await this.#resolveTaskIdentity(thread.id, input.taskRelation)
      await this.#repository.appendItem(active.id, {
        type: 'user_message', status: 'completed', payloadVersion: 1,
        payload: {
          legacyRunId: queued.runId,
          sourceMessageId: queued.sourceMessageId,
          mode: 'queue_next',
          taskRelation: input.taskRelation,
          dispatchMode: input.dispatchMode,
          request: input.request
        } satisfies StoredUserInput
      })
      await this.#repository.enqueue(thread.id, {
        messageId: queued.runId,
        mode: 'queue_next',
        taskId: identity.taskId,
        taskRelation: identity.taskRelation,
        dispatchMode: input.dispatchMode,
        baseTaskId: identity.baseTaskId
      })
      await this.#publish(thread.id)
      return
    }
    if (input.taskRelation === 'new_task' || input.taskRelation === 'temporary_try') {
      throw new Error('A new or temporary task must be queued while another task is active.')
    }
    await this.#repository.appendItem(active.id, {
      type: 'user_message',
      status: 'queued',
      payloadVersion: 1,
      payload: {
        legacyRunId,
        sourceMessageId: legacyRunId,
        mode: compatibilityMode(input),
        taskRelation: input.taskRelation,
        dispatchMode: input.dispatchMode,
        request: input.request
      } satisfies StoredUserInput
    })
    this.#rerun.add(active.id)
    if (active.status === 'planning' || active.status === 'building_context') {
      this.#controllers.get(active.id)?.abort(new AgentLoopControlError('replan'))
    }
    await this.#publish(thread.id)
    this.#schedule(active.id)
  }

  async resolveDecision(turnId: string, itemId: string, optionId: string): Promise<void> {
    const turn = await this.#repository.getTurn(turnId)
    if (turn.status !== 'waiting_decision') throw new Error('Agent turn is not waiting for a decision.')
    if (!await this.#ensureTurnDeadline(turn)) throw new Error('本轮时限已到，原决定已停止。请核对作品后重新提出要求。')
    const items = await this.#repository.listTurnItems(turnId)
    const decision = items.find((item) => item.id === itemId && item.type === 'decision' && item.status === 'waiting')
    if (decision === undefined) throw new Error('Agent decision item is no longer waiting.')
    const decisionPayload = payload<StoredDecisionPayload>(decision)
    if (!decisionPayload.proposal.options.some((option) => option.id === optionId)) throw new Error('Decision option does not exist.')
    if (decisionPayload.proposal.kind === 'generation_confirmation' && optionId === 'keep_canvas') {
      await this.#repository.transitionItem(decision.id, 'completed', { ...decisionPayload, optionId })
      const legacyRunId = turn.inputMessageId ?? ''
      await this.#projection.onDecisionResolved?.({ legacyRunId, proposal: decisionPayload.proposal, optionId })
      await this.#complete(turn, legacyRunId, null, [], {
        status: 'completed_with_notes',
        summary: '已保留画布，没有创建生成任务。',
        notes: ['用户选择先保留画布。'],
        nextAction: null
      }, undefined, true)
      return
    }
    if (decisionPayload.proposal.kind === 'clarification' && optionId === 'stop' && decisionPayload.toolIndex !== undefined) {
      await this.#repository.transitionItem(decision.id, 'completed', { ...decisionPayload, optionId })
      const legacyRunId = turn.inputMessageId ?? ''
      await this.#projection.onDecisionResolved?.({ legacyRunId, proposal: decisionPayload.proposal, optionId })
      await this.#terminal(turn, legacyRunId, 'cancelled', 'USER_DECLINED_REVIEW_ACTION', '用户在审阅模式下选择不执行当前修改。')
      return
    }
    if (decisionPayload.proposal.kind === 'aspect_ratio' && decisionPayload.planItemId !== null) {
      const planItem = items.find((item) => item.id === decisionPayload.planItemId && item.type === 'plan')
      if (planItem !== undefined) {
        const stored = payload<StoredPlanItem>(planItem)
        if (stored.plan !== null) await this.#repository.transitionItem(planItem.id, 'completed', { ...stored, plan: resizePlan(stored.plan, optionId) })
      }
    }
    await this.#repository.transitionItem(decision.id, 'completed', { ...decisionPayload, optionId })
    await this.#repository.transitionTurn(turn.id, 'running', { errorCode: null, errorMessage: null })
    const legacyRunId = turn.inputMessageId ?? ''
    await this.#projection.onDecisionResolved?.({ legacyRunId, proposal: decisionPayload.proposal, optionId })
    await this.#publish(turn.threadId)
    this.#schedule(turn.id)
  }

  async resolveTemporaryTry(turnId: string, resolution: 'accept' | 'reject'): Promise<AgentTurn> {
    this.#assertOpen()
    const turn = await this.#repository.getTurn(turnId)
    if (turn.taskRelation !== 'temporary_try' || turn.temporaryState !== 'pending') {
      throw new Error('This turn is not a pending temporary try.')
    }
    if (!isTerminalAgentTurnStatus(turn.status)) throw new Error('A temporary try can be resolved only after it stops running.')
    if (resolution === 'reject') {
      const rejected = await this.#repository.setTemporaryState(turnId, 'rejected')
      await this.#publish(turn.threadId)
      return rejected
    }

    const items = await this.#repository.listTurnItems(turnId)
    const merged = mergeInputs(items)
    const request = await this.#refreshRequest(merged.request)
    const calls = items
      .filter((item) => item.type === 'tool_call')
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({ item, stored: payload<{ readonly toolIndex: number; readonly tool: AgentToolPlan }>(item) }))
      .filter(({ stored }) => stored.tool.kind === 'scene_batch')
    if (calls.length === 0) {
      throw new Error('这个临时尝试还没有可提交的正式画布变化。')
    }
    const first = calls[0]!
    const commands = calls.flatMap(({ stored }) => stored.tool.kind === 'scene_batch' ? stored.tool.commands : [])
    if (!commands.some((command) => command.kind === 'scene.set-creative-context' && command.creativeContext !== null)) {
      throw new Error('接受临时尝试前，Agent 必须先形成可检查的新创作简报。')
    }
    if (commands.length > 1_000) throw new Error('The temporary try contains too many Scene commands to accept atomically.')
    const acceptedTool: AgentToolPlan = {
      kind: 'scene_batch',
      summary: '接受临时方向并写入正式画布',
      commands
    }
    const goal = turn.goalId === null ? null : await this.#repository.getGoal(turn.goalId)
    if (turn.sceneWriteBatchesUsed + 1 > (goal?.budget.maxSceneWriteBatches ?? this.#budget.maxSceneWriteBatches)) {
      throw new Error('The temporary try exceeds the current Scene write budget.')
    }
    const controller = new AbortController()
    const outcome = await this.#executeTool(acceptedTool, {
      projectId: this.#projectId,
      threadId: turn.threadId,
      turnId,
      legacyRunId: turn.inputMessageId ?? turn.id,
      sourceMessageId: merged.sourceMessageId,
      contextManifestId: turn.contextManifestId,
      toolCallItemId: first.item.id,
      toolCallOrdinal: first.item.ordinal,
      toolIndex: first.stored.toolIndex,
      requestCorrelationId: null,
      approvalId: null,
      sceneWritesBefore: 0,
      request,
      signal: controller.signal
    })
    if (!outcome.ok || outcome.batchId === null) {
      throw new Error(outcome.message || 'The temporary Scene Batch could not be accepted.')
    }
    await this.#repository.incrementTurnUsage(turnId, { sceneWriteBatches: 1 })
    const refreshed = await this.#refreshRequest(request)
    await this.#repository.appendItem(turnId, {
      type: 'scene_change',
      status: 'completed',
      payloadVersion: 1,
      payload: { request: refreshed, batchId: outcome.batchId, toolCallItemId: first.item.id, acceptedTemporaryTry: true }
    })
    const accepted = await this.#repository.setTemporaryState(turnId, 'accepted')
    await this.#publish(turn.threadId)
    return accepted
  }

  async resumeQueue(): Promise<number> {
    const thread = await this.#requireThread()
    const count = await this.#repository.resumeQueue(thread.id)
    await this.#publish(thread.id)
    await this.#advanceQueue(thread.id)
    return count
  }

  async waitForIdle(): Promise<void> {
    let stableEmptyPasses = 0
    while (stableEmptyPasses < 2) {
      const tasks = [...this.#tasks.values()]
      if (tasks.length > 0) {
        stableEmptyPasses = 0
        await Promise.allSettled(tasks)
        continue
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      stableEmptyPasses = this.#tasks.size === 0 ? stableEmptyPasses + 1 : 0
    }
  }

  async observeGenerationJob(notification: GenerationJob): Promise<void> {
    if (this.#generationWorkflowRepository === null) return
    const job = this.#loadGenerationJob === null ? notification : await this.#loadGenerationJob(notification.id)
    if (job.projectId !== this.#projectId) return
    await this.#generationWorkflowRepository.observeJob(job)
    const subscriptions = await this.#generationWorkflowRepository.observeSubscriptions(job)
    if (!isTerminalGenerationJobStatus(job.status)) return
    for (const subscription of subscriptions) {
      const turn = await this.#repository.getTurn(subscription.turnId).catch(() => null)
      if (turn === null || isTerminalAgentTurnStatus(turn.status)) continue
      if (!await this.#ensureTurnDeadline(turn)) continue
      if (!await this.#repository.applyGenerationObservation(subscription, job)) continue
      if (await this.#stopForUnsuccessfulGeneration(turn, job)) continue
      await this.#publish(turn.threadId)
      this.#schedule(turn.id)
    }
  }

  async #stopForUnsuccessfulGeneration(turn: AgentTurn, job: GenerationJob): Promise<boolean> {
    if (job.status === 'completed') return false
    await this.#terminal(turn, turn.inputMessageId ?? '', job.status === 'cancelled' ? 'cancelled' : 'failed',
      job.error?.code ?? `GENERATION_${job.status.toUpperCase()}`,
      job.error?.message ?? '本地生成等待已停止；尚未确认的外部状态与费用保持待核对。')
    return true
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const timer of this.#turnTimers.values()) clearTimeout(timer)
    this.#turnTimers.clear()
    for (const controller of this.#controllers.values()) controller.abort(new AgentLoopControlError('interrupt'))
    await this.waitForIdle()
    await Promise.allSettled([...this.#deadlineTasks])
    await this.#generationWorkflowRepository?.close()
    await this.#contextRepository?.close()
    await this.#repository.close()
  }

  #schedule(turnId: string): void {
    if (this.#closed) return
    if (this.#tasks.has(turnId)) {
      this.#rerun.add(turnId)
      return
    }
    const task = this.#pump(turnId)
      .catch(async (error: unknown) => {
        const turn = await this.#repository.getTurn(turnId).catch(() => null)
        if (turn === null || isTerminalAgentTurnStatus(turn.status)) return
        const legacyRunId = turn.inputMessageId ?? ''
        const message = error instanceof Error ? error.message : 'Unknown persistent agent loop failure.'
        await this.#terminal(turn, legacyRunId, 'failed', surfacedFailureCode(error, 'AGENT_LOOP_FAILED'), message)
      })
      .finally(() => {
        this.#tasks.delete(turnId)
        this.#controllers.delete(turnId)
        if (this.#rerun.delete(turnId) && !this.#closed) {
          void this.#repository.getTurn(turnId).then((turn) => {
            if (!isTerminalAgentTurnStatus(turn.status) && turn.status !== 'waiting_decision' && turn.status !== 'waiting_job') this.#schedule(turnId)
          })
        }
      })
    this.#tasks.set(turnId, task)
  }

  async #ensureTurnDeadline(turn: AgentTurn): Promise<boolean> {
    if (isTerminalAgentTurnStatus(turn.status) || this.#closed) return false
    const remaining = turn.timeLimitMs == null ? null : Date.parse(turn.createdAt) + turn.timeLimitMs - Date.parse(this.#now())
    if (remaining === null || !Number.isFinite(remaining) || remaining <= 0) {
      this.#controllers.get(turn.id)?.abort(new AgentLoopControlError('interrupt'))
      await this.#terminal(turn, turn.inputMessageId ?? '', 'budget_limited', remaining === null ? 'TURN_TIME_UNVERIFIED' : 'BUDGET_WALL_TIME',
        remaining === null ? '旧任务没有可核对的本轮时限，后续操作已停止。现有作品和图片任务仍可查看。'
          : '本轮总时限已到，后续操作已停止。已提交的图片任务保留原有任务时限，可在生成页查看或停止。')
      return false
    }
    if (this.#turnTimers.has(turn.id)) return true
    const timer = setTimeout(() => {
      this.#turnTimers.delete(turn.id)
      const task = this.#repository.getTurn(turn.id).then((current) => this.#ensureTurnDeadline(current)).then(() => undefined)
        .catch(async () => {
          if (this.#closed) return
          const current = await this.#repository.getTurn(turn.id)
          await this.#terminal(current, current.inputMessageId ?? '', 'failed', 'TIME_LIMIT_CHECK_FAILED', '本轮时限无法核对，后续操作已停止。')
          this.#controllers.get(turn.id)?.abort(new AgentLoopControlError('interrupt'))
        }).finally(() => this.#deadlineTasks.delete(task))
      this.#deadlineTasks.add(task)
    }, Math.min(remaining, 2_147_483_647))
    timer.unref?.()
    this.#turnTimers.set(turn.id, timer)
    return true
  }

  #clearTurnDeadline(turnId: string): void {
    const timer = this.#turnTimers.get(turnId)
    if (timer !== undefined) clearTimeout(timer)
    this.#turnTimers.delete(turnId)
  }

  async #pump(turnId: string): Promise<void> {
    let controller = new AbortController()
    this.#controllers.set(turnId, controller)
    while (!this.#closed) {
      const turn = await this.#repository.getTurn(turnId)
      if (isTerminalAgentTurnStatus(turn.status) || turn.status === 'waiting_decision' || turn.status === 'waiting_job') return
      if (!await this.#ensureTurnDeadline(turn)) return
      const legacyRunId = turn.inputMessageId
      if (legacyRunId === null) throw new Error('Agent turn has no compatibility run identifier.')
      const activeGoal = turn.goalId === null ? null : await this.#repository.getGoal(turn.goalId)
      const turnBudget = activeGoal?.budget ?? this.#budget
      let items = await this.#repository.listTurnItems(turnId)
      const merged = mergeInputs(items)
      for (const itemId of merged.pendingIds) await this.#repository.transitionItem(itemId, 'completed')
      items = await this.#repository.listTurnItems(turnId)
      const resolution = applyContextConflictResolutions(merged.request, items)
      // Rehydrate volatile project state before every planning pass. Persisted
      // input intentionally excludes derived scene and generation-result data,
      // so planning against the stored request alone would miss completed jobs.
      const refreshedPlannerRequest = await this.#refreshRequest(resolution.request)
      if (this.#generationWorkflowRepository !== null) {
        const usage = this.#generationWorkflowRepository.getTurnUsage(turnId)
        const limit = this.#generationWorkflowRepository.getTurnBudget(turnId) ?? turnBudget
        refreshedPlannerRequest.generationBudget = { jobsUsed: usage.jobs, imagesReserved: usage.images,
          jobsRemaining: Math.max(0, limit.maxGenerationJobs - usage.jobs),
          imagesRemaining: Math.max(0, limit.maxGeneratedImages - usage.images), reservedCostCny: usage.reservedCostCny }
      }
      const plannerRequest = turn.taskRelation === 'new_task' && !items.some((item) => item.type === 'scene_change')
        ? {
            ...refreshedPlannerRequest,
            sceneSummary: {
              ...refreshedPlannerRequest.sceneSummary,
              creativeBrief: null,
              creativeContext: null
            }
          }
        : refreshedPlannerRequest
      let contextManifest: ContextManifest | null = null

      if (turn.status === 'queued' || turn.status === 'building_context') {
        await this.#repository.transitionTurn(turnId, 'building_context', { errorCode: null, errorMessage: null })
        await this.#projection.onPlanningStarted?.({ turn, legacyRunId, request: plannerRequest })
      }
      if (this.#contextRepository !== null) {
        const [settings, directives, memories, goal, allContextItems, threadTurns] = await Promise.all([
          this.#contextRepository.getSettings(this.#projectId),
          this.#contextRepository.listDirectives(this.#projectId, false),
          this.#contextRepository.listMemories(this.#projectId, false),
          Promise.resolve(activeGoal),
          this.#repository.listItems(turn.threadId),
          this.#repository.listTurns(turn.threadId)
        ])
        const contextItems = taskScopedItems(allContextItems, threadTurns, turn)
        const compactions = await this.#prepareContextCompactions(turn, contextItems)
        const built = this.#contextBuilder.build({
          projectId: this.#projectId,
          threadId: turn.threadId,
          turn,
          goal,
          request: plannerRequest,
          items: contextItems,
          directives,
          memories,
          compactions,
          outboundPolicy: settings.outboundPolicy,
          allowedTools: this.#allowedTools,
          resolvedDirectiveIds: resolution.resolvedDirectiveIds
        })
        const existing = turn.contextManifestId === null
          ? null
          : await this.#contextRepository.getManifest(turn.contextManifestId).catch(() => null)
        if (existing !== null && existing.sourceHash === built.manifest.sourceHash) {
          contextManifest = existing
        } else {
          contextManifest = await this.#contextRepository.createManifest(built.manifest)
          await this.#repository.setTurnContextManifest(turnId, contextManifest.id)
          await this.#publish(turn.threadId)
        }
        const conflict = built.conflicts[0]
        if (conflict !== undefined) {
          const proposal = decisionForContextConflict(conflict)
          const decisionItem = await this.#repository.appendItem(turnId, {
            type: 'decision',
            status: 'waiting',
            payloadVersion: 1,
            payload: { proposal, planItemId: null, contextConflict: conflict } satisfies StoredDecisionPayload
          })
          await this.#repository.transitionTurn(turnId, 'waiting_decision')
          await this.#projection.onDecisionWaiting?.({ turn, legacyRunId, item: decisionItem, proposal })
          await this.#publish(turn.threadId)
          return
        }
      }
      const activePlanItem = [...items]
        .reverse()
        .find((item) => item.type === 'plan' && item.status === 'completed'
          && item.ordinal > merged.barrierOrdinal && payload<StoredPlanItem>(item).plan !== null)
      const activePlan = activePlanItem === undefined ? null : payload<StoredPlanItem>(activePlanItem).plan
      const results = items.filter((item) => item.type === 'tool_result' && item.status === 'completed')
        .map((item) => payload<StoredToolResult>(item))
        .filter((result) => activePlanItem !== undefined && result.planItemId === activePlanItem.id)
      const cumulativeGenerationResults = items.filter((item) => item.type === 'tool_result' && item.status === 'completed')
        .map((item) => payload<StoredToolResult>(item))
      const reviewGatedPlanItemIds = new Set(items.flatMap((item) => {
        if (item.type !== 'decision' || item.ordinal <= merged.barrierOrdinal) return []
        const stored = payload<StoredDecisionPayload>(item)
        return stored.toolIndex === undefined || stored.planItemId === null ? [] : [stored.planItemId]
      }))
      const stepCount = items.filter((item) => item.type === 'plan'
        && item.ordinal > merged.barrierOrdinal && !reviewGatedPlanItemIds.has(item.id)).length

      const budgetFailure = this.#budgetFailure(turn, null, results, turnBudget)
      if (budgetFailure !== null) {
        await this.#terminal(turn, legacyRunId, 'budget_limited', budgetFailure.code, budgetFailure.message)
        return
      }

      await this.#repository.transitionTurn(turnId, 'planning', { errorCode: null, errorMessage: null })
      await this.#publish(turn.threadId)
      controller = new AbortController()
      this.#controllers.set(turnId, controller)
      let step
      // The turn owns one stable correlation chain. Individual Provider calls
      // remain distinguishable by attemptId while request/cost reservations,
      // repairs, tool execution and diagnostics stay attributable end to end.
      const requestCorrelationId = turn.id
      const attemptNumber = recoveryCount(items, 'model_can_repair') + 1
      const elapsedTurnTimeMs = Math.max(0, Date.parse(this.#now()) - Date.parse(turn.createdAt))
      const remainingPlannerTimeMs = turnBudget.maxWallTimeMs - elapsedTurnTimeMs - 1_000
      const harnessDeadlineAt = Date.now() + remainingPlannerTimeMs
      if (remainingPlannerTimeMs < 1_000) {
        await this.#terminal(turn, legacyRunId, 'budget_limited', 'BUDGET_WALL_TIME', '本轮剩余时间不足，未发送新的模型请求。')
        return
      }
      let providerRequestReserved = false
      let providerRequestSent = false
      let observerClosed = false
      let receivingCheckpoint: AgentEvent | null = null
      const observePlanner = async (event: AgentObservableEvent, delivery?: { readonly checkpoint: boolean }): Promise<void> => {
        if (observerClosed) return
        if (event.type === 'provider.attempt.reserved' && !providerRequestReserved) {
          providerRequestReserved = true
          // Charge at the reservation milestone so cancellation/interrupt cannot
          // bypass attempt accounting while unwinding planner.next().
          await this.#repository.incrementTurnUsage(turnId, { modelTurns: 1 })
        }
        if (event.type === 'provider.attempt.connecting') providerRequestSent = true
        if (event.type === 'provider.attempt.receiving' && delivery?.checkpoint === false && receivingCheckpoint !== null) {
          // Replace the live view of a durable checkpoint without allocating a
          // sequence or database row. Replay retains the latest 5-second checkpoint.
          const liveEvent = { ...receivingCheckpoint, payload: event.payload, createdAt: event.payload.occurredAt }
          for (const listener of this.#listeners) listener(liveEvent)
          return
        }
        const persisted = await this.#repository.appendEvent(turn.threadId, {
          turnId,
          itemId: null,
          type: event.type,
          payload: event.payload
        })
        if (event.type === 'provider.attempt.receiving') receivingCheckpoint = persisted
        await this.#publish(turn.threadId)
      }
      const plannerDeadlineError = Object.assign(new Error('本轮时间预算已到，文字模型请求已停止。'), { code: 'BUDGET_WALL_TIME' })
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      try {
        const planned = await Promise.race([
          this.#planner.next({
            turn: await this.#repository.getTurn(turnId),
            request: plannerRequest,
            contextManifest,
            items,
            stepIndex: stepCount,
            activePlan,
            nextToolIndex: results.length
          }, controller.signal, {
            attempt: attemptNumber,
            requestCorrelationId,
            deadlineAt: harnessDeadlineAt,
            deadlineCode: 'BUDGET_WALL_TIME',
            observe: observePlanner
          }),
          new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(() => {
              controller.abort(plannerDeadlineError)
              reject(plannerDeadlineError)
            }, remainingPlannerTimeMs)
          })
        ])
        if (!Number.isInteger(planned.modelTurns) || planned.modelTurns < 0) {
          throw new Error('Planner reported invalid model-turn usage.')
        }
        step = plannerStepSchema.parse(planned.step)
        if (planned.modelTurns > 0) {
          const unaccountedTurns = Math.max(0, planned.modelTurns - (providerRequestReserved ? 1 : 0))
          if (unaccountedTurns > 0) await this.#repository.incrementTurnUsage(turnId, { modelTurns: unaccountedTurns })
          const repairedFailure = [...items].reverse().flatMap((item): AgentFailureEnvelope[] => {
            if (item.type !== 'recovery' || item.status !== 'completed') return []
            const value = payload<StoredRecovery>(item).failure
            return value === undefined ? [] : [value]
          })[0]
          if (repairedFailure !== undefined) {
            await observePlanner({
              type: 'recovery.completed',
              payload: recoveryLifecyclePayload(repairedFailure, requestCorrelationId, this.#now())
            })
          }
        }
      } catch (error) {
        const control = error instanceof AgentLoopControlError ? error : controller.signal.reason
        if (control instanceof AgentLoopControlError && control.kind === 'replan') {
          await this.#repository.cancelPendingItems(turnId, 'input.corrected')
          await this.#repository.transitionTurn(turnId, 'building_context')
          await this.#publish(turn.threadId)
          continue
        }
        if (control instanceof AgentLoopControlError && control.kind === 'interrupt') return
        const wallTimeExpired = surfacedFailureCode(error, 'AGENT_PLANNING_FAILED') === 'BUDGET_WALL_TIME'
        const attempt = attemptNumber
        const failedTurnBeforeAccounting = await this.#repository.getTurn(turnId)
        const elapsed = Math.max(0, Date.parse(this.#now()) - Date.parse(turn.createdAt))
        const previousPlanningFailure = [...items].reverse().flatMap((item): AgentFailureEnvelope[] => {
          if (item.type !== 'recovery') return []
          const value = payload<StoredRecovery>(item).failure
          return value === undefined ? [] : [value]
        })[0]
        const failure = createAgentFailureEnvelope({
          error,
          fallbackCode: 'AGENT_PLANNING_FAILED',
          attempt,
          maxAttempts: 2,
          expectedSceneRevision: plannerRequest.sceneSummary.revision,
          currentSceneRevision: plannerRequest.sceneSummary.revision,
          requestCorrelationId,
          providerAttemptId: providerAttemptIdFrom(error),
          parentFailureId: previousPlanningFailure?.schemaVersion === 2 ? previousPlanningFailure.failureId : null,
          completedToolIndexes: results.map((result) => result.outcome.toolIndex),
          unstartedToolIndexes: activePlan === null ? [] : activePlan.tools.map((_tool, index) => index).filter((index) => index >= results.length),
          remainingModelTurns: Math.max(0, turnBudget.maxModelTurns - failedTurnBeforeAccounting.modelTurnsUsed),
          remainingRecoveryAttempts: Math.max(0, turnBudget.maxRecoveryAttempts - failedTurnBeforeAccounting.recoveryAttemptsUsed),
          remainingWallTimeMs: Math.max(0, turnBudget.maxWallTimeMs - elapsed),
          // Paid reservations belong to ProviderUsageLedger. The legacy zero
          // Harness allowance is not evidence of the remaining paid balance.
          remainingCostCny: null,
          ...(wallTimeExpired ? { externalState: providerRequestSent ? 'unknown' as const : 'not_started' as const } : {})
        })
        const persistStoppedFailure = async (): Promise<void> => {
          await this.#repository.appendItem(turnId, {
            type: 'recovery', status: 'failed', payloadVersion: 2,
            payload: { code: failure.code, message: failure.safeMessage, request: plannerRequest, failure } satisfies StoredRecovery
          })
        }
        if (failure.retryClass !== 'model_can_repair' || failure.externalState !== 'completed') {
          await persistStoppedFailure()
          if (wallTimeExpired) {
            await this.#terminal(await this.#repository.getTurn(turnId), legacyRunId, 'budget_limited', failure.code, failure.safeMessage)
            return
          }
          throw error
        }
        const failedTurn = await this.#repository.getTurn(turnId)
        const repeatedFingerprintCount = items.filter((item) => {
          if (item.type !== 'recovery') return false
          const previousFailure = payload<StoredRecovery>(item).failure
          return previousFailure?.schemaVersion === 2 && previousFailure.fingerprint === failure.fingerprint
        }).length
        const canCorrect = attempt <= failure.maxAttempts
          && repeatedFingerprintCount < 2
          && failedTurn.recoveryAttemptsUsed < turnBudget.maxRecoveryAttempts
          && failedTurn.modelTurnsUsed < turnBudget.maxModelTurns
          && harnessDeadlineAt - Date.now() >= 1_000
        if (!canCorrect) {
          await persistStoppedFailure()
          await observePlanner({
            type: 'recovery.exhausted',
            payload: recoveryLifecyclePayload(failure, requestCorrelationId, this.#now())
          })
          await this.#terminal(failedTurn, legacyRunId, 'failed', failure.code, failure.safeMessage)
          return
        }
        const refreshed = await this.#refreshRequest(plannerRequest)
        await this.#repository.incrementTurnUsage(turnId, { recoveryAttempts: 1 })
        await observePlanner({
          type: 'recovery.started',
          payload: recoveryLifecyclePayload(failure, requestCorrelationId, this.#now())
        })
        await this.#repository.appendItem(turnId, {
          type: 'recovery', status: 'completed', payloadVersion: 2,
          payload: {
            code: failure.code,
            message: `正在修正工具调用 ${attempt}/${failure.maxAttempts}`,
            request: refreshed,
            failure
          } satisfies StoredRecovery
        })
        await this.#repository.transitionTurn(turnId, 'building_context', { errorCode: null, errorMessage: null })
        await this.#publish(turn.threadId)
        continue
      } finally {
        observerClosed = true
        if (deadlineTimer !== null) clearTimeout(deadlineTimer)
      }
      const planItem = await this.#repository.appendItem(turnId, {
        type: 'plan',
        status: 'completed',
        payloadVersion: 1,
        payload: {
          legacyRunId,
          contextOrdinal: merged.barrierOrdinal,
          stepIndex: stepCount,
          plan: step.kind === 'tool' ? step.plan : null,
          step,
          sceneRevision: plannerRequest.sceneSummary.revision,
          requestCorrelationId
        } satisfies StoredPlanItem
      })
      if (step.kind === 'tool' && step.plan !== null) {
        await this.#projection.onPlanReady?.({ turn, legacyRunId, request: plannerRequest, plan: step.plan })
        const decision = decisionFor(plannerRequest, step.plan, this.#generationPolicy)
        if (decision !== null) {
          const decisionItem = await this.#repository.appendItem(turnId, {
            type: 'decision', status: 'waiting', payloadVersion: 1,
            payload: { proposal: decision, planItemId: planItem.id }
          })
          await this.#repository.transitionTurn(turnId, 'waiting_decision')
          await this.#projection.onDecisionWaiting?.({ turn, legacyRunId, item: decisionItem, proposal: decision })
          await this.#publish(turn.threadId)
          return
        }
      }
      if (step.kind === 'tool') {
        const explicitGrantAllowed = activeGoal?.mode !== 'auto'
        const approvedGeneration = explicitGrantAllowed
          ? explicitlyApprovedGenerationBudget(items, merged.barrierOrdinal)
          : { jobs: 0, images: 0 }
        const currentPlan = activePlan ?? step.plan
        const directlyAuthorizedGeneration = explicitGrantAllowed && currentPlan !== null
          && !this.#generationPolicy.requiresConfirmation(plannerRequest, currentPlan)
          ? planGenerationBudget(currentPlan)
          : { jobs: 0, images: 0 }
        let effectiveBudget = {
          ...turnBudget,
          maxGenerationJobs: Math.max(turnBudget.maxGenerationJobs, approvedGeneration.jobs, directlyAuthorizedGeneration.jobs),
          maxGeneratedImages: Math.max(turnBudget.maxGeneratedImages, approvedGeneration.images, directlyAuthorizedGeneration.images)
        }
        if (isGenerationTool(step.call) && this.#generationWorkflowRepository !== null) {
          try {
            effectiveBudget = this.#generationWorkflowRepository.captureTurnBudget({ projectId: this.#projectId, threadId: turn.threadId, turnId },
              effectiveBudget, activePlanItem?.id ?? planItem.id)
          } catch (error) {
            await this.#terminal(turn, legacyRunId, 'budget_limited', surfacedFailureCode(error, 'TURN_BUDGET_UNVERIFIED'),
              error instanceof Error ? error.message : '本轮累计预算无法核对。')
            return
          }
        }
        const toolBudgetFailure = this.#budgetFailure(await this.#repository.getTurn(turnId), step.call, cumulativeGenerationResults, effectiveBudget)
        if (toolBudgetFailure !== null) {
          await this.#terminal(turn, legacyRunId, 'budget_limited', toolBudgetFailure.code, toolBudgetFailure.message)
          return
        }
      }
      if (step.kind === 'tool') {
        const approvalPlanItemId = activePlanItem?.id ?? planItem.id
        if (activeGoal?.mode === 'review' && !hasReviewApproval(items, step.toolIndex, merged.barrierOrdinal)) {
          const proposal = reviewDecisionFor(step.call)
          const decisionItem = await this.#repository.appendItem(turnId, {
            type: 'decision',
            status: 'waiting',
            payloadVersion: 1,
            payload: { proposal, planItemId: approvalPlanItemId, toolIndex: step.toolIndex } satisfies StoredDecisionPayload
          })
          await this.#repository.transitionTurn(turnId, 'waiting_decision')
          await this.#projection.onDecisionWaiting?.({ turn, legacyRunId, item: decisionItem, proposal })
          await this.#publish(turn.threadId)
          return
        }
      }
      if (step.kind === 'message') {
        await this.#repository.appendItem(turnId, {
          type: 'assistant_message', status: 'completed', payloadVersion: 1, payload: { content: step.content }
        })
        await this.#repository.transitionTurn(turnId, 'running')
        await this.#publish(turn.threadId)
        continue
      }
      if (step.kind === 'decision') {
        const decisionItem = await this.#repository.appendItem(turnId, {
          type: 'decision', status: 'waiting', payloadVersion: 1, payload: { proposal: step.proposal, planItemId: activePlanItem?.id ?? null }
        })
        await this.#repository.transitionTurn(turnId, 'waiting_decision')
        await this.#projection.onDecisionWaiting?.({ turn, legacyRunId, item: decisionItem, proposal: step.proposal })
        await this.#publish(turn.threadId)
        return
      }
      if (step.kind === 'complete') {
        await this.#complete(turn, legacyRunId, activePlan, results.map((result) => result.outcome), step.assessment, plannerRequest)
        return
      }

      await this.#repository.transitionTurn(turnId, 'running')
      const callItem = await this.#repository.appendItem(turnId, {
        type: 'tool_call', status: 'started', payloadVersion: 1,
        payload: { planItemId: activePlanItem?.id ?? planItem.id, toolIndex: step.toolIndex, tool: step.call, legacyRunId }
      })
      await this.#repository.incrementTurnUsage(turnId, {
        toolCalls: 1,
        sceneWriteBatches: isSceneMutationTool(step.call) && turn.taskRelation !== 'temporary_try' ? 1 : 0
      })
      await this.#projection.onToolStarted?.({ legacyRunId, toolIndex: step.toolIndex, tool: step.call })
      await this.#publish(turn.threadId)
      let outcome: AgentToolOutcome
      const toolContext: AgentLoopToolContext = {
        projectId: this.#projectId,
        threadId: turn.threadId,
        turnId,
        legacyRunId,
        sourceMessageId: merged.sourceMessageId,
        contextManifestId: contextManifest?.id ?? turn.contextManifestId,
        toolCallItemId: callItem.id,
        toolCallOrdinal: callItem.ordinal,
        toolIndex: step.toolIndex,
        requestCorrelationId: activePlanItem === undefined
          ? requestCorrelationId
          : payload<StoredPlanItem>(activePlanItem).requestCorrelationId ?? null,
        approvalId: executionApprovalId(
          items,
          step.toolIndex,
          activePlanItem?.id ?? planItem.id,
          merged.barrierOrdinal
        ),
        sceneWritesBefore: results.filter((result) => result.outcome.ok && result.outcome.batchId !== null && isSceneMutationTool(result.tool)).length,
        expectedSceneRevision: activePlanItem === undefined
          ? plannerRequest.sceneSummary.revision
          : [...results].reverse().find((result) => result.outcome.ok && result.outcome.batchId !== null && isSceneMutationTool(result.tool))?.outcome.sceneRevisionAfter
            ?? (results.some((result) => result.outcome.ok && result.outcome.batchId !== null && isSceneMutationTool(result.tool))
              ? null : payload<StoredPlanItem>(activePlanItem).sceneRevision ?? null),
        request: plannerRequest,
        signal: controller.signal
      }
      try {
        if (turn.taskRelation === 'temporary_try' && isTemporaryPersistentTool(step.call)) {
          outcome = {
            toolIndex: step.toolIndex,
            ok: true,
            batchId: null,
            jobId: null,
            affectedElementIds: [],
            message: '临时候选已隔离保存；接受前未写入正式画布、规则或记忆。'
          }
        } else {
          let localReadRetries = 0
          let pendingReadFailure: AgentFailureEnvelope | null = null
          while (true) {
            try {
              outcome = await this.#executeTool(step.call, toolContext)
              if (pendingReadFailure !== null) {
                await this.#repository.appendEvent(turn.threadId, {
                  turnId,
                  itemId: callItem.id,
                  type: 'recovery.completed',
                  payload: recoveryLifecyclePayload(pendingReadFailure, null, this.#now())
                })
              }
              break
            } catch (error) {
              if (!isTransientLocalReadFailure(step.call, error)) throw error
              const currentUsage = await this.#repository.getTurn(turnId)
              const remainingWallTimeMs = Math.max(0, turnBudget.maxWallTimeMs - (Date.parse(this.#now()) - Date.parse(turn.createdAt)))
              if (localReadRetries >= 2 || currentUsage.recoveryAttemptsUsed >= turnBudget.maxRecoveryAttempts || remainingWallTimeMs < 1_000) {
                const exhaustedError = Object.assign(new Error('读取作品状态在两次本地重试后仍未恢复。'), { code: 'TOOL_READ_RETRY_EXHAUSTED' })
                const exhausted = createAgentFailureEnvelope({
                  error: exhaustedError,
                  fallbackCode: 'TOOL_READ_RETRY_EXHAUSTED',
                  toolName: step.call.kind,
                  attempt: Math.max(1, localReadRetries),
                  maxAttempts: 2,
                  expectedSceneRevision: plannerRequest.sceneSummary.revision,
                  currentSceneRevision: plannerRequest.sceneSummary.revision,
                  completedToolIndexes: results.map((result) => result.outcome.toolIndex),
                  failedToolIndex: step.toolIndex,
                  unstartedToolIndexes: [],
                  remainingModelTurns: Math.max(0, turnBudget.maxModelTurns - currentUsage.modelTurnsUsed),
                  remainingRecoveryAttempts: Math.max(0, turnBudget.maxRecoveryAttempts - currentUsage.recoveryAttemptsUsed),
                  remainingWallTimeMs,
                  remainingCostCny: turnBudget.maxCostCny
                })
                await this.#repository.appendEvent(turn.threadId, {
                  turnId,
                  itemId: callItem.id,
                  type: 'recovery.exhausted',
                  payload: recoveryLifecyclePayload(exhausted, null, this.#now())
                })
                throw exhaustedError
              }
              localReadRetries += 1
              const retryFailure = createAgentFailureEnvelope({
                error: Object.assign(new Error('读取作品状态遇到瞬时占用；画布尚未修改。'), { code: 'TOOL_READ_TRANSIENT' }),
                fallbackCode: 'TOOL_READ_TRANSIENT',
                toolName: step.call.kind,
                attempt: localReadRetries,
                maxAttempts: 2,
                expectedSceneRevision: plannerRequest.sceneSummary.revision,
                currentSceneRevision: plannerRequest.sceneSummary.revision,
                completedToolIndexes: results.map((result) => result.outcome.toolIndex),
                failedToolIndex: step.toolIndex,
                unstartedToolIndexes: [],
                remainingModelTurns: Math.max(0, turnBudget.maxModelTurns - currentUsage.modelTurnsUsed),
                remainingRecoveryAttempts: Math.max(0, turnBudget.maxRecoveryAttempts - currentUsage.recoveryAttemptsUsed - 1),
                remainingWallTimeMs,
                remainingCostCny: turnBudget.maxCostCny
              })
              pendingReadFailure = retryFailure
              await this.#repository.incrementTurnUsage(turnId, { recoveryAttempts: 1 })
              await this.#repository.appendEvent(turn.threadId, {
                turnId,
                itemId: callItem.id,
                type: 'recovery.started',
                payload: recoveryLifecyclePayload(retryFailure, null, this.#now())
              })
              await this.#repository.appendItem(turnId, {
                type: 'recovery',
                status: 'completed',
                payloadVersion: 2,
                payload: {
                  code: retryFailure.code,
                  message: `正在重新读取作品状态 ${localReadRetries}/2`,
                  request: plannerRequest,
                  failure: retryFailure
                } satisfies StoredRecovery
              })
            }
          }
        }
      } catch (error) {
        const control = error instanceof AgentLoopControlError ? error : controller.signal.reason
        if (control instanceof AgentLoopControlError && control.kind === 'interrupt') return
        const nextAttempt = (await this.#repository.getTurn(turnId)).recoveryAttemptsUsed + 1
        const previousRecoveryFailure = [...items].reverse().flatMap((item): AgentFailureEnvelope[] => {
          if (item.type !== 'recovery') return []
          const value = payload<StoredRecovery>(item).failure
          return value === undefined ? [] : [value]
        })[0]
        const remainingIndexes = (activePlan ?? step.plan)?.tools.map((_tool, index) => index)
          .filter((index) => index > step.toolIndex) ?? []
        const currentTurnUsage = await this.#repository.getTurn(turnId)
        const remainingWallTimeMs = Math.max(0, turnBudget.maxWallTimeMs - (Date.parse(this.#now()) - Date.parse(turn.createdAt)))
        const initialFailure = createAgentFailureEnvelope({
          error,
          fallbackCode: 'TOOL_EXECUTION_FAILED',
          toolName: step.call.kind,
          attempt: nextAttempt,
          maxAttempts: turnBudget.maxRecoveryAttempts,
          expectedSceneRevision: plannerRequest.sceneSummary.revision,
          currentSceneRevision: plannerRequest.sceneSummary.revision,
          affectedElementIds: plannerRequest.selectedIds,
          parentFailureId: previousRecoveryFailure?.schemaVersion === 2 ? previousRecoveryFailure.failureId : null,
          completedToolIndexes: results.map((result) => result.outcome.toolIndex),
          failedToolIndex: step.toolIndex,
          unstartedToolIndexes: remainingIndexes,
          remainingModelTurns: Math.max(0, turnBudget.maxModelTurns - currentTurnUsage.modelTurnsUsed),
          remainingRecoveryAttempts: Math.max(0, turnBudget.maxRecoveryAttempts - currentTurnUsage.recoveryAttemptsUsed),
          remainingWallTimeMs,
          remainingCostCny: turnBudget.maxCostCny
        })
        const canRecover = isAutomaticAgentRecovery(initialFailure.retryClass)
        const refreshed = canRecover ? await this.#refreshRequest(plannerRequest) : plannerRequest
        const failure = createAgentFailureEnvelope({
          error,
          fallbackCode: 'TOOL_EXECUTION_FAILED',
          toolName: step.call.kind,
          attempt: nextAttempt,
          maxAttempts: turnBudget.maxRecoveryAttempts,
          expectedSceneRevision: plannerRequest.sceneSummary.revision,
          currentSceneRevision: refreshed.sceneSummary.revision,
          affectedElementIds: plannerRequest.selectedIds,
          parentFailureId: previousRecoveryFailure?.schemaVersion === 2 ? previousRecoveryFailure.failureId : null,
          completedToolIndexes: results.map((result) => result.outcome.toolIndex),
          failedToolIndex: step.toolIndex,
          unstartedToolIndexes: remainingIndexes,
          remainingModelTurns: Math.max(0, turnBudget.maxModelTurns - currentTurnUsage.modelTurnsUsed),
          remainingRecoveryAttempts: Math.max(0, turnBudget.maxRecoveryAttempts - currentTurnUsage.recoveryAttemptsUsed),
          remainingWallTimeMs,
          remainingCostCny: turnBudget.maxCostCny
        })
        const message = failure.safeMessage
        outcome = { toolIndex: step.toolIndex, ok: false, batchId: null, jobId: null, affectedElementIds: [], message, failure }
        await this.#repository.transitionItem(callItem.id, 'failed', {
          ...payload<Record<string, unknown>>(callItem),
          errorCode: failure.code,
          message,
          recoverable: canRecover,
          failure
        })
        await this.#repository.appendItem(turnId, {
          type: 'tool_result', status: 'failed', payloadVersion: 1,
          payload: { planItemId: activePlanItem?.id ?? planItem.id, toolCallItemId: callItem.id, tool: step.call, outcome } satisfies StoredToolResult
        })
        await this.#projection.onToolFinished?.({ legacyRunId, outcome })
        const failedTurn = await this.#repository.getTurn(turnId)
        const modelRepairCount = recoveryCount(items, 'model_can_repair')
        const sameFingerprintCount = items.filter((item) => {
          if (item.type !== 'recovery') return false
          const prior = payload<StoredRecovery>(item).failure
          return prior?.schemaVersion === 2 && prior.fingerprint === failure.fingerprint
        }).length
        const withinModelRepairLimit = failure.retryClass !== 'model_can_repair' || modelRepairCount < 2
        if (canRecover
          && withinModelRepairLimit
          && sameFingerprintCount < 2
          && failedTurn.recoveryAttemptsUsed < turnBudget.maxRecoveryAttempts
          && remainingWallTimeMs >= 1_000) {
          await this.#repository.incrementTurnUsage(turnId, { recoveryAttempts: 1 })
          await this.#repository.appendEvent(turn.threadId, {
            turnId, itemId: callItem.id, type: 'recovery.started',
            payload: recoveryLifecyclePayload(failure, null, this.#now())
          })
          await this.#repository.appendItem(turnId, {
            type: 'recovery', status: 'completed', payloadVersion: 2,
            payload: { code: failure.code, message, request: refreshed, failure } satisfies StoredRecovery
          })
          await this.#repository.transitionTurn(turnId, 'building_context', { errorCode: null, errorMessage: null })
          await this.#publish(turn.threadId)
          continue
        }
        if (canRecover) {
          await this.#repository.appendEvent(turn.threadId, {
            turnId, itemId: callItem.id, type: 'recovery.exhausted',
            payload: recoveryLifecyclePayload(failure, null, this.#now())
          })
        }
        await this.#terminal(failedTurn, legacyRunId, 'failed', failure.code, message)
        return
      }
      const resultPlanItemId = activePlanItem?.id ?? planItem.id
      await this.#repository.transitionItem(callItem.id, outcome.ok ? 'completed' : 'failed', { ...payload<Record<string, unknown>>(callItem), outcome })
      await this.#repository.appendItem(turnId, {
        type: 'tool_result', status: outcome.ok ? 'completed' : 'failed', payloadVersion: 1,
        payload: { planItemId: resultPlanItemId, toolCallItemId: callItem.id, tool: step.call, outcome } satisfies StoredToolResult
      })
      await this.#projection.onToolFinished?.({ legacyRunId, outcome })
      if (outcome.ok && outcome.batchId !== null && isSceneMutationTool(step.call)) {
        const refreshed = await this.#refreshRequest(plannerRequest)
        await this.#repository.appendItem(turnId, {
          type: 'scene_change', status: 'completed', payloadVersion: 1,
          payload: { request: refreshed, batchId: outcome.batchId, toolCallItemId: callItem.id }
        })
      }
      await this.#publish(turn.threadId)
      if (!outcome.ok) {
        await this.#terminal(turn, legacyRunId, 'failed', 'TOOL_EXECUTION_FAILED', outcome.message)
        return
      }
      if (await this.#waitForGeneration(turn, step.call, outcome, callItem)) return
      if (this.#rerun.delete(turnId)) {
        await this.#repository.transitionTurn(turnId, 'building_context')
      }
    }
  }

  async #waitForGeneration(
    turn: AgentTurn,
    tool: AgentToolPlan,
    outcome: AgentToolOutcome,
    callItem: AgentItem
  ): Promise<boolean> {
    if (!isGenerationTool(tool) || outcome.jobId === null
      || this.#generationWorkflowRepository === null || this.#loadGenerationJob === null) return false
    const intent = await this.#generationWorkflowRepository.getIntentByJob(outcome.jobId)
    if (intent === null) return false
    await this.#generationWorkflowRepository.bindIntentToTurn(intent.id, {
      projectId: this.#projectId,
      threadId: turn.threadId,
      turnId: turn.id,
      toolCallItemId: callItem.id,
      sourceMessageId: turn.inputMessageId ?? callItem.id
    })
    const job = await this.#loadGenerationJob(outcome.jobId)
    await this.#generationWorkflowRepository.observeJob(job)
    if (isTerminalGenerationJobStatus(job.status)) {
      const item = await this.#repository.appendItem(turn.id, {
        type: 'generation_subscription',
        status: 'completed',
        payloadVersion: 1,
        payload: {
          subscriptionId: null,
          intentId: intent.id,
          jobId: job.id,
          toolCallItemId: callItem.id,
          toolIndex: outcome.toolIndex,
          lastJobStatus: job.status,
          observedAt: this.#now()
        } satisfies StoredGenerationSubscription
      })
      await this.#repository.appendEvent(turn.threadId, {
        turnId: turn.id,
        itemId: item.id,
        type: 'job.observed',
        payload: { jobId: job.id, status: job.status, resultCount: job.results.length, subscriptionId: null }
      })
      await this.#publish(turn.threadId)
      return this.#stopForUnsuccessfulGeneration(turn, job)
    }
    const subscription = await this.#generationWorkflowRepository.subscribe({
      projectId: this.#projectId,
      threadId: turn.threadId,
      turnId: turn.id,
      intentId: intent.id,
      jobId: job.id,
      jobStatus: job.status
    })
    const item = await this.#repository.appendItem(turn.id, {
      type: 'generation_subscription',
      status: 'waiting',
      payloadVersion: 1,
      payload: {
        subscriptionId: subscription.id,
        intentId: intent.id,
        jobId: job.id,
        toolCallItemId: callItem.id,
        toolIndex: outcome.toolIndex,
        lastJobStatus: job.status,
        observedAt: null
      } satisfies StoredGenerationSubscription
    })
    await this.#repository.transitionTurn(turn.id, 'waiting_job', { errorCode: null, errorMessage: null })
    await this.#repository.appendEvent(turn.threadId, {
      turnId: turn.id,
      itemId: item.id,
      type: 'job.waiting',
      payload: { jobId: job.id, status: job.status, subscriptionId: subscription.id }
    })
    await this.#publish(turn.threadId)
    await this.#activateGenerationJob?.(job.id)
    // Covers a terminal event delivered between subscribe() and waiting_job.
    await this.observeGenerationJob(await this.#loadGenerationJob(job.id))
    return true
  }

  #budgetFailure(
    turn: AgentTurn,
    nextTool: AgentToolPlan | null,
    results: readonly StoredToolResult[],
    budget: AgentRunBudget
  ): { readonly code: string; readonly message: string } | null {
    if (Date.parse(this.#now()) - Date.parse(turn.createdAt) >= budget.maxWallTimeMs) {
      return { code: 'BUDGET_WALL_TIME', message: 'Agent turn reached its wall-time budget before the next action.' }
    }
    if (turn.modelTurnsUsed >= budget.maxModelTurns) {
      return { code: 'BUDGET_MODEL_TURNS', message: 'Agent turn reached its model-turn budget before the next planning step.' }
    }
    if (nextTool === null) return null
    if (turn.toolCallsUsed >= budget.maxToolCalls) {
      return { code: 'BUDGET_TOOL_CALLS', message: 'Agent turn reached its tool-call budget before the next tool.' }
    }
    if (isSceneMutationTool(nextTool) && turn.sceneWriteBatchesUsed >= budget.maxSceneWriteBatches) {
      return { code: 'BUDGET_SCENE_WRITES', message: 'Agent turn reached its scene-write budget before the next batch.' }
    }
    if (isGenerationTool(nextTool)) {
      const completedGeneration = results.filter((result) => result.outcome.ok && isGenerationTool(result.tool))
      const persisted = this.#generationWorkflowRepository?.getTurnUsage(turn.id)
      const jobs = persisted?.jobs ?? completedGeneration.length
      const images = persisted?.images ?? completedGeneration.reduce((sum, result) => sum + plannedImageCount(result.tool), 0)
      if (jobs >= budget.maxGenerationJobs) {
        return { code: 'BUDGET_GENERATION_JOBS', message: 'Agent turn reached its generation-job budget before creating another job.' }
      }
      if (images + plannedImageCount(nextTool) > budget.maxGeneratedImages) {
        return { code: 'BUDGET_GENERATED_IMAGES', message: 'Agent turn reached its generated-image budget before creating another job.' }
      }
    }
    return null
  }

  async #complete(
    turn: AgentTurn,
    legacyRunId: string,
    plan: AgentPlan | null,
    outcomes: readonly AgentToolOutcome[],
    assessment: AgentCompletionAssessment,
    request?: AgentRequest,
    remainingWorkDeclined = false
  ): Promise<void> {
    const currentRequest = await this.#refreshRequest(request ?? await this.#loadRequest(legacyRunId))
    // A recovery plan describes only the remaining steps. Completion facts
    // still belong to the whole persisted Turn, including earlier results.
    const turnItems = await this.#repository.listTurnItems(turn.id)
    const observedTools = turnItems.filter(item => item.type === 'tool_result' && item.status === 'completed')
      .map(item => payload<StoredToolResult>(item))
    const priorPlans = turnItems.filter(item => item.type === 'plan' && item.status === 'completed')
      .map(item => payload<StoredPlanItem>(item).plan).filter((candidate): candidate is AgentPlan => candidate !== null)
    const previousContract = [...priorPlans].reverse().find(candidate => candidate.designContract !== undefined)?.designContract
    const activePlan = plan ?? priorPlans.at(-1) ?? null
    const completionPlan = activePlan === null || activePlan.designContract !== undefined || previousContract === undefined
      ? activePlan : { ...activePlan, designContract: previousContract }
    const aspectRevision = turnItems.flatMap(item => {
      if (item.type !== 'user_message' || item.status !== 'completed') return []
      const userInput = payload<StoredUserInput>(item)
      if (storedTaskRelation(userInput) !== 'revise_current') return []
      const aspect = explicitAspectRevision(userInput.request.text)
      return aspect === null ? [] : [{ ...aspect, userItemId: item.id, text: userInput.request.text }]
    }).at(-1)
    const jobs = await Promise.all([...new Set([...outcomes, ...observedTools.map(result => result.outcome)]
      .flatMap((outcome) => outcome.jobId === null ? [] : [outcome.jobId]))]
      .map((jobId) => this.#loadGenerationJob?.(jobId) ?? null))
    assessment = assessHonestCompletion({ request: currentRequest, plan: completionPlan, priorPlans, remainingWorkDeclined, ...(aspectRevision === undefined ? {} : { aspectRevision }), outcomes, observedTools,
      generationJobsCreated: this.#generationWorkflowRepository?.getTurnUsage(turn.id).jobs ?? jobs.length,
      resultIds: jobs.flatMap((job) => job?.results.map((result) => result.id) ?? []), proposed: assessment })
    await this.#proposeDesignMemoryCandidate(turn, completionPlan, assessment)
    if (!await this.#ensureTurnDeadline(await this.#repository.getTurn(turn.id))) return
    this.#clearTurnDeadline(turn.id)
    const item = await this.#repository.appendItem(turn.id, {
      type: 'completion_assessment', status: 'completed', payloadVersion: 1, payload: assessment
    })
    await this.#repository.transitionTurn(turn.id, assessment.status, { errorCode: null, errorMessage: null })
    const terminalTurn = await this.#repository.getTurn(turn.id)
    await this.#projection.onCompleted?.({ turn: terminalTurn, legacyRunId, plan: completionPlan, outcomes, assessment })
    await this.#repository.appendEvent(turn.threadId, {
      turnId: turn.id,
      itemId: item.id,
      type: 'turn.assessed',
      payload: assessment
    })
    await this.#publish(turn.threadId)
    if (assessment.status === 'completed' || assessment.status === 'completed_with_notes') await this.#advanceQueue(turn.threadId)
  }

  async #proposeDesignMemoryCandidate(
    turn: AgentTurn,
    plan: AgentPlan | null,
    assessment: AgentCompletionAssessment
  ): Promise<void> {
    if (
      this.#contextRepository === null
      || plan === null
      || turn.taskRelation === 'temporary_try'
      || (assessment.status !== 'completed' && assessment.status !== 'completed_with_notes')
    ) return
    const content = designMemoryContent(plan)
    if (content === null) return
    try {
      const existing = await this.#contextRepository.listCandidates(this.#projectId)
      if (existing.some((candidate) => candidate.sourceType === 'planner' && candidate.sourceId === turn.id)) return
      const candidate = await this.#contextRepository.createCandidate(this.#projectId, {
        kind: 'direction',
        content,
        sourceType: 'planner',
        sourceId: turn.id,
        confidence: 0.72
      })
      await this.#repository.appendEvent(turn.threadId, {
        turnId: turn.id,
        itemId: null,
        type: 'memory.candidate.proposed',
        payload: { candidateId: candidate.id, kind: candidate.kind, status: candidate.status }
      })
    } catch (error) {
      await this.#repository.appendEvent(turn.threadId, {
        turnId: turn.id,
        itemId: null,
        type: 'memory.candidate.skipped',
        payload: { reason: error instanceof Error ? error.message.slice(0, 500) : 'Unknown candidate persistence error.' }
      }).catch(() => undefined)
    }
  }

  async #interrupt(turn: AgentTurn, legacyRunId: string, code: string, message: string): Promise<void> {
    await this.#repository.cancelPendingItems(turn.id, code)
    await this.#terminal(turn, legacyRunId, 'interrupted', code, message)
  }

  async #terminal(turn: AgentTurn, legacyRunId: string, status: AgentTurnStatus, code: string, message: string): Promise<void> {
    this.#clearTurnDeadline(turn.id)
    if (isTerminalAgentTurnStatus((await this.#repository.getTurn(turn.id)).status)) return
    const safeCode = code.slice(0, 120)
    const safeMessage = message.slice(0, 1_000)
    await this.#generationWorkflowRepository?.cancelSubscriptionsForTurn(turn.id)
    await this.#repository.cancelPendingItems(turn.id, safeCode)
    await this.#repository.transitionTurn(turn.id, status, { errorCode: safeCode, errorMessage: safeMessage })
    const terminalTurn = await this.#repository.getTurn(turn.id)
    await this.#projection.onTerminal?.({ turn: terminalTurn, legacyRunId, status, code: safeCode, message: safeMessage })
    await this.#publish(turn.threadId)
  }

  async #advanceQueue(threadId: string): Promise<void> {
    const claimed = await this.#repository.claimNextQueueEntry(threadId)
    if (claimed === null) {
      await this.#publish(threadId)
      return
    }
    const request = await this.#loadRequest(claimed.messageId)
    const queuedInput = [...await this.#repository.listItems(threadId)]
      .reverse()
      .find((item) => item.type === 'user_message' && payload<StoredUserInput>(item).legacyRunId === claimed.messageId)
    const sourceTurn = queuedInput === undefined ? null : await this.#repository.getTurn(queuedInput.turnId).catch(() => null)
    const sourceGoal = sourceTurn?.goalId === null || sourceTurn?.goalId === undefined
      ? null
      : await this.#repository.getGoal(sourceTurn.goalId).catch(() => null)
    await this.start({
      legacyRunId: claimed.messageId,
      sourceMessageId: queuedInput === undefined ? claimed.messageId : payload<StoredUserInput>(queuedInput).sourceMessageId,
      request,
      ...(sourceGoal === null ? {} : { mode: sourceGoal.mode }),
      queueEntryId: claimed.id,
      taskId: claimed.taskId,
      taskRelation: claimed.taskRelation ?? 'continue_current',
      dispatchMode: claimed.dispatchMode ?? 'queue_after_current',
      baseTaskId: claimed.baseTaskId
    })
  }

  async #createGoal(threadId: string, request: AgentRequest, mode: AgentMode): Promise<AgentGoalContract> {
    const budget = this.#budgetOverride ?? (mode === 'auto'
      ? DEFAULT_AUTO_BUDGET
      : mode === 'review'
        ? DEFAULT_REVIEW_BUDGET
        : DEFAULT_COLLABORATION_BUDGET)
    return this.#repository.createGoal(threadId, {
      objective: request.text,
      completionDefinition: ['所需设计与生成操作有可核对回执', '外发、费用与项目写入符合当前 Owner 权限和预算'],
      mode,
      scope: {
        canvas: request.selectedIds.length === 0,
        elementIds: request.selectedIds,
        assetIds: request.attachments.map((attachment) => attachment.id),
        providerIds: [...this.#providerIds]
      },
      permissionProfileId: this.#permissionProfileId,
      budget,
      prohibitions: [
        '禁止访问当前项目、项目库和用户明确选择文件之外的路径',
        '禁止向 Renderer、日志、项目或模型暴露供应商凭据明文',
        '禁止任意命令执行、未知端点、破坏性迁移和无边界自动付费'
      ]
    })
  }

  async #publish(threadId: string): Promise<void> {
    const cursor = this.#eventCursors.get(threadId) ?? 0
    const events = await this.#repository.replayEvents(threadId, cursor)
    for (const event of events) {
      this.#eventCursors.set(threadId, event.sequence)
      for (const listener of this.#listeners) listener(event)
    }
  }

  async #requireThread(): Promise<AgentThread> {
    if (this.#thread !== null) return this.#thread
    const thread = await this.#repository.ensureThread(this.#projectId)
    this.#thread = thread
    this.#eventCursors.set(thread.id, thread.lastSequence)
    return thread
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Persistent agent loop is closed.')
  }

  async #prepareContextCompactions(turn: AgentTurn, items: readonly AgentItem[]): Promise<readonly ContextCompaction[]> {
    if (this.#contextRepository === null) return []
    const taskMarker = turn.taskId === null ? null : `任务上下文 ${turn.taskId}\n`
    const allExisting = await this.#contextRepository.listCompactions(turn.threadId)
    const existing = taskMarker === null
      ? allExisting
      : allExisting.filter((compaction) => compaction.summary.startsWith(taskMarker))
    const completedMessages = items.filter((item) =>
      item.status === 'completed' && (item.type === 'user_message' || item.type === 'assistant_message')
    )
    if (completedMessages.length <= RECENT_CONVERSATION_ITEM_LIMIT) return existing.slice(0, 1)

    const compactableMessageIds = new Set(
      completedMessages.slice(0, -RECENT_CONVERSATION_ITEM_LIMIT).map((item) => item.id)
    )
    const compactableTurnIds = new Set(
      completedMessages.filter((item) => compactableMessageIds.has(item.id)).map((item) => item.turnId)
    )
    const compactableItems = items.filter((item) => compactableTurnIds.has(item.turnId))
    if (compactableItems.length === 0) return existing.slice(0, 1)

    const events: AgentEvent[] = []
    let cursor = 0
    while (true) {
      const page = await this.#repository.replayEvents(turn.threadId, cursor, 1_000)
      events.push(...page)
      const last = page.at(-1)
      if (page.length < 1_000 || last === undefined) break
      cursor = last.sequence
    }
    const compactableEvents = events.filter((event) =>
      event.turnId !== null && compactableTurnIds.has(event.turnId)
    )
    const rawDraft = this.#contextCompactor.compact(
      this.#projectId,
      turn.threadId,
      compactableEvents,
      compactableItems
    )
    if (rawDraft === null) return existing.slice(0, 1)
    const draft = taskMarker === null
      ? rawDraft
      : {
          ...rawDraft,
          sourceHash: contextSourceHash({ taskId: turn.taskId, sourceHash: rawDraft.sourceHash }),
          summary: `${taskMarker}${rawDraft.summary}`
        }
    const latest = existing[0]
    if (latest?.sourceHash === draft.sourceHash
      && latest.sourceSequenceFrom === draft.sourceSequenceFrom
      && latest.sourceSequenceTo === draft.sourceSequenceTo) {
      return [latest]
    }

    const created = await this.#contextRepository.createCompaction(draft)
    await this.#repository.appendEvent(turn.threadId, {
      turnId: turn.id,
      itemId: null,
      type: 'context.compaction.created',
      payload: {
        compactionId: created.id,
        version: created.version,
        sourceSequenceFrom: created.sourceSequenceFrom,
        sourceSequenceTo: created.sourceSequenceTo
      }
    })
    return [created]
  }
}
