import {
  agentRequestSchema,
  type AgentPlan,
  type AgentRequest,
  type AgentRun,
  type AgentToolOutcome,
  type ConversationSnapshot,
  type OperationReceipt,
  type OperationReceiptItem
} from '../../shared/agent'
import {
  adaptLegacyTurnInputMode,
  agentTaskInputSchema,
  type AgentEvent,
  type AgentHarnessSnapshot,
  type AgentMode,
  type AgentTaskDispatch,
  type TaskRelation,
  type TurnInputMode
} from '../../shared/agent-harness'
import type {
  CreateMemoryCandidateInput,
  CreateProjectDirectiveInput,
  CreateProjectMemoryInput,
  ProjectKnowledgeSnapshot,
  ResolveMemoryCandidateInput,
  SetOutboundPolicyInput,
  UpdateProjectDirectiveInput,
  UpdateProjectMemoryInput
} from '../../shared/agent-context'
import type { GenerationJob } from '../../shared/generation'
import type { ConversationRepository } from './conversation-repository'
import { GenerationPolicy } from './generation-policy'
import type { AgentPlanner } from './planner'
import { DeterministicCreativePlannerAdapter, type PlannerAdapter } from './planner-adapter'
import {
  decisionFor,
  PersistentAgentLoop,
  type AgentLoopProjection,
  type AgentLoopToolContext
} from './persistent-agent-loop'
import type { AgentHarnessRepository } from './agent-harness-repository'
import type { AgentContextRepository } from './agent-context-repository'
import type { ActivityLedgerRepository } from './activity-ledger-repository'
import { RedactedLogger, redactSensitive, type DiagnosticLogger } from '../security/redacted-logger'
import type { AgentToolExecutorShadow } from './agent-tool-executor-shadow'
import type { GenerationWorkflowRepository } from '../generation/generation-workflow-repository'
import { turnModelUsage } from './multi-step/trace'

export interface AgentRuntimeOptions {
  readonly projectId: string
  readonly repository: ConversationRepository
  readonly planner: AgentPlanner
  readonly generationPolicy?: GenerationPolicy
  readonly maxSteps?: number
  readonly now?: () => string
  readonly logger?: DiagnosticLogger
  readonly activityLedger?: ActivityLedgerRepository
  readonly toolExecutor?: AgentToolExecutorShadow
  readonly harnessRepository: AgentHarnessRepository
  readonly contextRepository?: AgentContextRepository
  readonly plannerAdapter?: PlannerAdapter
  readonly executePersistentTool: (tool: AgentPlan['tools'][number], context: AgentLoopToolContext) => Promise<AgentToolOutcome>
  readonly refreshPersistentRequest?: (request: AgentRequest) => Promise<AgentRequest>
  readonly generationWorkflowRepository?: GenerationWorkflowRepository
  readonly loadGenerationJob?: (jobId: string) => Promise<GenerationJob>
  readonly activateGenerationJob?: (jobId: string) => Promise<void>
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

export function receiptItem(plan: AgentPlan['tools'][number], outcome: AgentToolOutcome): OperationReceiptItem {
  const failedImpact = plan.kind === 'scene_batch'
    ? '画布修改未提交，没有产生部分变更'
    : plan.kind === 'cancel_generation'
      ? '任务状态没有改变，可以从生成页重试'
      : '任务未创建，可以检查设置后重试'
  if (plan.kind === 'scene_batch') {
    const added = plan.commands.filter((command) => command.kind === 'element.add').length
    const removed = plan.commands.filter((command) => command.kind === 'element.remove').length
    const visibleCount = added > 0 ? added : removed > 0 ? removed : outcome.affectedElementIds.length
    return {
      object: visibleCount === 0 ? '画布' : `${visibleCount} 个元素`,
      action: plan.summary,
      impact: outcome.ok ? '已形成一个可撤销批次' : failedImpact
    }
  }
  if (plan.kind.startsWith('scene.') || plan.kind === 'history.undo_batch') {
    const reading = plan.kind === 'scene.get_summary' || plan.kind === 'scene.get_elements'
    return {
      object: outcome.affectedElementIds.length === 0 ? '画布' : `${outcome.affectedElementIds.length} 个元素`,
      action: 'summary' in plan ? plan.summary : reading ? '读取画布' : '撤销画布修改',
      impact: outcome.ok ? reading ? '已读取当前画布事实' : '画布修改已提交，可撤销' : '画布修改未提交'
    }
  }
  if (plan.kind === 'generation') {
    return { object: '生成任务', action: '创建图片生成', impact: outcome.ok ? '已进入项目任务队列' : failedImpact }
  }
  if (plan.kind === 'canvas_generation') {
    return plan.mode === 'unified'
      ? { object: '当前画布', action: '统一重绘除文字外的画面', impact: outcome.ok ? '画布未改变，放回后原图层保留在下面' : failedImpact }
      : { object: '当前画布', action: '编译参考并生成完整图', impact: outcome.ok ? '参考资产与任务已保存' : failedImpact }
  }
  if (plan.kind === 'canvas_edit') {
    return plan.mode === 'in-context'
      ? { object: '目标区域', action: '参照下方画面重画这一块', impact: outcome.ok ? '画布未改变，放回时裁出并融入画面' : failedImpact }
      : { object: '选中图片', action: '按蒙版创建局部修改', impact: outcome.ok ? '源图、蒙版与新版本均已保留' : failedImpact }
  }
  if (plan.kind === 'memory_candidate') {
    return { object: '项目记忆', action: '提出候选', impact: outcome.ok ? '等待用户确认，不会静默进入长期上下文' : '没有创建记忆候选' }
  }
  if (plan.kind === 'directive_create') {
    return { object: '项目规则', action: '写入已确认规则', impact: outcome.ok ? '后续轮次将采用，可在设置中停用' : '项目规则没有改变' }
  }
  if (plan.kind === 'place_generation_result' || plan.kind === 'result.place_on_canvas') {
    return { object: '生成结果', action: plan.targetElementId === undefined ? '放入画布' : '替换目标图片', impact: outcome.ok ? '图片已放入画布，可一次撤销' : '画布没有改变' }
  }
  return { object: '生成任务', action: '取消生成', impact: outcome.ok ? '任务已停止，已有结果保持不变' : failedImpact }
}

export class AgentRuntime {
  readonly #projectId: string
  readonly #repository: ConversationRepository
  readonly #generationPolicy: GenerationPolicy
  readonly #maxSteps: number
  readonly #now: () => string
  readonly #logger: DiagnosticLogger
  readonly #activityLedger: ActivityLedgerRepository | null
  readonly #toolExecutor: AgentToolExecutorShadow | null
  readonly #persistentLoop: PersistentAgentLoop
  readonly #contextRepository: AgentContextRepository | null
  #closed = false

  constructor(options: AgentRuntimeOptions) {
    this.#projectId = options.projectId
    this.#repository = options.repository
    this.#generationPolicy = options.generationPolicy ?? new GenerationPolicy()
    this.#maxSteps = Math.max(1, Math.floor(options.maxSteps ?? 8))
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#logger = options.logger ?? new RedactedLogger()
    this.#activityLedger = options.activityLedger ?? null
    this.#toolExecutor = options.toolExecutor ?? null
    this.#contextRepository = options.contextRepository ?? null
    this.#persistentLoop = new PersistentAgentLoop({
      projectId: this.#projectId,
      repository: options.harnessRepository,
      ...(options.contextRepository === undefined ? {} : { contextRepository: options.contextRepository }),
      planner: options.plannerAdapter ?? new DeterministicCreativePlannerAdapter(options.planner),
      executeTool: options.executePersistentTool,
      loadRequest: (runId) => this.#repository.getRequest(runId),
      ...(options.refreshPersistentRequest === undefined ? {} : { refreshRequest: options.refreshPersistentRequest }),
      ...(options.generationWorkflowRepository === undefined ? {} : {
        generationWorkflowRepository: options.generationWorkflowRepository
      }),
      ...(options.loadGenerationJob === undefined ? {} : { loadGenerationJob: options.loadGenerationJob }),
      ...(options.activateGenerationJob === undefined ? {} : { activateGenerationJob: options.activateGenerationJob }),
      generationPolicy: this.#generationPolicy,
      now: this.#now,
      projection: this.#persistentProjection()
    })
  }

  async initialize(): Promise<number> {
    // These repositories write through separate SQLite connections. A Kysely
    // recovery transaction must commit before synchronous loop reconciliation
    // can write; parallel startup can otherwise block the event loop on its lock.
    const runs = await this.#repository.recoverInterrupted(this.#projectId)
    await this.#activityLedger?.recoverInterrupted(this.#projectId)
    await this.#toolExecutor?.initialize(this.#projectId)
    await this.#persistentLoop.initialize()
    return runs
  }

  async start(requestInput: AgentRequest, mode: AgentMode = 'collaboration', taskRelation?: TaskRelation): Promise<AgentRun> {
    this.#assertOpen()
    const parsedRequest = agentRequestSchema.parse(requestInput)
    const request = agentRequestSchema.parse({ ...parsedRequest, text: redactSensitive(parsedRequest.text) })
    const created = await this.#repository.createRun(this.#projectId, request, this.#maxSteps)
    await this.#activityLedger?.create({
      projectId: this.#projectId,
      runId: created.run.id,
      kind: 'plan',
      eventType: 'plan.queued',
      label: '理解创作要求',
      state: 'queued',
      progress: 0,
      objectLabel: request.selectedIds.length > 0 ? `${request.selectedIds.length} 个选中元素` : '当前作品',
      actionLabel: '读取场景并形成可执行计划',
      impactLabel: '尚未修改画布',
      scopeLabel: `${request.sceneSummary.canvas.aspectWidth}:${request.sceneSummary.canvas.aspectHeight} · ${request.sceneSummary.elementCount} 个元素`,
      affectedIds: request.selectedIds
    })
    this.#logger.write('info', 'agent.started', { projectId: this.#projectId }, created.run.id)
    await this.#persistentLoop.start({
      legacyRunId: created.run.id,
      sourceMessageId: created.userMessage.id,
      request,
      mode,
      ...(taskRelation === undefined ? {} : { taskRelation })
    })
    return created.run
  }

  async snapshot(): Promise<ConversationSnapshot> {
    const [conversation, activities] = await Promise.all([
      this.#repository.getSnapshot(this.#projectId),
      this.#activityLedger?.list(this.#projectId) ?? Promise.resolve([])
    ])
    return { ...conversation, activities }
  }

  async harnessSnapshot(): Promise<AgentHarnessSnapshot> {
    return this.#persistentLoop.snapshot()
  }

  async acceptDesignReview(messageId: string, sceneRevision: number, validateCurrentScene: () => void): Promise<ConversationSnapshot> {
    this.#repository.recordDesignAcceptance(this.#projectId, messageId, sceneRevision, validateCurrentScene)
    return this.snapshot()
  }

  async getProjectKnowledge(): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async recordDesignDirectionSelection(input: {
    readonly sourceRunId: string
    readonly directionTitle: string
    readonly batchId: string
    readonly affectedElementIds: readonly string[]
  }): Promise<void> {
    const receipt: OperationReceipt = {
      summary: `切换设计方向：${input.directionTitle}`,
      items: [{
        object: `${input.affectedElementIds.length} 个设计元素`,
        action: `采用“${input.directionTitle}”`,
        impact: 'ScenePlan、元素来源与画布已在一个可撤销批次中更新'
      }],
      batchId: input.batchId,
      jobId: null,
      nextAction: '可以继续调整，或撤销这次方向切换。',
      undoable: true
    }
    await this.#repository.appendAssistantMessage(
      input.sourceRunId,
      'receipt',
      `已切换到“${input.directionTitle}”。画布与结构化计划保持同一方向。`,
      receipt
    )
    await this.#activityLedger?.create({
      projectId: this.#projectId,
      runId: input.sourceRunId,
      kind: 'receipt',
      eventType: 'direction.completed',
      label: '设计方向已切换',
      state: 'completed',
      progress: 1,
      objectLabel: '当前作品',
      actionLabel: `采用“${input.directionTitle}”`,
      impactLabel: 'ScenePlan、元素来源与画布已同步，可一次撤销',
      scopeLabel: `${input.affectedElementIds.length} 个 Agent 管理元素`,
      affectedIds: input.affectedElementIds,
      operationBatchId: input.batchId,
      recoverable: false
    })
  }

  async createProjectDirective(input: CreateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.createDirective(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async updateProjectDirective(input: UpdateProjectDirectiveInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.updateDirective(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async createProjectMemory(input: CreateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.createMemory(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async updateProjectMemory(input: UpdateProjectMemoryInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.updateMemory(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async createMemoryCandidate(input: CreateMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.createCandidate(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async resolveMemoryCandidate(input: ResolveMemoryCandidateInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.resolveCandidate(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async setOutboundPolicy(input: SetOutboundPolicyInput): Promise<ProjectKnowledgeSnapshot> {
    if (this.#contextRepository === null) throw new Error('Agent context repository is unavailable.')
    await this.#contextRepository.setOutboundPolicy(this.#projectId, input)
    return this.#contextRepository.getSnapshot(this.#projectId)
  }

  async replayHarnessEvents(afterSequence: number, limit = 1_000): Promise<readonly AgentEvent[]> {
    return this.#persistentLoop.replay(afterSequence, limit)
  }

  subscribeHarness(listener: (event: AgentEvent) => void): () => void {
    return this.#persistentLoop.subscribe(listener)
  }

  observeGenerationJob(job: GenerationJob): Promise<void> {
    return this.#persistentLoop.observeGenerationJob(job)
  }

  async input(requestInput: AgentRequest, semantics: TurnInputMode | AgentTaskDispatch): Promise<AgentRun> {
    this.#assertOpen()
    const request = agentRequestSchema.parse(requestInput)
    const taskInput = agentTaskInputSchema.parse({
      ...(typeof semantics === 'string' ? adaptLegacyTurnInputMode(semantics) : semantics),
      request
    })
    const harness = await this.#persistentLoop.snapshot()
    const activeTurn = harness.thread.activeTurnId === null
      ? null
      : harness.turns.find((turn) => turn.id === harness.thread.activeTurnId) ?? null
    let resultRun: AgentRun | null = null
    if (activeTurn?.inputMessageId !== null && activeTurn?.inputMessageId !== undefined && taskInput.dispatchMode !== 'queue_after_current') {
      if (taskInput.dispatchMode !== 'interrupt_current') await this.#repository.appendUserMessage(activeTurn.inputMessageId, request)
      resultRun = await this.#repository.getRun(activeTurn.inputMessageId)
    }
    const persistQueuedRun = async (queuedRequest: AgentRequest): Promise<{ readonly runId: string; readonly sourceMessageId: string }> => {
      const created = await this.#repository.createRun(this.#projectId, queuedRequest, this.#maxSteps)
      await this.#activityLedger?.create({
        projectId: this.#projectId,
        runId: created.run.id,
        kind: 'plan',
        eventType: 'plan.queued',
        label: '理解创作要求',
        state: 'queued',
        progress: 0,
        objectLabel: queuedRequest.selectedIds.length > 0 ? `${queuedRequest.selectedIds.length} 个选中元素` : '当前作品',
        actionLabel: taskInput.dispatchMode === 'queue_after_current' ? '等待当前回合完成后开始' : '读取场景并形成可执行计划',
        impactLabel: '尚未修改画布',
        scopeLabel: `${queuedRequest.sceneSummary.canvas.aspectWidth}:${queuedRequest.sceneSummary.canvas.aspectHeight} · ${queuedRequest.sceneSummary.elementCount} 个元素`,
        affectedIds: queuedRequest.selectedIds
      })
      resultRun = created.run
      return { runId: created.run.id, sourceMessageId: created.userMessage.id }
    }
    await this.#persistentLoop.input(taskInput, persistQueuedRun)
    if (taskInput.dispatchMode === 'interrupt_current' && activeTurn?.inputMessageId !== null && activeTurn?.inputMessageId !== undefined) {
      return this.#repository.getRun(activeTurn.inputMessageId)
    }
    if (resultRun !== null) return resultRun
    const latest = (await this.#repository.getSnapshot(this.#projectId)).runs[0]
    if (latest === undefined) throw new Error('Agent input did not produce a compatibility run.')
    return latest
  }

  async resumeQueue(): Promise<number> {
    return this.#persistentLoop.resumeQueue()
  }

  async resolveTemporaryTry(turnId: string, resolution: 'accept' | 'reject'): Promise<AgentHarnessSnapshot> {
    await this.#persistentLoop.resolveTemporaryTry(turnId, resolution)
    return this.#persistentLoop.snapshot()
  }

  async confirm(runId: string, optionId?: string): Promise<AgentRun> {
    this.#assertOpen()
    const run = await this.#repository.getRun(runId)
    if (run.status !== 'awaiting_confirmation') throw new Error('This assistant action is not waiting for confirmation.')
    const snapshot = await this.#persistentLoop.snapshot()
    const turn = snapshot.turns.find((candidate) => candidate.inputMessageId === runId && candidate.status === 'waiting_decision')
    const decision = turn === undefined ? undefined : snapshot.items.find(
      (item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting'
    )
    if (turn === undefined || decision === undefined) throw new Error('The persistent agent decision is unavailable.')
    const proposal = decision.payload as { readonly proposal?: { readonly defaultOptionId?: string } }
    await this.#persistentLoop.resolveDecision(turn.id, decision.id, optionId ?? proposal.proposal?.defaultOptionId ?? 'continue')
    return this.#repository.getRun(runId)
  }

  async cancel(runId: string): Promise<AgentRun> {
    this.#assertOpen()
    const current = await this.#repository.getRun(runId)
    if (TERMINAL.has(current.status)) return current
    const request = await this.#repository.getRequest(runId)
    await this.input({ ...request, text: '停止当前操作' }, 'interrupt_now')
    return this.#repository.getRun(runId)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#persistentLoop.close()
    await this.#repository.close()
    await this.#activityLedger?.close()
    await this.#toolExecutor?.close()
  }

  #persistentProjection(): AgentLoopProjection {
    return {
      onPlanningStarted: async ({ legacyRunId }) => {
        await this.#repository.transition(legacyRunId, { status: 'planning', startedAt: this.#now() })
        await this.#activityLedger?.transitionRunActivity(legacyRunId, 'plan', 'plan.running', 'running', {
          progress: null,
          impactLabel: '正在建立持久上下文并规划下一步'
        })
      },
      onPlanReady: async ({ legacyRunId, request, plan }) => {
        const requiresDecision = decisionFor(request, plan, this.#generationPolicy) !== null
        await this.#repository.savePlan(legacyRunId, plan, requiresDecision)
        await this.#activityLedger?.transitionRunActivity(legacyRunId, 'plan', 'plan.completed', 'completed', {
          progress: 1,
          impactLabel: `已形成 ${plan.tools.length} 项计划；Harness 将逐项执行并观察`
        })
        await this.#activityLedger?.cancelToolActivities(legacyRunId, '计划已被本轮最新输入替代')
        await this.#activityLedger?.createToolActivities(this.#projectId, legacyRunId, plan)
      },
      onDecisionWaiting: async ({ legacyRunId, proposal }) => {
        const existingDecision = await this.#activityLedger?.getDecision(legacyRunId) ?? null
        // Projection callbacks are replay-safe. If this run already exposes a
        // waiting decision, publishing the same wait again must not create a
        // second activity or overwrite the interaction the user is viewing.
        if (existingDecision?.status === 'waiting') return
        const current = await this.#repository.getRun(legacyRunId)
        if (!TERMINAL.has(current.status)) {
          await this.#repository.transition(legacyRunId, {
            status: 'awaiting_confirmation',
            confirmationRequired: true,
            errorCode: null,
            errorMessage: null
          })
        }
        const activityId = await this.#activityLedger?.create({
          projectId: this.#projectId,
          runId: legacyRunId,
          kind: 'decision',
          eventType: 'decision.waiting',
          label: proposal.title,
          state: 'waiting',
          progress: null,
          objectLabel: proposal.kind === 'aspect_ratio' ? '画布比例' : '当前操作',
          actionLabel: '等待用户作出明确决定',
          impactLabel: proposal.consequence,
          scopeLabel: '当前 Agent 回合',
          budgetImpact: proposal.kind === 'generation_confirmation' ? { requests: 1, images: 1, maxCny: 0 } : null,
          recoverable: true
        })
        if (activityId !== undefined && this.#activityLedger !== null) {
          await this.#activityLedger.createDecision({
            projectId: this.#projectId,
            runId: legacyRunId,
            activityId,
            kind: proposal.kind === 'clarification' ? 'budget_alternative' : proposal.kind,
            title: proposal.title,
            consequence: proposal.consequence,
            options: proposal.options,
            defaultOptionId: proposal.defaultOptionId
          })
        }
      },
      onDecisionResolved: async ({ legacyRunId, proposal, optionId }) => {
        if (proposal.kind === 'aspect_ratio') {
          const match = optionId.match(/^(\d{1,3}):(\d{1,3})$/)
          if (match !== null) await this.#repository.setPlanAspectRatio(legacyRunId, Number(match[1]), Number(match[2]))
        }
        await this.#activityLedger?.resolveDecision(legacyRunId, optionId, proposal.kind === 'generation_confirmation' && optionId === 'keep_canvas')
        const current = await this.#repository.getRun(legacyRunId)
        if (!TERMINAL.has(current.status)) {
          await this.#repository.transition(legacyRunId, {
            status: 'awaiting_execution',
            confirmationRequired: false,
            errorCode: null,
            errorMessage: null
          })
        }
      },
      onStepPlanned: async ({ legacyRunId }) => {
        await this.#activityLedger?.transitionRunActivity(legacyRunId, 'plan', 'plan.completed', 'completed', {
          progress: 1,
          impactLabel: '逐步执行：每一步看到结果再决定下一步'
        })
      },
      onToolStarted: async ({ legacyRunId, toolIndex, tool, label }) => {
        await this.#repository.ensureToolCall(legacyRunId, toolIndex, tool)
        await this.#activityLedger?.ensureToolActivity(this.#projectId, legacyRunId, toolIndex, tool, label)
        const current = await this.#repository.getRun(legacyRunId)
        if (current.status !== 'executing') await this.#repository.transition(legacyRunId, { status: 'executing' })
        await this.#activityLedger?.transitionTool(legacyRunId, toolIndex, 'tool.running', 'running')
      },
      onToolFinished: async ({ legacyRunId, outcome }) => {
        await this.#repository.recordToolOutcome(legacyRunId, outcome.toolIndex, {
          ok: outcome.ok,
          result: outcome,
          errorMessage: outcome.ok ? null : outcome.message
        })
        await this.#activityLedger?.transitionTool(
          legacyRunId,
          outcome.toolIndex,
          outcome.ok ? 'tool.completed' : 'tool.failed',
          outcome.ok ? 'completed' : 'failed',
          outcome
        )
      },
      onCompleted: async ({ legacyRunId, plan: projectedPlan, outcomes, assessment, items }) => {
        const plan = projectedPlan ?? await this.#repository.getPlan(legacyRunId)
        const plainReply = assessment.facts?.operationStatus === 'not_requested' && assessment.design === undefined
        const modelUsage = turnModelUsage(items)
        const receipt: OperationReceipt | null = plainReply ? null : {
          ...(assessment.facts === undefined ? {} : { completion: assessment.facts }),
          summary: plan?.summary ?? assessment.summary,
          items: plan?.tools.slice(0, outcomes.length).map((tool, index) => receiptItem(tool, outcomes[index]!)) ?? [],
          batchId: outcomes.find((outcome) => outcome.batchId !== null)?.batchId ?? null,
          jobId: outcomes.find((outcome) => outcome.jobId !== null)?.jobId ?? null,
          nextAction: assessment.nextAction,
          undoable: outcomes.some((outcome) => outcome.ok && outcome.batchId !== null),
          ...(modelUsage === null ? {} : { modelUsage }),
          ...(plan?.designContract === undefined ? {} : {
            designReview: {
              briefId: plan.designContract.brief.id,
              directions: plan.designContract.directions.map((direction) => ({
                id: direction.id,
                title: direction.title,
                recommended: direction.recommended,
                composition: direction.composition,
                subject: direction.subject,
                typography: direction.typography,
                lighting: direction.lighting,
                difference: direction.difference
              })),
              selectedDirectionId: plan.designContract.selectedDirectionId,
              capabilityPackIds: plan.designContract.capabilityPackIds,
              total: assessment.design?.design.total ?? null,
              recommendation: assessment.design?.recommendation ?? null
            }
          })
        }
        await this.#repository.appendAssistantMessage(
          legacyRunId,
          plainReply ? 'text' : 'receipt',
          assessment.summary,
          receipt
        )
        if (!plainReply) await this.#activityLedger?.create({
          projectId: this.#projectId,
          runId: legacyRunId,
          kind: 'receipt',
          eventType: assessment.status === 'completed' ? 'receipt.completed' : 'receipt.completed-with-notes',
          label: '操作回执',
          state: 'completed',
          progress: 1,
          objectLabel: receipt?.items.length === 1 ? receipt.items[0]?.object ?? '当前作品' : `${receipt?.items.length ?? 0} 项操作`,
          actionLabel: plan?.summary ?? assessment.summary,
          impactLabel: assessment.notes.join('；').slice(0, 500) || '本轮已安全完成',
          affectedIds: outcomes.flatMap((outcome) => outcome.affectedElementIds),
          operationBatchId: receipt?.batchId ?? null,
          jobId: receipt?.jobId ?? null
        })
        await this.#repository.transition(legacyRunId, {
          status: 'completed',
          errorCode: null,
          errorMessage: null,
          completedAt: this.#now()
        })
        this.#logger.write('info', 'agent.persistent-completed', {
          toolCount: outcomes.length,
          terminal: assessment.status
        }, legacyRunId)
      },
      onTerminal: async ({ legacyRunId, status, code, message }) => {
        const legacyStatus: AgentRun['status'] = status === 'interrupted'
          ? 'interrupted'
          : status === 'cancelled'
            ? 'cancelled'
            : 'failed'
        await this.#activityLedger?.cancelRun(legacyRunId, message)
        await this.#repository.appendAssistantMessage(legacyRunId, 'error', message, null)
        await this.#repository.transition(legacyRunId, {
          status: legacyStatus,
          errorCode: code,
          errorMessage: message,
          completedAt: this.#now()
        })
        this.#logger.write(legacyStatus === 'failed' ? 'error' : 'info', 'agent.persistent-terminal', {
          status,
          code,
          message
        }, legacyRunId)
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Agent runtime is closed.')
  }
}
