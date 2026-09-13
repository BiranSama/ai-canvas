import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, Crosshair, Files, GripVertical, Image, ListFilter, PanelRightClose, PanelRightOpen, Pencil, RotateCcw, Square, Trash2, X } from 'lucide-react'
import { type CSSProperties, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivity, AgentRun, ConversationSnapshot } from '../../../shared/agent'
import { adaptLegacyTurnInputMode, type AgentHarnessSnapshot, type AgentMode, type AgentTurnStatus, type TaskRelation, type TurnInputMode } from '../../../shared/agent-harness'
import type { ProjectKnowledgeSnapshot } from '../../../shared/agent-context'
import type { DesignDirectionSelectionResult } from '../../../shared/design-direction-selection'
import { createAgentRequest } from '../agent/agent-client'
import { agentEventsForTurn, subscribeAgentUpdates, subscribeAgentTransportUpdates } from '../agent/agent-event-stream'
import { buildEphemeralAnnotationSaveCommands } from '../agent/ephemeral-annotation'
import { currentEphemeralAnnotation, useEphemeralAnnotationStore } from '../agent/ephemeral-annotation-store'
import { CanvasStage } from '../canvas/CanvasStage'
import { projectAgentExecutionFlow } from '../agent/agent-execution-flow'
import { autoGenerationTurnCopy, useCreationSessionStore } from '../store/creation-session-store'
import { useWorkspaceStore } from '../store/workspace-store'
import { AgentExecutionFlowView } from './AgentExecutionFlow'
import { AgentContextSheet } from './AgentContextSheet'
import { CreativeBriefSummary } from './CreativeBriefSummary'
import { activeModal } from '../interaction/keyboard-scope'
import { CompletionReview } from './CompletionReview'
import { useProjectScope } from '../store/use-project-scope'
import { completionFactsSchema } from '../../../shared/design-capability'

const ACTIVE_STATUSES = new Set<AgentRun['status']>([
  'queued', 'planning', 'awaiting_confirmation', 'awaiting_execution', 'executing'
])

type ComposerState = 'idle' | 'editing' | 'acting' | 'waiting' | 'confirm' | 'completed' | 'limited' | 'failed' | 'cancelled'

const COMPOSER_STATE_COPY: Record<ComposerState, string> = {
  idle: '待命',
  editing: '正在编辑',
  acting: '正在执行',
  waiting: '等待本地任务',
  confirm: '等待确认',
  completed: '已完成',
  limited: '已到本轮边界',
  failed: '需要处理',
  cancelled: '已停止'
}

const ACTIVE_TURN_STATUSES = new Set<AgentTurnStatus>([
  'queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job'
])

const CONVERSATION_RATIO_STORAGE_KEY = 'ai-canvas.conversation-ratio.v4'

function initialConversationRatio(): number {
  const saved = localStorage.getItem(CONVERSATION_RATIO_STORAGE_KEY) ?? localStorage.getItem('ai-canvas.conversation-ratio.v3')
  if (saved === null || Number(saved) === 64) return 32
  const stored = Number(saved)
  return Number.isFinite(stored) ? Math.min(48, Math.max(28, stored)) : 32
}

function runStatusCopy(run: AgentRun): string {
  if (ACTIVE_STATUSES.has(run.status)) return '进行中'
  if (run.status === 'completed') return '已完成'
  if (run.status === 'failed') return '需要处理'
  if (run.status === 'interrupted') return '上次中断'
  if (run.status === 'cancelled') return '已停止'
  return run.status === 'timed_out' ? '已超时' : '已记录'
}

function taskTitle(snapshot: ConversationSnapshot, run: AgentRun): string {
  const source = snapshot.messages.find((message) => message.id === run.userMessageId)
    ?? snapshot.messages.find((message) => message.runId === run.id && message.role === 'user')
  const content = source?.content.trim() ?? '未命名创作任务'
  return content.length > 54 ? `${content.slice(0, 54)}…` : content
}

const AGENT_MODE_COPY: Record<AgentMode, { readonly label: string; readonly note: string }> = {
  review: { label: '审阅', note: '每步确认' },
  collaboration: { label: '协作', note: '低风险自动' },
  auto: { label: '自动', note: '边界内连续' }
}

const INPUT_MODE_COPY: Record<TurnInputMode, { readonly label: string; readonly note: string }> = {
  correct_current: { label: '修正本轮', note: '替换尚未执行的计划' },
  append_current: { label: '补充本轮', note: '加入当前目标' },
  queue_next: { label: '排到下一轮', note: '当前完成后再做' },
  interrupt_now: { label: '立即停止', note: '中断 Agent，保留已完成内容' }
}

const TASK_RELATION_COPY: Record<TaskRelation, { readonly label: string; readonly note: string }> = {
  continue_current: { label: '继续当前作品', note: '沿用当前创作简报与任务分支' },
  revise_current: { label: '修正当前任务', note: '替换指定要求，保留未涉及内容' },
  supplement_current: { label: '补充当前任务', note: '增加要求，不推翻已有约束' },
  new_task: { label: '新建创作任务', note: '保留旧历史，但不把旧任务指令带入新任务' },
  temporary_try: { label: '临时试一个方向', note: '接受前不写入正式画布、规则或长期记忆' }
}

interface PresentedDesignDirection {
  readonly id: string
  readonly title: string
  readonly recommended: boolean
  readonly composition: string
  readonly subject: string
  readonly typography: string
  readonly lighting: string
  readonly difference: string
}

interface DirectionConflictState {
  readonly key: string
  readonly sourceRunId: string
  readonly briefId: string
  readonly direction: PresentedDesignDirection
  readonly result: Extract<DesignDirectionSelectionResult, { status: 'conflict' }>
}

function recommendedInputMode(text: string): TurnInputMode {
  if (/停止|中断|别做了|先停/.test(text)) return 'interrupt_now'
  if (/下一步|之后|做完再|接下来/.test(text)) return 'queue_next'
  if (/另外|补充|再加|同时/.test(text)) return 'append_current'
  return 'correct_current'
}

function composerStateFor(status: AgentTurnStatus | null, fallback: ComposerState): ComposerState {
  if (status === null) return fallback
  if (status === 'waiting_decision') return 'confirm'
  if (status === 'waiting_job') return 'waiting'
  if (['queued', 'building_context', 'planning', 'running'].includes(status)) return 'acting'
  if (status === 'completed' || status === 'completed_with_notes' || status === 'needs_user_review') return 'completed'
  if (status === 'budget_limited' || status === 'usage_limited' || status === 'blocked') return 'limited'
  if (status === 'interrupted' || status === 'cancelled') return 'cancelled'
  return 'failed'
}

function activityStateCopy(activity: AgentActivity): string {
  if (activity.state === 'queued') return '等待执行'
  if (activity.state === 'running') return '正在执行'
  if (activity.state === 'waiting') return '等待决定'
  if (activity.state === 'completed') return activity.undoneAt === null ? '已完成' : '已撤销'
  if (activity.state === 'failed') return '未完成'
  if (activity.state === 'interrupted') return '上次中断'
  return '已停止'
}

function timeCopy(startedAt: string | null, endedAt: string | null): string {
  if (startedAt === null) return '尚未开始'
  if (endedAt === null) return '进行中'
  const duration = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
  return duration < 1_000 ? `${duration} 毫秒` : `${(duration / 1_000).toFixed(1)} 秒`
}

export function ConversationView({ header }: { readonly header: ReactNode }): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const isCurrentProject = useProjectScope(scene.projectId)
  const [acceptingReviewId, setAcceptingReviewId] = useState<string | null>(null)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const setSelection = useWorkspaceStore((state) => state.setSelection)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const undoBatch = useWorkspaceStore((state) => state.undoBatch)
  const execute = useWorkspaceStore((state) => state.execute)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
  const [harness, setHarness] = useState<AgentHarnessSnapshot | null>(null)
  const [knowledge, setKnowledge] = useState<ProjectKnowledgeSnapshot | null>(null)
  const draft = useCreationSessionStore((state) => state.draft)
  const setDraft = useCreationSessionStore((state) => state.setDraft)
  const autoGenerate = useCreationSessionStore((state) => state.autoGenerateForNextTurn)
  const setAutoGenerate = useCreationSessionStore((state) => state.setAutoGenerateForNextTurn)
  const agentMode = useCreationSessionStore((state) => state.agentMode)
  const setAgentMode = useCreationSessionStore((state) => state.setAgentMode)
  const providerAutoGeneration = useCreationSessionStore((state) => state.providerAutoGeneration)
  const bindProject = useCreationSessionStore((state) => state.bindProject)
  const refreshProviderAutoGeneration = useCreationSessionStore((state) => state.refreshProviderAutoGeneration)
  const completeAcceptedTurn = useCreationSessionStore((state) => state.completeAcceptedTurn)
  const [explicitInputMode, setExplicitInputMode] = useState<{ readonly turnId: string; readonly mode: TurnInputMode } | null>(null)
  const [idleTaskRelation, setIdleTaskRelation] = useState<TaskRelation>('continue_current')
  const [contextOpen, setContextOpen] = useState(false)
  const [annotationExitPrompt, setAnnotationExitPrompt] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [activityExpanded, setActivityExpanded] = useState(() => localStorage.getItem('ai-canvas.activity-detail') === 'expanded')
  const [conversationRatio, setConversationRatio] = useState(initialConversationRatio)
  const [compactRecordOpen, setCompactRecordOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyVisibleCount, setHistoryVisibleCount] = useState(6)
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null)
  const [directionApplyingKey, setDirectionApplyingKey] = useState<string | null>(null)
  const [directionConflict, setDirectionConflict] = useState<DirectionConflictState | null>(null)
  const [directionNotice, setDirectionNotice] = useState<{ readonly key: string; readonly message: string } | null>(null)
  const [executionClock, setExecutionClock] = useState(() => Date.now())
  const threadRef = useRef<HTMLDivElement>(null)
  const latestMessageRef = useRef<HTMLElement>(null)
  const lastMessageAnchorRevisionRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputComposingRef = useRef(false)
  const contextButtonRef = useRef<HTMLButtonElement>(null)
  const decisionCardRef = useRef<HTMLDivElement>(null)
  const decisionDefaultRef = useRef<HTMLButtonElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const resizingPointerRef = useRef<number | null>(null)
  const annotationStatus = useEphemeralAnnotationStore((state) => state.status)
  const annotationTool = useEphemeralAnnotationStore((state) => state.tool)
  const annotationMode = useEphemeralAnnotationStore((state) => state.mode)
  const annotationRegions = useEphemeralAnnotationStore((state) => state.regions)
  const annotationRunId = useEphemeralAnnotationStore((state) => state.runId)
  const annotationJobId = useEphemeralAnnotationStore((state) => state.jobId)
  const annotationTargetId = useEphemeralAnnotationStore((state) => state.targetElementId)
  const annotationRequirement = useEphemeralAnnotationStore((state) => state.originalRequirement)
  const annotationFailure = useEphemeralAnnotationStore((state) => state.failureLabel)
  const beginAnnotation = useEphemeralAnnotationStore((state) => state.begin)
  const setAnnotationTool = useEphemeralAnnotationStore((state) => state.setTool)
  const setAnnotationMode = useEphemeralAnnotationStore((state) => state.setMode)
  const addAnnotationRegion = useEphemeralAnnotationStore((state) => state.addRegion)
  const removeAnnotationRegion = useEphemeralAnnotationStore((state) => state.removeRegion)
  const markAnnotationSubmitted = useEphemeralAnnotationStore((state) => state.markSubmitted)
  const markAnnotationJobSubmitted = useEphemeralAnnotationStore((state) => state.markJobSubmitted)
  const clearAnnotation = useEphemeralAnnotationStore((state) => state.clear)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [conversation, harnessSnapshot, projectKnowledge] = await Promise.all([
        window.desktop.getConversationSnapshot(),
        window.desktop.getAgentHarnessSnapshot(),
        window.desktop.getProjectKnowledge()
      ])
      if (!isCurrentProject() || conversation.projectId !== scene.projectId) return
      setSnapshot(conversation)
      setHarness(harnessSnapshot)
      setKnowledge(projectKnowledge)
    } catch {
      setProblem('暂时无法读取创作对话。')
    }
  }, [isCurrentProject, scene.projectId])

  const acceptReview = async (messageId: string): Promise<void> => {
    if (!isCurrentProject()) return
    setAcceptingReviewId(messageId)
    try {
      const updated = await window.desktop.acceptDesignReview({ projectId: scene.projectId, messageId, sceneRevision: scene.revision })
      if (isCurrentProject()) setSnapshot(updated)
    } catch (error) {
      if (isCurrentProject()) setProblem(error instanceof Error ? error.message : '接受决定未保存，请重试。')
    } finally {
      if (isCurrentProject()) setAcceptingReviewId(null)
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const unsubscribe = subscribeAgentUpdates(() => void refresh())
    const unsubscribeTransport = subscribeAgentTransportUpdates(() => setExecutionClock(Date.now()))
    return () => {
      window.clearTimeout(initial)
      unsubscribe()
      unsubscribeTransport()
    }
  }, [refresh])

  const activeRun = snapshot?.runs.find((run) => ACTIVE_STATUSES.has(run.status)) ?? null
  const latestRun = snapshot?.runs[0] ?? null
  const displayRun = activeRun ?? latestRun
  const inspectedRun = inspectedRunId === null ? null : snapshot?.runs.find((run) => run.id === inspectedRunId) ?? null
  const presentedRun = inspectedRun ?? displayRun
  const presentedRunId = presentedRun?.id ?? null
  const taskIdByRunId = new Map((harness?.turns ?? []).flatMap((turn) => turn.inputMessageId === null
    ? []
    : [[turn.inputMessageId, turn.taskId ?? turn.id] as const]))
  const taskKeyForRun = (run: AgentRun): string => taskIdByRunId.get(run.id) ?? run.id
  const currentTaskKey = displayRun === null ? null : taskKeyForRun(displayRun)
  const presentedTaskKey = presentedRun === null ? null : taskKeyForRun(presentedRun)
  const taskRepresentatives = (snapshot?.runs ?? []).filter((run, index, runs) =>
    runs.findIndex((candidate) => taskKeyForRun(candidate) === taskKeyForRun(run)) === index)
  const historicalRuns = taskRepresentatives.filter((run) => currentTaskKey === null || taskKeyForRun(run) !== currentTaskKey)
  const visibleHistoryRuns = historicalRuns.slice(0, historyVisibleCount)
  const presentedRunIds = new Set((snapshot?.runs ?? [])
    .filter((run) => presentedTaskKey !== null && taskKeyForRun(run) === presentedTaskKey)
    .map((run) => run.id))
  const presentedMessages = snapshot === null
    ? []
    : presentedRunId === null
      ? snapshot.messages.slice(-6)
      : snapshot.messages.filter((message) => message.runId !== null && presentedRunIds.has(message.runId))
  const activeTurn = harness?.turns.find((turn) => turn.id === harness.thread.activeTurnId || ACTIVE_TURN_STATUSES.has(turn.status)) ?? null
  const latestTurn = harness?.turns[0] ?? null
  const displayTurn = activeTurn ?? latestTurn
  const displayTurnId = displayTurn?.id ?? null
  const displayTurnStatus = displayTurn?.status ?? null
  const completionPayload = harness?.items.filter((item) => item.turnId === displayTurnId && item.type === 'completion_assessment').at(-1)?.payload
  const completionFacts = completionFactsSchema.safeParse(typeof completionPayload === 'object' && completionPayload !== null && 'facts' in completionPayload ? completionPayload.facts : undefined)
  const plainCompletedReply = !ACTIVE_TURN_STATUSES.has(displayTurnStatus ?? 'queued') && completionFacts.success && completionFacts.data.operationStatus === 'not_requested'
  useEffect(() => {
    if (displayTurnId === null || displayTurnStatus === null || !ACTIVE_TURN_STATUSES.has(displayTurnStatus)) return
    let timer = 0
    const tick = (): void => {
      setExecutionClock(Date.now())
      timer = window.setTimeout(tick, 1_000)
    }
    timer = window.setTimeout(tick, 1_000)
    return () => window.clearTimeout(timer)
  }, [displayTurnId, displayTurnStatus])
  const hasActiveTurn = activeRun !== null || activeTurn !== null
  const activeTurnIdentity = activeTurn?.id ?? activeRun?.id ?? null
  const inputModeTouched = explicitInputMode?.turnId === activeTurnIdentity
  const inputMode = inputModeTouched ? explicitInputMode.mode : recommendedInputMode(draft)
  const effectiveAgentMode = activeTurn === null ? agentMode : harness?.activeGoal?.mode ?? agentMode
  const hasFormalTask = harness?.turns.some((turn) => turn.taskId !== null
    && turn.taskRelation !== 'temporary_try') ?? false
  const effectiveIdleTaskRelation = idleTaskRelation === 'continue_current' && !hasFormalTask ? 'new_task' : idleTaskRelation
  const pendingTemporaryTurn = harness?.turns.find((turn) => turn.taskRelation === 'temporary_try' && turn.temporaryState === 'pending'
    && !ACTIVE_TURN_STATUSES.has(turn.status)) ?? null
  const autoGenerationCopy = autoGenerationTurnCopy(effectiveAgentMode, providerAutoGeneration)
  const activities = snapshot?.activities ?? []
  const presentedActivities = presentedRunId === null ? activities : activities.filter((activity) => activity.runId !== null && presentedRunIds.has(activity.runId))
  const executionFlow = inspectedRun === null
      ? projectAgentExecutionFlow(harness, displayTurn?.id ?? null, executionClock, {
        expanded: activityExpanded,
        activities: presentedActivities,
        events: agentEventsForTurn(displayTurn?.id ?? null)
      })
    : null
  const visibleActivities = activityExpanded ? presentedActivities.slice(-24) : presentedActivities.slice(-4)
  const latestPresentedMessage = presentedMessages.at(-1)
  const latestMessageAnchorRevision = latestPresentedMessage === undefined
    ? null
    : [
        latestPresentedMessage.id,
        latestPresentedMessage.receipt?.items.length ?? 0,
        latestPresentedMessage.receipt?.designReview?.directions.length ?? 0,
        executionFlow?.totalStageCount ?? 0,
        executionFlow?.state ?? 'none',
        presentedActivities.length,
        presentedRun?.status ?? 'none'
      ].join(':')

  const waitingDecisionActivity = [...presentedActivities].reverse().find((activity) => activity.decision?.status === 'waiting')
  const waitingDecision = waitingDecisionActivity?.decision ?? null
  const waitingDecisionId = waitingDecision?.id ?? null
  const waitingDecisionAnchorRevision = waitingDecisionId === null
    ? null
    : `${waitingDecisionId}:${latestMessageAnchorRevision ?? 'none'}`

  useEffect(() => {
    if (waitingDecisionId !== null || latestMessageAnchorRevision === null || latestMessageAnchorRevision === lastMessageAnchorRevisionRef.current) return
    lastMessageAnchorRevisionRef.current = latestMessageAnchorRevision
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current
      const message = latestMessageRef.current
      if (thread === null || message === null) return
      const threadBounds = thread.getBoundingClientRect()
      const messageBounds = message.getBoundingClientRect()
      // Leave a small optical inset so fractional Windows scaling never tucks
      // the first message border behind the scroll viewport edge.
      thread.scrollTop = Math.max(0, thread.scrollTop + messageBounds.top - threadBounds.top - 2)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [latestMessageAnchorRevision, waitingDecisionId])

  const fallbackComposerState: ComposerState = problem !== null
    ? 'failed'
    : activeRun?.status === 'awaiting_confirmation'
      ? 'confirm'
      : activeRun !== null
        ? 'acting'
        : draft.trim().length > 0
          ? 'editing'
          : latestRun?.status === 'completed' || latestRun?.status === 'failed' || latestRun?.status === 'cancelled'
            ? latestRun.status
            : 'idle'
  const composerState = composerStateFor(displayTurn?.status ?? null, fallbackComposerState)
  const selectedElements = useMemo(
    () => scene.elements.filter((element) => selectedIds.includes(element.id)),
    [scene.elements, selectedIds]
  )
  const annotationTarget = selectedElements.find((element) => element.type === 'image')
    ?? [...scene.elements].reverse().find((element) => element.type === 'image')
  const retainedAnnotationTarget = scene.elements.find((element) => element.id === annotationTargetId)
  const annotationVisible = annotationStatus !== 'idle'
  const annotationEditable = annotationStatus === 'editing' || annotationStatus === 'failed'

  useEffect(() => {
    localStorage.setItem('ai-canvas.activity-detail', activityExpanded ? 'expanded' : 'compact')
  }, [activityExpanded])

  useEffect(() => {
    localStorage.setItem(CONVERSATION_RATIO_STORAGE_KEY, String(conversationRatio))
  }, [conversationRatio])

  useEffect(() => {
    const closeCompactPreview = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && activeModal() === null) setCompactRecordOpen(false)
    }
    window.addEventListener('keydown', closeCompactPreview)
    return () => window.removeEventListener('keydown', closeCompactPreview)
  }, [])

  const updateConversationRatio = useCallback((clientX: number): void => {
    const bounds = workspaceRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width <= 0) return
    setConversationRatio(Math.min(48, Math.max(28, ((clientX - bounds.left) / bounds.width) * 100)))
  }, [])

  useEffect(() => {
    bindProject(scene.projectId)
    void refreshProviderAutoGeneration()
  }, [bindProject, refreshProviderAutoGeneration, scene.projectId])

  useEffect(() => {
    if (waitingDecisionAnchorRevision === null) return
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement && focused.closest('input, textarea, [contenteditable="true"]'))) {
      decisionDefaultRef.current?.focus({ preventScroll: true })
    }
    const revealDecision = (): void => {
      const thread = threadRef.current
      const card = decisionCardRef.current
      if (thread === null || card === null) return
      const threadBounds = thread.getBoundingClientRect()
      const cardBounds = card.getBoundingClientRect()
      if (cardBounds.top < threadBounds.top || cardBounds.bottom > threadBounds.bottom) {
        card.scrollIntoView({ block: cardBounds.top < threadBounds.top ? 'start' : 'end' })
      }
    }
    revealDecision()
    let settleFrame = 0
    const frame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(revealDecision)
    })
    const observer = new ResizeObserver(revealDecision)
    const thread = threadRef.current
    const card = decisionCardRef.current
    if (thread !== null) observer.observe(thread)
    if (card !== null) {
      observer.observe(card)
      if (card.parentElement !== null) observer.observe(card.parentElement)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(settleFrame)
      observer.disconnect()
    }
  }, [waitingDecisionAnchorRevision])

  useEffect(() => {
    if (annotationStatus !== 'submitted') return
    const submitted = useEphemeralAnnotationStore.getState()
    const ownsAnnotation = (): boolean => {
      const current = useEphemeralAnnotationStore.getState()
      return isCurrentProject() && current.projectId === scene.projectId
        && current.turnId === submitted.turnId && current.runId === annotationRunId
        && current.status === 'submitted'
    }
    if (!ownsAnnotation()) return
    if (annotationJobId !== null) {
      let disposed = false
      let timer: number | null = null
      const observe = async (): Promise<void> => {
        try {
          const jobs = await window.desktop.listGenerationJobs()
          if (disposed || !ownsAnnotation() || useEphemeralAnnotationStore.getState().jobId !== annotationJobId) return
          const job = jobs.find((candidate) => candidate.id === annotationJobId)
          if (job?.status === 'completed') {
            clearAnnotation()
            return
          }
          if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
            useEphemeralAnnotationStore.getState().markFailed(job.error?.message ?? '图片处理未完成；标注与原要求已保留。')
            return
          }
        } catch {
          // A transient read failure must not discard the retained one-turn annotation.
        }
        if (!disposed) timer = window.setTimeout(() => void observe(), 120)
      }
      void observe()
      return () => {
        disposed = true
        if (timer !== null) window.clearTimeout(timer)
      }
    }
    if (snapshot === null || annotationRunId === null) return
    const run = snapshot.runs.find((candidate) => candidate.id === annotationRunId)
    if (run === undefined) return
    const jobActivity = snapshot.activities.find((activity) => activity.runId === run.id && activity.jobId !== null)
    const receiptJobId = snapshot.messages.find((message) => message.runId === run.id && message.receipt?.jobId != null)?.receipt?.jobId
    const linkedJobId = jobActivity?.jobId ?? receiptJobId ?? null
    if (linkedJobId !== null) useEphemeralAnnotationStore.getState().linkJob(linkedJobId)
    if (['failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) {
      useEphemeralAnnotationStore.getState().markFailed(run.errorMessage ?? '本轮操作未完成；标注与原要求已保留。')
      return
    }
    if (run.status !== 'completed') return
    if (linkedJobId === null) {
      clearAnnotation()
      return
    }
    let disposed = false
    void window.desktop.listGenerationJobs().then((jobs) => {
      if (disposed || !ownsAnnotation() || useEphemeralAnnotationStore.getState().jobId !== linkedJobId) return
      const job = jobs.find((candidate) => candidate.id === linkedJobId)
      if (job?.status === 'completed') clearAnnotation()
      else if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
        useEphemeralAnnotationStore.getState().markFailed(job.error?.message ?? '图片处理未完成；标注与原要求已保留。')
      }
    }).catch(() => undefined)
    return () => { disposed = true }
  }, [annotationJobId, annotationRunId, annotationStatus, clearAnnotation, snapshot, isCurrentProject, scene.projectId])

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setProblem(null)
    try {
      const ephemeralAnnotation = annotationStatus === 'editing' ? currentEphemeralAnnotation() : null
      const request = await createAgentRequest(text, autoGenerate, 'selection', ephemeralAnnotation)
      if (!isCurrentProject()) return
      const run = !hasActiveTurn
        ? await window.desktop.startAgentRun(request, agentMode, effectiveIdleTaskRelation)
        : await window.desktop.inputAgentRun(request, adaptLegacyTurnInputMode(inputMode))
      if (!isCurrentProject()) return
      if (ephemeralAnnotation !== null) markAnnotationSubmitted(run.id, text)
      else if (annotationVisible) clearAnnotation()
      completeAcceptedTurn()
      if (!hasActiveTurn) setIdleTaskRelation('continue_current')
      setExplicitInputMode(null)
      await refresh()
    } catch {
      setProblem('这条要求没有送达，请重试。')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const resolveTemporaryTry = async (resolution: 'accept' | 'reject'): Promise<void> => {
    if (pendingTemporaryTurn === null) return
    setProblem(null)
    try {
      await window.desktop.resolveTemporaryAgentTurn(pendingTemporaryTurn.id, resolution)
      await refresh()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '临时方向没有完成处理；正式画布保持不变。')
    }
  }

  const retryAnnotation = async (): Promise<void> => {
    const annotation = currentEphemeralAnnotation()
    if (annotation === null || annotationRequirement.trim().length === 0 || hasActiveTurn) return
    const original = useEphemeralAnnotationStore.getState()
    const ownsAnnotation = (): boolean => {
      const current = useEphemeralAnnotationStore.getState()
      return isCurrentProject() && current.projectId === scene.projectId
        && current.turnId === original.turnId && current.runId === original.runId
        && current.jobId === original.jobId && current.status === original.status
        && current.regions === original.regions
    }
    if (!ownsAnnotation()) return
    setProblem(null)
    try {
      const failedJobId = useEphemeralAnnotationStore.getState().jobId
      if (failedJobId !== null) {
        const failedJob = (await window.desktop.listGenerationJobs()).find((job) => job.id === failedJobId)
        if (!ownsAnnotation()) return
        const overrides = failedJob?.providerId === 'mock' ? { model: 'mock-balanced' } : {}
        const retried = await window.desktop.retryGeneration(failedJobId, overrides)
        if (!ownsAnnotation()) return
        markAnnotationJobSubmitted(retried.id)
        return
      }
      const request = await createAgentRequest(annotationRequirement, autoGenerate, 'selection', annotation)
      if (!ownsAnnotation()) return
      const run = await window.desktop.startAgentRun(request, agentMode)
      if (!ownsAnnotation()) return
      markAnnotationSubmitted(run.id, annotationRequirement)
      useCreationSessionStore.getState().setAutoGenerateForNextTurn(false)
      await refresh()
    } catch {
      if (ownsAnnotation()) useEphemeralAnnotationStore.getState().markFailed('重试没有送达；标注与原要求仍然保留。')
    }
  }

  const saveAnnotation = (kind: 'mask' | 'sketch'): void => {
    const annotation = currentEphemeralAnnotation()
    if (annotation === null) return
    const saved = buildEphemeralAnnotationSaveCommands(scene, annotation, kind)
    if (saved.commands.length === 0) {
      setProblem('保存为正式蒙版前，请先选中一张图片；也可以保存为草图。')
      return
    }
    if (!execute(kind === 'mask' ? '保存本轮标注为正式蒙版' : '保存本轮标注为构图草图', saved.commands)) {
      setProblem('标注没有保存，画布保持不变。')
      return
    }
    setSelection(saved.elementIds)
    clearAnnotation()
    setAnnotationExitPrompt(false)
  }

  const toggleAnnotation = (): void => {
    if (!annotationVisible) {
      beginAnnotation(scene.projectId, annotationTarget?.id ?? null)
      setAnnotationExitPrompt(false)
      return
    }
    if (annotationRegions.length > 0) {
      setAnnotationExitPrompt(true)
      return
    }
    clearAnnotation()
  }

  const cancel = async (): Promise<void> => {
    if (activeRun === null) return
    try {
      await window.desktop.cancelAgentRun(activeRun.id)
      await refresh()
    } catch {
      setProblem('当前操作暂时无法取消。')
    }
  }

  const confirm = async (optionId?: string): Promise<void> => {
    if (activeRun?.status !== 'awaiting_confirmation') return
    try {
      await window.desktop.confirmAgentRun(activeRun.id, optionId)
      await refresh()
    } catch {
      setProblem('确认没有生效，请重试。')
    }
  }

  const locateActivity = (activity: AgentActivity): void => {
    const elementIds = activity.affectedIds.filter((id) => scene.elements.some((element) => element.id === id))
    if (elementIds.length > 0) {
      setSelection(elementIds)
      setActiveView('canvas')
      return
    }
    if (activity.jobId !== null || activity.kind === 'generation') setActiveView('generate')
  }

  const undoActivity = async (activity: Pick<AgentActivity, 'operationBatchId'>): Promise<void> => {
    if (activity.operationBatchId === null) return
    if (!await undoBatch(activity.operationBatchId)) {
      setProblem('这项修改后已有其他画布操作。请先撤销较新的操作。')
      return
    }
    await refresh()
  }

  const recoverActivity = (activity: AgentActivity): void => {
    if (activity.kind === 'generation' || activity.jobId !== null) {
      setActiveView('generate')
      return
    }
    const source = snapshot?.messages.find((message) => message.runId === activity.runId && message.role === 'user')
    if (source !== undefined) {
      setDraft(source.content)
      setProblem(null)
    }
  }

  const restoreCurrentRequest = (): void => {
    const source = [...presentedMessages].reverse().find((message) => message.role === 'user')
    if (source === undefined) {
      setProblem('没有找到可恢复的原要求；作品保持不变。')
      return
    }
    setDraft(source.content)
    setProblem(null)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const applyDirection = async (
    messageId: string,
    sourceRunId: string | null,
    briefId: string | undefined,
    direction: PresentedDesignDirection,
    resolution: 'strict' | 'replace_agent_structure' = 'strict'
  ): Promise<void> => {
    const currentBriefId = scene.creativeContext?.brief.id
    const resolvedBriefId = briefId ?? currentBriefId
    if (sourceRunId === null || resolvedBriefId === undefined) {
      setProblem('这个旧方向缺少可验证的创作上下文，请让 Agent 重新给出方向。')
      return
    }
    const key = `${messageId}:${direction.id}`
    setDirectionApplyingKey(key)
    setDirectionNotice(null)
    setProblem(null)
    try {
      const result = await window.desktop.selectDesignDirection({
        sourceRunId,
        briefId: resolvedBriefId,
        directionId: direction.id,
        expectedSceneRevision: scene.revision,
        resolution
      })
      if (result.status === 'applied' || result.status === 'unchanged') {
        setDirectionConflict(null)
        setDirectionNotice({ key, message: result.message })
        await refresh()
        return
      }
      if (result.status === 'conflict') {
        setDirectionConflict({ key, sourceRunId, briefId: resolvedBriefId, direction, result })
        return
      }
      setDirectionConflict(null)
      setProblem(result.message)
    } catch {
      setProblem('方向切换没有完成，画布保持原样。请刷新后重试。')
    } finally {
      setDirectionApplyingKey(null)
    }
  }

  const keepConflictScene = (): void => {
    if (directionConflict !== null) {
      setDirectionNotice({ key: directionConflict.key, message: '已保留当前画布，没有切换方向。' })
    }
    setDirectionConflict(null)
  }

  const undoBeforeDirectionSwitch = (): void => {
    setDirectionConflict(null)
    setActiveView('canvas')
  }

  const tryDirectionTemporarily = (): void => {
    if (directionConflict === null) return
    setIdleTaskRelation('temporary_try')
    setDraft(`临时试用设计方向“${directionConflict.direction.title}”：${directionConflict.direction.difference}`)
    setDirectionConflict(null)
    setProblem(null)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const reviseCreativeBrief = (): void => {
    setDraft('修正当前创作简报：')
    setProblem(null)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const closeContext = (): void => {
    setContextOpen(false)
    window.setTimeout(() => contextButtonRef.current?.focus(), 0)
  }

  const creativeBrief = scene.creativeContext?.brief ?? null
  const workTitle = creativeBrief?.text.find((item) => item.content.trim().length > 0)?.content ?? '当前作品'
  const settledExecution = executionFlow?.state === 'completed' && displayTurn?.status === 'completed'
  return (
    <div className="conversation-view">
      {header}
      <main
        ref={workspaceRef}
        className={`conversation-workspace${compactRecordOpen ? ' is-record-open' : ''}`}
        style={{ '--conversation-ratio': `${conversationRatio}%` } as CSSProperties}
      >
        <section className="conversation-document" aria-label="创作对话">
          <div className="conversation-title">
            <div className="conversation-title-row">
              <span>创作记录</span>
              <button type="button" className="compact-preview-toggle" onClick={() => setCompactRecordOpen(false)}><PanelRightOpen size={15} />返回作品</button>
            </div>
            <h1>{workTitle}</h1>
            <p>{scene.canvas.aspectWidth}:{scene.canvas.aspectHeight} · 可编辑画布 · {scene.elements.length} 个元素</p>
            {creativeBrief !== null && <CreativeBriefSummary brief={creativeBrief} onRevise={reviseCreativeBrief} />}
          </div>
          <div ref={threadRef} className="conversation-thread" aria-live="polite">
            {snapshot?.messages.length === 0 && (
              <div className="conversation-opening">
                <Circle size={11} fill="currentColor" />
                <strong>从作品需要的内容开始</strong>
                <p>例如：创建一张 3:2 的雨夜唱片封面，人物在左下，标题在右上。先不要生成图片。</p>
              </div>
            )}
            {historicalRuns.length > 0 && (
              <nav className="conversation-chapters" aria-label="创作任务记录">
                <button type="button" className="chapter-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)}>
                  <span><Files size={12} />早期创作记录</span>
                  <small>{historicalRuns.length} 个任务</small>
                  <ChevronDown size={12} />
                </button>
                {historyOpen && (
                  <div className="chapter-history-list">
                    {visibleHistoryRuns.map((run) => (
                      <button key={run.id} type="button" className={inspectedRunId === run.id ? 'is-active' : ''} aria-pressed={inspectedRunId === run.id} onClick={() => setInspectedRunId(run.id)}>
                        <span>{snapshot === null ? '早期创作任务' : taskTitle(snapshot, run)}</span>
                        <small>{runStatusCopy(run)} · {new Date(run.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small>
                        <ChevronRight size={11} />
                      </button>
                    ))}
                    {visibleHistoryRuns.length < historicalRuns.length && <button type="button" className="chapter-load-more" onClick={() => setHistoryVisibleCount((current) => current + 8)}>再显示 {Math.min(8, historicalRuns.length - visibleHistoryRuns.length)} 个任务</button>}
                  </div>
                )}
              </nav>
            )}
            {inspectedRun !== null && (
              <div className="inspected-task-heading">
                <span>正在查看早期任务</span>
                <strong>{taskTitle(snapshot as ConversationSnapshot, inspectedRun)}</strong>
                <button type="button" onClick={() => setInspectedRunId(null)}>返回当前任务</button>
              </div>
            )}
            {presentedMessages.map((message, index) => (
              <article
                key={message.id}
                ref={index === presentedMessages.length - 1 ? latestMessageRef : undefined}
                className={`conversation-message is-${message.role}${message.kind === 'error' ? ' has-error' : ''}`}
              >
                <div className="message-byline">
                  <span>{message.role === 'user' ? '你' : '助手'}</span>
                  {message.role === 'assistant' && message.kind !== 'error' && <Check size={12} />}
                </div>
                <p>{message.content}</p>
                {message.attachments.length > 0 && (
                  <div className="message-attachments">
                    {message.attachments.map((attachment) => <span key={`${attachment.kind}-${attachment.id}`}>{attachment.name}</span>)}
                  </div>
                )}
                {message.receipt !== null && (
                  <div className="operation-receipt" data-testid="operation-receipt">
                    {message.receipt.completion !== undefined && <CompletionReview facts={message.receipt.completion} sceneRevision={scene.revision}
                      busy={acceptingReviewId !== null} onAccept={() => void acceptReview(message.id)} />}
                    {message.receipt.items.map((item, index) => (
                      <div key={`${item.object}-${index}`}>
                        <span>{item.object}</span>
                        <strong>{item.action}</strong>
                        <small>{item.impact}</small>
                      </div>
                    ))}
                    {message.receipt.designReview !== undefined && (
                      <details className="design-review-record" open={(message.receipt.designReview.directions.length > 1
                        && !message.receipt.designReview.directions.some((direction) => direction.id === scene.creativeContext?.selectedDirectionId))
                        || directionConflict !== null ? true : undefined}>
                        <summary><span>方向与结构检查</span><small>{message.receipt.designReview.recommendation === 'needs_user_review' ? '需要复核' : '查看记录'}</small><ChevronDown size={14} /></summary>
                      <section className="design-direction-review" aria-label="设计方向与本地评估">
                        <header>
                          <span>设计方向</span>
                          <strong>{message.receipt.designReview.total === null ? '待检查' : `结构 ${message.receipt.designReview.total}/40`}</strong>
                        </header>
                        <div className="design-direction-grid">
                          {message.receipt.designReview.directions.map((direction) => {
                            const key = `${message.id}:${direction.id}`
                            const reviewBriefId = message.receipt?.designReview?.briefId ?? scene.creativeContext?.brief.id
                            const isCurrent = reviewBriefId === scene.creativeContext?.brief.id
                              && direction.id === scene.creativeContext?.selectedDirectionId
                            const isApplying = directionApplyingKey === key
                            const conflict = directionConflict?.key === key ? directionConflict : null
                            return (
                            <article key={direction.id} className={`${isCurrent ? 'is-selected' : ''}${isApplying ? ' is-applying' : ''}${conflict !== null ? ' has-direction-conflict' : ''}`} data-direction-id={direction.id}>
                              <small>{isCurrent ? '当前方向' : direction.recommended ? '推荐方向' : '备选方向'}</small>
                              <strong>{direction.title}</strong>
                              <p>{direction.composition}</p>
                              <span>{direction.difference}</span>
                              <details>
                                <summary>查看设计依据</summary>
                                <p>主体：{direction.subject}</p>
                                <p>文字：{direction.typography}</p>
                                <p>光影：{direction.lighting}</p>
                              </details>
                              <button
                                type="button"
                                disabled={isCurrent || isApplying || directionApplyingKey !== null}
                                aria-busy={isApplying}
                                onClick={() => void applyDirection(message.id, message.runId, message.receipt?.designReview?.briefId, direction)}
                              >{isCurrent ? '已采用' : isApplying ? '正在切换…' : '采用此方向'}</button>
                              {conflict !== null && (
                                <div className="direction-conflict-decision" role="group" aria-label="方向切换需要你的决定">
                                  <strong>画布已有新变化</strong>
                                  <p>{conflict.result.message}</p>
                                  <div>
                                    <button type="button" onClick={keepConflictScene}>保留当前</button>
                                    {conflict.result.canRetryAfterUndo && <button type="button" onClick={undoBeforeDirectionSwitch}>去画布撤销</button>}
                                    {conflict.result.canTryTemporarily && <button type="button" onClick={tryDirectionTemporarily}>临时尝试</button>}
                                    {conflict.result.canReplaceAgentStructure && (
                                      <button
                                        type="button"
                                        className="direction-replace-choice"
                                        onClick={() => void applyDirection(message.id, conflict.sourceRunId, conflict.briefId, conflict.direction, 'replace_agent_structure')}
                                      >覆盖 Agent 结构</button>
                                    )}
                                  </div>
                                </div>
                              )}
                            </article>
                          )})}
                        </div>
                        {directionNotice?.key.startsWith(`${message.id}:`) === true && <p className="direction-selection-notice" role="status">{directionNotice.message}</p>}
                        <footer>
                          <span>{message.receipt.designReview.recommendation === 'needs_user_review' ? '需要你判断是否继续调整' : '本地结构化检查已完成'}</span>
                          <small>视觉效果待你复核</small>
                        </footer>
                      </section>
                      </details>
                    )}
                    {(message.receipt.nextAction !== null || message.receipt.undoable) && (
                      <footer>
                        {message.receipt.nextAction !== null && <span>{message.receipt.nextAction}</span>}
                        {message.receipt.undoable && message.receipt.batchId !== null && <button type="button" onClick={() => void undoActivity({ operationBatchId: message.receipt?.batchId ?? null })}><RotateCcw size={12} />撤销这次修改</button>}
                      </footer>
                    )}
                  </div>
                )}
              </article>
            ))}
            {!plainCompletedReply && (executionFlow !== null || visibleActivities.length > 0 || displayRun !== null) && (
              <section className="agent-execution-shell" data-testid="agent-status" aria-label="Agent 当前创作流">
                {settledExecution && !activityExpanded && (
                  <button type="button" className="execution-record-toggle" aria-expanded={false} onClick={() => setActivityExpanded(true)}>
                    <ListFilter size={15} /><span>本轮执行记录</span><ChevronDown size={14} />
                  </button>
                )}
                {executionFlow !== null && (!settledExecution || activityExpanded) && (
                  <AgentExecutionFlowView
                    flow={executionFlow}
                    expanded={activityExpanded}
                    onToggle={() => setActivityExpanded((current) => !current)}
                    onCancel={() => void cancel()}
                    onRestoreRequest={restoreCurrentRequest}
                    showCancel={waitingDecision === null || activeRun?.status !== 'awaiting_confirmation'}
                  />
                )}
                {activityExpanded && visibleActivities.length > 0 && (
                  <section className="execution-audit" aria-label="可追溯执行记录">
                    <header>
                      <span><ListFilter size={13} /><strong>执行记录</strong><small>{presentedActivities.length} 条真实记录，最多显示最近 24 条</small></span>
                    </header>
                    <div className="activity-ledger-list">
                      {visibleActivities.map((activity) => (
                        <article key={activity.id} className={`agent-activity-card state-${activity.state}${activity.undoneAt === null ? '' : ' is-undone'}`}>
                          <span className="activity-drawing" aria-hidden="true">
                            <svg viewBox="0 0 38 38"><rect x="7" y="7" width="24" height="24" rx="6" /><path d="M12 22 C16 16, 20 25, 27 14" /></svg>
                          </span>
                          <span className="activity-copy"><small>{activity.label}</small><strong>{activityStateCopy(activity)}</strong><span>{activity.objectLabel} · {activity.actionLabel}</span></span>
                          <div className="activity-inline-detail">
                            <span>{activity.scopeLabel ?? '当前作品'}</span>
                            <small>{activity.impactLabel}</small>
                            {activity.budgetImpact !== null && (
                              <small>{activity.budgetImpact.requests} 次请求 · {activity.budgetImpact.images} 张图片{activity.budgetImpact.maxCny > 0 ? ` · 预估上限 ¥${activity.budgetImpact.maxCny.toFixed(2)}` : ' · 本地生成不计费'}</small>
                            )}
                            <small>{timeCopy(activity.startedAt, activity.endedAt)} · 可追溯执行</small>
                            {activity.events.length > 1 && <small>{activity.events.length} 个状态事件，最后：{activity.events.at(-1)?.summary}</small>}
                          </div>
                          <span className="activity-actions">
                            {(activity.affectedIds.length > 0 || activity.jobId !== null) && <button type="button" aria-label={`定位：${activity.label}`} onClick={() => locateActivity(activity)}><Crosshair size={11} />定位</button>}
                            {activity.operationBatchId !== null && activity.undoneAt === null && <button type="button" aria-label={`撤销：${activity.label}`} onClick={() => void undoActivity(activity)}><RotateCcw size={11} />撤销</button>}
                            {activity.recoverable && ['failed', 'cancelled', 'interrupted'].includes(activity.state) && <button type="button" aria-label={`重新发起：${activity.label}`} onClick={() => recoverActivity(activity)}><RotateCcw size={11} />重新发起</button>}
                            {activity.state === 'completed' && activity.operationBatchId === null && <span className="activity-finished-mark"><Check size={11} />已记录</span>}
                          </span>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {waitingDecision !== null && activeRun?.status === 'awaiting_confirmation' && (
                  <div ref={decisionCardRef} className="decision-card" role="group" aria-labelledby={`decision-${waitingDecision.id}`}>
                    <span className="decision-mark" aria-hidden="true"><svg viewBox="0 0 38 38"><rect x="7" y="7" width="24" height="24" rx="6" /><path d="M12 22 C16 16, 20 25, 27 14" /></svg></span>
                    <div className="decision-copy">
                      <small>需要你的决定</small>
                      <strong id={`decision-${waitingDecision.id}`}>{waitingDecision.title}</strong>
                      <p>{waitingDecision.consequence}</p>
                    </div>
                    <div className="decision-options">
                      {waitingDecision.options.map((option) => (
                        <button
                          key={option.id}
                          ref={option.id === waitingDecision.defaultOptionId ? decisionDefaultRef : undefined}
                          type="button"
                          className={option.id === waitingDecision.defaultOptionId ? 'is-default' : ''}
                          aria-label={waitingDecision.kind === 'generation_confirmation' && option.id === waitingDecision.defaultOptionId ? '确认生成' : option.label}
                          aria-describedby={`decision-consequence-${waitingDecision.id}-${option.id}`}
                          onClick={() => void confirm(option.id)}
                        >
                          <span>{option.label}</span>
                          <small id={`decision-consequence-${waitingDecision.id}-${option.id}`}>{option.consequence}</small>
                        </button>
                      ))}
                      <button type="button" className="decision-cancel" aria-label="停止当前操作" onClick={() => void cancel()}><Square size={10} />取消本轮</button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {problem !== null && <p className="conversation-problem" role="alert">{problem}</p>}
          </div>
          {contextOpen && <AgentContextSheet harness={harness} knowledge={knowledge} onClose={closeContext} />}
          <form
            className={`conversation-composer glass-surface composer-${composerState}`}
            data-composer-state={composerState}
            onSubmit={(event) => void submit(event)}
          >
            {submitting && <p className="execution-send-receipt" role="status">已接收要求 · 正在准备作品上下文，尚未代表模型已执行。</p>}
            {pendingTemporaryTurn !== null && (
              <div className="temporary-try-resolution" data-testid="temporary-try-resolution">
                <div><strong>临时方向待决定</strong><span>候选仍在隔离区，尚未写入正式画布与项目记忆。</span></div>
                <button type="button" onClick={() => void resolveTemporaryTry('accept')}>接受并写入</button>
                <button type="button" className="quiet-choice" onClick={() => void resolveTemporaryTry('reject')}>放弃</button>
              </div>
            )}
            {!hasActiveTurn && (
              <div className="task-relation-modes" role="group" aria-label="这条要求与当前任务的关系">
                {(['continue_current', 'new_task', 'temporary_try'] as const).map((relation) => (
                  <button
                    key={relation}
                    type="button"
                    className={effectiveIdleTaskRelation === relation ? 'is-active' : ''}
                    aria-pressed={effectiveIdleTaskRelation === relation}
                    title={TASK_RELATION_COPY[relation].note}
                    onClick={() => setIdleTaskRelation(relation)}
                  >{TASK_RELATION_COPY[relation].label}</button>
                ))}
              </div>
            )}
            {(harness?.queue.some((entry) => entry.status === 'queued' || entry.status === 'paused') ?? false) && (
              <div className="task-queue-summary" aria-label="排队任务">
                {harness?.queue.filter((entry) => entry.status === 'queued' || entry.status === 'paused').slice(0, 3).map((entry) => (
                  <span key={entry.id}>排队 · {entry.taskRelation === null ? '旧任务关系未记录' : TASK_RELATION_COPY[entry.taskRelation].label}{entry.status === 'paused' ? ' · 已暂停' : ''}</span>
                ))}
              </div>
            )}
            {selectedElements.length > 0 && (
              <div className="selection-context" aria-label="当前选区">
                <span>作用于</span>
                {selectedElements.map((element) => (
                  <button key={element.id} type="button" onClick={() => setSelection(selectedIds.filter((id) => id !== element.id))}>
                    {element.name}<X size={10} />
                  </button>
                ))}
              </div>
            )}
            {hasActiveTurn && (
              <div className="turn-input-modes" role="group" aria-label="这条消息如何加入当前工作">
                {(Object.keys(INPUT_MODE_COPY) as TurnInputMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={inputMode === mode ? 'is-active' : ''}
                    aria-pressed={inputMode === mode}
                    title={INPUT_MODE_COPY[mode].note}
                    onClick={() => activeTurnIdentity !== null && setExplicitInputMode({ turnId: activeTurnIdentity, mode })}
                  >
                    {INPUT_MODE_COPY[mode].label}
                    {!inputModeTouched && recommendedInputMode(draft) === mode && <small>推荐</small>}
                  </button>
                ))}
              </div>
            )}
            <div className="conversation-input-row">
              <span className="composer-leading-mark" aria-hidden="true" />
              <textarea
                maxLength={8000}
                ref={inputRef}
                aria-label="对话输入"
                rows={2}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onCompositionStart={() => { inputComposingRef.current = true }}
                onCompositionEnd={() => { inputComposingRef.current = false }}
                onBlur={() => { inputComposingRef.current = false }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !inputComposingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                    event.preventDefault()
                    void submit()
                  }
                }}
                placeholder={hasActiveTurn
                  ? `${INPUT_MODE_COPY[inputMode].label}：${INPUT_MODE_COPY[inputMode].note}…`
                  : selectedElements.length > 0 ? '描述要怎样调整选中的元素…' : '描述你想创建或调整的画面…'}
              />
              <button type="submit" className="send-button" aria-label="发送要求" disabled={submitting || draft.trim().length === 0}><ArrowUp size={16} /></button>
            </div>
            <div className="conversation-composer-meta">
              <div className="composer-meta-primary">
                <span><span className="composer-state-label">{COMPOSER_STATE_COPY[composerState]}</span>{annotationRegions.length > 0 ? `临时圈选 · ${annotationRegions.length} 区` : selectedElements.length > 0 ? `选中元素 · ${selectedElements.length} 个` : `当前画布 · ${scene.elements.length} 个元素`}</span>
                <button ref={contextButtonRef} type="button" className="context-sheet-trigger" aria-expanded={contextOpen} onClick={() => setContextOpen(true)}><Files size={11} />本轮上下文</button>
              </div>
              <div className="composer-meta-controls">
                <div className="agent-mode-selector" role="group" aria-label="Agent 模式">
                  {(Object.keys(AGENT_MODE_COPY) as AgentMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={effectiveAgentMode === mode ? 'is-active' : ''}
                      aria-pressed={effectiveAgentMode === mode}
                      disabled={hasActiveTurn}
                      title={AGENT_MODE_COPY[mode].note}
                      onClick={() => setAgentMode(mode)}
                    >{AGENT_MODE_COPY[mode].label}</button>
                  ))}
                </div>
                <label className="inline-toggle" title={autoGenerationCopy.title}><input type="checkbox" checked={autoGenerate} disabled={!autoGenerationCopy.enabled || hasActiveTurn} onChange={(event) => setAutoGenerate(event.currentTarget.checked)} /><span>{autoGenerationCopy.label}</span></label>
              </div>
            </div>
          </form>
        </section>
        <button
          type="button"
          className="conversation-divider"
          role="separator"
          aria-label="调整对话和实时画布宽度"
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={48}
          aria-valuenow={Math.round(conversationRatio)}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            resizingPointerRef.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
            updateConversationRatio(event.clientX)
          }}
          onPointerMove={(event) => {
            if (resizingPointerRef.current === event.pointerId) updateConversationRatio(event.clientX)
          }}
          onPointerUp={(event) => {
            if (resizingPointerRef.current !== event.pointerId) return
            resizingPointerRef.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { resizingPointerRef.current = null }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setConversationRatio((current) => Math.min(48, Math.max(28, current + (event.key === 'ArrowRight' ? 2 : -2))))
          }}
        >
          <GripVertical size={12} />
        </button>
        <aside className="conversation-preview" aria-label="实时画布预览">
          <div className="preview-heading">
            <div><span>当前画布</span><strong>可编辑草案</strong></div>
            <div className="preview-actions">
              <button type="button" className="compact-record-toggle" aria-expanded={compactRecordOpen} onClick={() => setCompactRecordOpen(true)}><PanelRightClose size={15} />创作记录</button>
              <button type="button" className={annotationVisible ? 'is-active' : ''} aria-pressed={annotationVisible} onClick={toggleAnnotation}><Pencil size={11} />临时标注</button>
              <button type="button" onClick={() => setActiveView('canvas')}>打开画布</button>
            </div>
          </div>
          <div className={`conversation-live-canvas${annotationEditable ? ' is-annotating' : ''}`} style={{ '--scene-reflection': scene.canvas.backgroundColor } as CSSProperties}>
            <CanvasStage
              preview
              ephemeralAnnotationEnabled={annotationEditable}
              ephemeralAnnotationRegions={annotationRegions}
              ephemeralAnnotationTool={annotationTool}
              ephemeralAnnotationMode={annotationMode}
              onEphemeralAnnotationComplete={addAnnotationRegion}
              onEphemeralAnnotationErase={removeAnnotationRegion}
            />
            {annotationVisible && (
              <div className="ephemeral-annotation-controls glass-surface" data-testid="ephemeral-annotation-controls">
                <div className="annotation-control-row annotation-modes" role="group" aria-label="标注语义">
                  {([['edit', '修改区'], ['generate', '生成区'], ['protect', '保护区']] as const).map(([mode, label]) => (
                    <button key={mode} type="button" className={annotationMode === mode ? 'is-active' : ''} aria-pressed={annotationMode === mode} disabled={!annotationEditable} onClick={() => setAnnotationMode(mode)}><span className={`annotation-swatch is-${mode}`} />{label}</button>
                  ))}
                </div>
                <div className="annotation-control-row annotation-tools" role="group" aria-label="标注工具">
                  {([['paint', '画笔'], ['lasso', '套索'], ['rect', '矩形'], ['erase', '擦除']] as const).map(([tool, label]) => (
                    <button key={tool} type="button" className={annotationTool === tool ? 'is-active' : ''} aria-pressed={annotationTool === tool} disabled={!annotationEditable} onClick={() => setAnnotationTool(tool)}>{label}</button>
                  ))}
                </div>
                <div className="annotation-context">
                  <span><Pencil size={11} />仅本轮 · {retainedAnnotationTarget?.name ?? annotationTarget?.name ?? '画布空间'} · {annotationRegions.length} 区</span>
                  {annotationRegions.length > 0 && <button type="button" aria-label="清除临时标注" disabled={!annotationEditable} onClick={clearAnnotation}><Trash2 size={11} /></button>}
                </div>
                {annotationStatus === 'failed' && (
                  <div className="annotation-failure" role="alert">
                    <span><strong>已保留，可继续</strong>{annotationFailure}</span>
                    <button type="button" onClick={() => void retryAnnotation()}><RotateCcw size={11} />原样重试</button>
                  </div>
                )}
                {annotationStatus === 'submitted' && <div className="annotation-submitted"><span className="annotation-pulse" />处理中，完成后自动清除</div>}
                {annotationRegions.length > 0 && annotationStatus !== 'submitted' && (
                  <div className="annotation-save-row">
                    <button type="button" disabled={annotationTargetId === null} onClick={() => saveAnnotation('mask')}>保存为蒙版</button>
                    <button type="button" onClick={() => saveAnnotation('sketch')}>保存为草图</button>
                  </div>
                )}
                {annotationExitPrompt && (
                  <div className="annotation-exit-prompt" role="alert">
                    <span>关闭会清除本轮标注。</span>
                    <button type="button" onClick={() => setAnnotationExitPrompt(false)}>继续标注</button>
                    <button type="button" className="is-destructive" onClick={() => { clearAnnotation(); setAnnotationExitPrompt(false) }}>清除并关闭</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <footer className="preview-footer">
            <span><Image size={12} />{scene.canvas.aspectWidth}:{scene.canvas.aspectHeight}</span>
            <span>{scene.canvas.outputWidth} × {scene.canvas.outputHeight}</span>
            <span>{scene.elements.length} 个元素</span>
          </footer>
        </aside>
      </main>
    </div>
  )
}
