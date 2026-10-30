import type { LocalFontFamily } from '../../../shared/local-fonts'
import { randomUUID } from 'node:crypto'
import type { Scene } from '../../../domain'
import type { AgentPlan, AgentToolOutcome, AgentToolPlan } from '../../../shared/agent'
import type { AgentItem, AgentRunBudget, PlannerStep } from '../../../shared/agent-harness'
import { estimateModelCostCny, type LlmPricing } from '../../../shared/model-usage'
import type { LlmProtocol, LlmTransportSettings } from '../../../shared/provider-settings'
import type { ArkLlmRequest, ArkLlmTransportObservation } from '../../security/ark-http-client'
import { LlmProtocolError } from '../llm-provider'
import type { LlmStreamAccumulator } from '../llm-stream'
import { turnText, turnToolCalls, type LlmAssistantTurn, type LlmImage, type LlmToolResult, type LlmTranscriptMessage, type LlmUsage } from '../llm/transcript'
import type { LlmTurnProtocol } from '../llm/turn-protocol'
import type { AgentPlannerAttemptContext } from '../planner'
import type { PlannerAdapter, PlannerInput, PlannerStepResult } from '../planner-adapter'
import { availableAgentTools, llmToolDefinitions, prepareAgentToolCall } from '../tools/catalogue'
import { SCREENSHOT_QUESTION } from '../tools/look'
import { ElementRefs } from '../tools/refs'
import { formatToolResult, type AgentToolContext, type AgentToolResult, type AgentToolStep, type CanvasLooker, type ExecutedTool, type GenerationResultEntry, type ManualLibrary } from '../tools/types'
import { CHECKPOINT_TOKENS, checkpointText, estimateRequestTokens, MIN_STEPS_BETWEEN_CHECKPOINTS } from './context-budget'
import { MULTI_STEP_PROMPT_VERSION, multiStepSystemPrompt, multiStepTurnBrief } from './prompt'
import { MAX_STORED_BRIEF_CHARS, storableResult, traceOf, transcriptFrom, type AssistantStep, type ModelTrace } from './trace'

/** The configured text model, resolved again for every pass so settings changes apply. */
export interface MultiStepModel {
  readonly protocol: LlmTurnProtocol
  readonly http: {
    postLlmJson(request: ArkLlmRequest): Promise<unknown>
    postEventStream<T>(request: ArkLlmRequest, accumulator: LlmStreamAccumulator<T>): Promise<T>
  }
  readonly transport: LlmTransportSettings
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly label: string
  readonly protocolId: LlmProtocol
  readonly endpoint: string
  /** Prices for the cost estimate; without them only tokens are reported. */
  readonly pricing?: LlmPricing | null
}

export interface MultiStepPlannerOptions {
  readonly model: () => Promise<MultiStepModel>
  readonly scene: () => Scene
  readonly generation: () => Promise<AgentToolContext['generation']>
  readonly readAttachment?: (assetId: string) => Promise<{ readonly image: LlmImage; readonly bytes: number } | null>
  readonly readAsset?: ((assetId: string) => Promise<LlmImage>) | null
  readonly looker?: CanvasLooker | null
  readonly manuals?: ManualLibrary | null
  /** Font families installed on this computer, listed in the brief and checked by the text tools. */
  readonly fonts?: (() => Promise<readonly LocalFontFamily[]>) | null
  readonly measureTone?: AgentToolContext['measureTone']
  readonly assetSize?: AgentToolContext['assetSize']
  readonly drawLayers?: AgentToolContext['drawLayers']
  readonly blankLayer?: AgentToolContext['blankLayer']
  readonly layerMask?: AgentToolContext['layerMask']
  readonly bakeImage?: AgentToolContext['bakeImage']
  readonly newId?: () => string
  /** Model calls one pass may make while it answers read-only tools itself before it stores its progress. */
  readonly maxModelCallsPerPass?: number
  /** Estimated input above which earlier steps are replaced by a checkpoint. */
  readonly checkpointTokens?: number
}

/**
 * A pass answering read-only tools itself makes this many model calls at
 * most before it hands its progress to the loop: what it did is stored, the
 * turn's guards and cost cap are checked, and the next pass carries on. It
 * also keeps a pass's stored record within the trace's bounds.
 */
const MODEL_CALLS_PER_PASS = 8
const MAX_PASS_RESULTS = 48

/** A cost reservation per model call; the ledger settles against it. */
const MODEL_CALL_COST_CEILING_CNY = 0.25
/**
 * Screenshots a turn keeps to send again on each later step. Dropping one
 * changes the transcript from that step on, so nothing the provider cached
 * after it can be reused; they are kept until the turn ends or is
 * checkpointed, with this many calls as a bound on memory.
 */
const MAX_TURN_SCREENSHOT_CALLS = 16

interface PendingReport {
  readonly sceneBefore: Scene
  readonly report: (executed: ExecutedTool) => AgentToolResult
}

interface StoredToolResultPayload {
  readonly planItemId?: string
  readonly outcome?: AgentToolOutcome
}

interface StoredDecisionPayload {
  readonly proposal?: { readonly kind?: string; readonly options?: readonly { readonly id: string; readonly label: string }[] }
  readonly optionId?: string
}

function payloadOf<T>(item: AgentItem): T {
  return item.payload as T
}

function toLlmResult(callId: string, name: string, result: AgentToolResult): LlmToolResult {
  return {
    callId,
    name,
    isError: !result.ok,
    content: [{ type: 'text', text: formatToolResult(result) }, ...(result.images ?? []).map((image) => ({ type: 'image' as const, image }))]
  }
}

function oneToolPlan(call: AgentToolPlan, description: string): AgentPlan {
  return { summary: description.slice(0, 500), response: description.slice(0, 4_000), nextAction: null, tools: [call] }
}

/**
 * The multi-step engine. Each pass rebuilds the transcript from the plan items
 * of the turn, asks the model for its next step and hands the loop one call at
 * a time as a one-tool plan, so per-call confirmation, approvals, budgets and
 * the executor all apply unchanged. Read-only tools and rejected calls are
 * answered within the pass; their results go straight back to the model.
 */
export class MultiStepPlannerAdapter implements PlannerAdapter {
  readonly stepwise = true
  readonly #options: MultiStepPlannerOptions
  readonly #reports = new Map<string, PendingReport>()
  readonly #screenshots = new Map<string, readonly LlmImage[]>()
  #screenshotTurnId: string | null = null
  /** Asset IDs of attached images, for the outbound ledger. */
  readonly #imageIds = new WeakMap<LlmImage, string>()

  constructor(options: MultiStepPlannerOptions) {
    this.#options = options
  }

  async next(input: PlannerInput, signal: AbortSignal, context?: AgentPlannerAttemptContext): Promise<PlannerStepResult> {
    const items = [...input.items].sort((left, right) => left.ordinal - right.ordinal)
    const resumed = this.#resumeApprovedCall(items)
    if (resumed !== null) return { step: resumed, modelTurns: 0 }

    if (this.#screenshotTurnId !== input.turn.id) {
      this.#screenshots.clear()
      this.#screenshotTurnId = input.turn.id
    }
    const scene = this.#options.scene()
    const traces = items.flatMap((item) => {
      const trace = traceOf(item)
      return trace === null ? [] : [{ item, trace }]
    })
    const refs = ElementRefs.fromScene(scene, traces.at(-1)?.trace.refs ?? {})
    const results = new Map<string, LlmToolResult>()
    for (const { trace } of traces) for (const result of trace.results) results.set(result.callId, result)
    const assistants: AssistantStep[] = traces.flatMap(({ trace }) => trace.assistants)
    const storedBrief = traces.find(({ trace }) => trace.brief !== null)?.trace.brief ?? null
    let checkpoint = [...traces].reverse().find(({ trace }) => trace.checkpoint !== null)?.trace.checkpoint ?? null

    const pass = {
      assistants: [] as AssistantStep[],
      results: [] as LlmToolResult[],
      usage: [] as LlmUsage[],
      brief: null as string | null,
      checkpoint: null as ModelTrace['checkpoint'],
      calls: 0,
      /** Null once a call cannot be priced. */
      costCny: 0 as number | null
    }
    const record = (result: LlmToolResult): void => {
      results.set(result.callId, result)
      pass.results.push(storableResult(result))
      const images = result.content.flatMap((part) => part.type === 'image' ? [part.image] : [])
      if (images.length > 0) this.#cacheScreenshots(result.callId, images)
    }
    const model = await this.#options.model()
    const screenshots = screenshotPermission(items, context)
    const generated = (input.request.generationResults ?? []) as readonly GenerationResultEntry[]
    for (const result of this.#settleEmittedCalls(items, traces, scene, generated)) record(result)

    const toolContext: AgentToolContext = {
      scene,
      refs,
      newId: this.#options.newId ?? randomUUID,
      results: generated,
      generation: await this.#options.generation(),
      activeJobId: input.request.activeGenerationJobId,
      sourceMessageId: input.turn.inputMessageId,
      userText: input.request.text,
      looker: this.#options.looker ?? null,
      vision: model.protocol.capabilities.vision,
      screenshots,
      manuals: this.#options.manuals ?? null,
      readAsset: this.#options.readAsset ?? null,
      fonts: await this.#options.fonts?.().catch(() => []) ?? [],
      measureTone: this.#options.measureTone ?? null,
      assetSize: this.#options.assetSize ?? null,
      drawLayers: this.#options.drawLayers ?? null,
      blankLayer: this.#options.blankLayer ?? null,
      marked: input.request.ephemeralAnnotation,
      layerMask: this.#options.layerMask ?? null,
      bakeImage: this.#options.bakeImage ?? null
    }
    const finish = (step: PlannerStep, emitted: ModelTrace['emitted'], modelTurns: number): PlannerStepResult => ({
      step: {
        ...step,
        trace: {
          version: 1,
          promptVersion: this.#options.manuals?.version === undefined ? MULTI_STEP_PROMPT_VERSION : `${MULTI_STEP_PROMPT_VERSION}+${this.#options.manuals.version}`,
          refs: refs.toJSON(),
          assistants: pass.assistants.map((assistant) => ({ parts: [...assistant.parts], native: assistant.native })),
          results: pass.results,
          emitted,
          usage: pass.usage,
          brief: pass.brief,
          checkpoint: pass.checkpoint,
          modelCalls: pass.calls,
          costCny: pass.calls === 0 ? null : pass.costCny === null ? null : Number(pass.costCny.toFixed(6))
        } satisfies ModelTrace
      },
      modelTurns
    })

    let opening: LlmTranscriptMessage | null = null
    let modelTurns = 0
    const callLimit = this.#modelCallLimit(input.turn.modelTurnsUsed, input.budget)
    while (true) {
      // Calls left over from the latest assistant step run before the model is asked again.
      const latest = [...assistants, ...pass.assistants].at(-1)
      const queue = latest === undefined ? [] : turnToolCalls(latest).filter((call) => !results.has(call.callId))
      for (const call of queue) {
        const prepared = await prepareAgentToolCall(call, toolContext)
        const step: AgentToolStep = prepared.step
        if (step.kind === 'answer') {
          record(toLlmResult(call.callId, call.name, step.result))
          continue
        }
        if (step.kind === 'ask') {
          return finish({
            kind: 'decision',
            proposal: {
              kind: 'clarification',
              title: step.question.slice(0, 200),
              consequence: '选择后 Agent 按你的选择继续。',
              options: step.options.map((label, index) => ({ id: `option-${index + 1}`, label: label.slice(0, 120), consequence: '按这个继续' })),
              defaultOptionId: `option-${step.recommended + 1}`
            }
          }, { callId: call.callId, name: call.name }, modelTurns)
        }
        this.#reports.set(call.callId, { sceneBefore: scene, report: step.report })
        const description = prepared.tool?.describe(prepared.args as never, toolContext) ?? call.name
        return finish({ kind: 'tool', call: step.plan, toolIndex: 0, plan: oneToolPlan(step.plan, description) }, { callId: call.callId, name: call.name }, modelTurns)
      }

      const stuck = repeatedFailure([...assistants, ...pass.assistants], results)
      if (stuck !== null) {
        return finish({
          kind: 'complete',
          assessment: {
            status: 'completed_with_notes',
            summary: `「${stuck.name}」用同样的参数连续 ${REPEATED_FAILURE_LIMIT} 次都没成功，先停在这里：${stuck.reason}。做好的部分都保留；可以换个说法，或者告诉我怎么调整。`,
            notes: ['同一步连续失败，已停止重试。'],
            nextAction: null
          }
        }, null, modelTurns)
      }
      // A pass that has made its share of calls, or spent what the turn has left, hands back what it has;
      // the loop stores it, checks the turn's guards and cost cap, and asks again.
      const spentInPass = pass.costCny ?? 0
      if (modelTurns > 0 && (modelTurns >= callLimit || pass.results.length >= MAX_PASS_RESULTS
        || (input.costLeftCny != null && spentInPass >= input.costLeftCny))) {
        return finish({ kind: 'progress' }, null, modelTurns)
      }
      const system = multiStepSystemPrompt(this.#options.manuals ?? null)
      const tools = [...llmToolDefinitions(availableAgentTools(toolContext))]
      const steps = [...assistants, ...pass.assistants]
      if (opening === null) {
        // The brief written by the first pass is sent unchanged; changes reach the model as tool results.
        let text = checkpoint?.text ?? storedBrief
        if (text === null) {
          text = this.#briefText(input, scene, refs, toolContext, context)
          // One too long to store is written again on each pass instead.
          pass.brief = text.length <= MAX_STORED_BRIEF_CHARS ? text : null
        }
        opening = await this.#opening(text, input, model)
      }
      let messages = transcriptFrom({ brief: opening, assistants: steps.slice(checkpoint?.assistants ?? 0), results, images: this.#screenshots })
      if (steps.length - (checkpoint?.assistants ?? 0) >= MIN_STEPS_BETWEEN_CHECKPOINTS && estimateRequestTokens({ system, messages, tools }) > (this.#options.checkpointTokens ?? CHECKPOINT_TOKENS)) {
        checkpoint = pass.checkpoint = {
          assistants: steps.length,
          text: checkpointText({ brief: this.#briefText(input, scene, refs, toolContext, context), assistants: steps, results })
        }
        opening = await this.#opening(checkpoint.text, input, model)
        messages = [opening]
        // The steps the checkpoint replaced are no longer sent, nor their screenshots.
        this.#screenshots.clear()
      }
      const turn = await this.#callModel(model, {
        system,
        messages,
        tools,
        maxOutputTokens: model.maxOutputTokens,
        // One conversation's requests share their start; vendors that route by key serve them from one cache.
        cacheKey: `ai-canvas-${input.turn.threadId}`
      }, signal, context, modelTurns, screenshots === 'allowed')
      modelTurns += 1
      pass.calls += 1
      if (turn.usage !== null) pass.usage.push(turn.usage)
      pass.costCny = pass.costCny === null || turn.usage === null || model.pricing == null ? null : pass.costCny + estimateModelCostCny(turn.usage, model.pricing)
      if (turn.stopReason === 'content_filter' || turn.stopReason === 'refusal') {
        throw new LlmProtocolError('MODEL_OUTPUT_FILTERED', '供应商因内容策略停止了本次响应；本次没有执行任何工具。')
      }
      pass.assistants.push({ parts: [...turn.parts], native: turn.native })
      if (turnToolCalls(turn).length > 0) continue
      const reply = turnText(turn).trim()
      return finish({
        kind: 'complete',
        assessment: {
          status: turn.stopReason === 'max_tokens' ? 'completed_with_notes' : 'completed',
          summary: (reply === '' ? '已完成。' : reply).slice(0, 4_000),
          notes: turn.stopReason === 'max_tokens' ? ['模型回复达到输出上限，可能不完整。'] : [],
          nextAction: null
        }
      }, null, modelTurns)
    }
  }

  /** An approved or resumed call of the active one-tool plan runs before anything else. */
  #resumeApprovedCall(items: readonly AgentItem[]): PlannerStep | null {
    const active = [...items].reverse().find((item) => item.type === 'plan' && item.status === 'completed' && payloadOf<{ readonly plan?: AgentPlan | null }>(item).plan != null)
    if (active === undefined || traceOf(active)?.emitted == null) return null
    const plan = payloadOf<{ readonly plan: AgentPlan }>(active).plan
    const settled = items.some((item) => item.type === 'tool_result' && payloadOf<StoredToolResultPayload>(item).planItemId === active.id)
    if (settled || this.#declinedAfter(items, active) !== null) return null
    return { kind: 'tool', call: plan.tools[0]!, toolIndex: 0, plan: null }
  }

  #declinedAfter(items: readonly AgentItem[], planItem: AgentItem): string | null {
    const decision = items.find((item) => item.type === 'decision' && item.status === 'completed' && item.ordinal > planItem.ordinal)
    const stored = decision === undefined ? null : payloadOf<StoredDecisionPayload>(decision)
    if (stored?.proposal?.kind === 'generation_confirmation' && stored.optionId === 'keep_canvas') return '用户选择先不生成，画布保持不变，没有产生费用。'
    if (stored?.optionId === 'stop') return '用户选择不执行这一步。'
    return null
  }

  /** Results for calls handed to the loop in earlier passes: executed, failed, declined or answered. */
  #settleEmittedCalls(
    items: readonly AgentItem[],
    traces: readonly { readonly item: AgentItem; readonly trace: ModelTrace }[],
    scene: Scene,
    generated: readonly GenerationResultEntry[]
  ): LlmToolResult[] {
    const known = new Set(traces.flatMap(({ trace }) => trace.results.map((result) => result.callId)))
    const settled: LlmToolResult[] = []
    for (const { item, trace } of traces) {
      const emitted = trace.emitted
      if (emitted === null || known.has(emitted.callId)) continue
      const decision = items.find((candidate) => candidate.type === 'decision' && candidate.ordinal > item.ordinal)
      if ((item.payload as { readonly step?: { readonly kind?: string } }).step?.kind === 'decision') {
        // The screenshot question is answered by running look again under the person's choice.
        if (decision?.status !== 'completed' || emitted.name === 'look') continue
        const stored = payloadOf<StoredDecisionPayload>(decision)
        const label = stored.proposal?.options?.find((option) => option.id === stored.optionId)?.label ?? stored.optionId ?? '未选择'
        settled.push(toLlmResult(emitted.callId, emitted.name, { ok: true, summary: `用户选择：${label}` }))
        continue
      }
      const declined = this.#declinedAfter(items, item)
      const resultItem = items.find((candidate) => candidate.type === 'tool_result' && payloadOf<StoredToolResultPayload>(candidate).planItemId === item.id)
      if (resultItem === undefined) {
        if (declined !== null) settled.push(toLlmResult(emitted.callId, emitted.name, { ok: false, summary: declined, hint: '不要再次尝试这一步，除非用户重新要求。' }))
        continue
      }
      const outcome = payloadOf<StoredToolResultPayload>(resultItem).outcome
      if (outcome === undefined) continue
      const pending = this.#reports.get(emitted.callId)
      this.#reports.delete(emitted.callId)
      const reported = pending !== undefined && outcome.ok
        ? pending.report({ outcome, sceneBefore: pending.sceneBefore, sceneAfter: scene })
        : { ok: outcome.ok, summary: outcome.message, ...(outcome.ok ? {} : { hint: '画布没有因为这一步改变。按原因调整后再试，同一个错误不要原样重复。' }) }
      settled.push(toLlmResult(emitted.callId, emitted.name, withJobResults(reported, outcome, generated)))
    }
    return settled
  }

  /** The calls this pass may make before it hands back to the loop. */
  #modelCallLimit(used: number, budget: AgentRunBudget | undefined): number {
    const perPass = this.#options.maxModelCallsPerPass ?? MODEL_CALLS_PER_PASS
    return budget === undefined ? perPass : Math.max(1, Math.min(perPass, budget.maxModelTurns - used))
  }

  #cacheScreenshots(callId: string, images: readonly LlmImage[]): void {
    this.#screenshots.set(callId, images)
    while (this.#screenshots.size > MAX_TURN_SCREENSHOT_CALLS) this.#screenshots.delete(this.#screenshots.keys().next().value!)
  }

  #briefText(
    input: PlannerInput,
    scene: Scene,
    refs: ElementRefs,
    toolContext: AgentToolContext,
    context: AgentPlannerAttemptContext | undefined
  ): string {
    return multiStepTurnBrief({
      request: input.request,
      scene,
      refs,
      results: toolContext.results,
      projectContext: context?.projectContext ?? null,
      generation: toolContext.generation,
      fonts: toolContext.fonts ?? []
    })
  }

  /** The first message of the transcript: the brief or checkpoint text with the request's attached images. */
  async #opening(text: string, input: PlannerInput, model: MultiStepModel): Promise<LlmTranscriptMessage> {
    const attachments: { readonly assetId: string; readonly image: LlmImage; readonly bytes: number }[] = []
    if (model.protocol.capabilities.vision && this.#options.readAttachment !== undefined) {
      for (const attachment of input.request.attachments.filter((candidate) => candidate.kind === 'asset').slice(0, 4)) {
        const read = await this.#options.readAttachment(attachment.id)
        if (read !== null) attachments.push({ assetId: attachment.id, ...read })
      }
    }
    for (const attachment of attachments) this.#imageIds.set(attachment.image, attachment.assetId)
    return {
      role: 'user',
      parts: [{ type: 'text', text }, ...attachments.map((attachment) => ({ type: 'image' as const, image: attachment.image }))]
    }
  }

  async #callModel(
    model: MultiStepModel,
    request: Parameters<LlmTurnProtocol['buildTurnRequest']>[0],
    signal: AbortSignal,
    context: AgentPlannerAttemptContext | undefined,
    previousCalls: number,
    imagesApproved: boolean
  ): Promise<LlmAssistantTurn> {
    const images = request.messages.flatMap((message) => message.role === 'user'
      ? message.parts.filter((part) => part.type === 'image')
      : message.role === 'tool' ? message.results.flatMap((result) => result.content.filter((part) => part.type === 'image')) : [])
    const outbound = context?.outbound === undefined || context.outbound === null
      ? null
      : await context.outbound.authorize({
          providerId: 'openai-compatible-llm',
          model: model.protocol.model,
          endpoint: model.endpoint,
          dataTypes: ['user_text', 'scene_summary', ...(context.projectContext === null || context.projectContext === undefined ? [] : ['project_context']), ...(images.length > 0 ? ['reference_image'] : [])],
          textBytes: Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages.map(withoutImages) }), 'utf8'),
          // Images without a project asset (none yet) are still counted, under a one-off ID.
          imageAssetIds: images.map((part) => this.#imageIds.get(part.image) ?? randomUUID()),
          imageBytes: images.reduce((total, part) => total + Math.floor(part.image.base64.length * 3 / 4), 0),
          imagesApproved
        })
    const messages = outbound === null || outbound.imagesAllowed ? request.messages : request.messages.map(withoutImages)
    const now = Date.now()
    const deadline = Math.min(now + model.timeoutMs, context?.deadlineAt ?? Number.POSITIVE_INFINITY)
    const timeoutMs = Math.floor(deadline - now)
    if (timeoutMs < 1_000) throw Object.assign(new Error('本轮剩余时间不足 1 秒，没有发送新的模型请求。'), { code: 'BUDGET_WALL_TIME' })
    const stream = model.transport.mode === 'stream' || model.transport.mode === 'auto' && model.protocol.capabilities.streaming
    const protocolRequest = model.protocol.buildTurnRequest({ ...request, messages }, stream)
    const attemptId = randomUUID()
    const requestCorrelationId = context?.requestCorrelationId ?? randomUUID()
    let outboundSent = false
    const observe = async (observation: ArkLlmTransportObservation): Promise<void> => {
      if (observation.phase === 'connecting' && outbound !== null && !outboundSent) {
        outboundSent = true
        try { await context?.outbound?.sent(outbound.recordId) } catch { /* the ledger entry stays prepared */ }
      }
      try {
        await context?.observe?.({
          type: `provider.attempt.${observation.phase}`,
          payload: {
            schemaVersion: 1, attemptId, requestCorrelationId,
            providerId: 'openai-compatible-llm', providerLabel: model.label, protocol: model.protocolId, model: model.protocol.model,
            transportMode: stream ? 'stream' : 'buffered', attempt: previousCalls + 1, phase: observation.phase,
            occurredAt: new Date().toISOString(), elapsedMs: observation.elapsedMs,
            lastTransportActivityAt: observation.lastTransportActivityAt, lastSemanticProgressAt: observation.lastSemanticProgressAt,
            receivedBytes: observation.receivedBytes, recognizedEventCount: observation.recognizedEventCount,
            providerResponseId: observation.providerResponseId, httpStatus: observation.httpStatus, failureCode: observation.failureCode
          }
        } as Parameters<NonNullable<AgentPlannerAttemptContext['observe']>>[0], { checkpoint: observation.checkpoint !== false })
      } catch { /* observability cannot change Provider semantics */ }
    }
    const live: ArkLlmRequest = {
      ...protocolRequest,
      secretId: 'openai-compatible-llm',
      providerId: 'openai-compatible-llm',
      providerLabel: model.label,
      authorizationScopeId: `agent-step:${requestCorrelationId}:${attemptId}`,
      expectedImages: 0,
      costCeilingCny: MODEL_CALL_COST_CEILING_CNY,
      signal,
      timeoutMs,
      connectTimeoutMs: Math.min(model.transport.connectTimeoutMs, timeoutMs),
      firstEventTimeoutMs: Math.min(model.transport.firstEventTimeoutMs, timeoutMs),
      idleTimeoutMs: Math.min(model.transport.idleTimeoutMs, timeoutMs),
      totalTimeoutCode: context?.deadlineAt !== undefined && context.deadlineAt < now + model.timeoutMs ? 'BUDGET_WALL_TIME' : 'PROVIDER_TOTAL_TIMEOUT',
      observe
    }
    return stream
      ? model.http.postEventStream(live, model.protocol.createTurnStreamAccumulator())
      : model.protocol.parseTurnResponse(await model.http.postLlmJson(live))
  }
}

/** The same call failing this many times in a row ends the turn instead of another try. */
const REPEATED_FAILURE_LIMIT = 3

/** The call the model keeps repeating although it fails each time, or null. */
function repeatedFailure(steps: readonly AssistantStep[], results: ReadonlyMap<string, LlmToolResult>): { readonly name: string; readonly reason: string } | null {
  const recent = steps.flatMap((step) => turnToolCalls(step)).slice(-REPEATED_FAILURE_LIMIT)
  if (recent.length < REPEATED_FAILURE_LIMIT) return null
  const [first] = recent
  if (recent.some((call) => call.name !== first!.name || call.argumentsText !== first!.argumentsText || results.get(call.callId)?.isError !== true)) return null
  const text = results.get(recent.at(-1)!.callId)?.content.find((part) => part.type === 'text')?.text ?? ''
  const line = text.split('\n', 1)[0]!.trim()
  return { name: first!.name, reason: line === '' ? '没有说明原因' : line.slice(0, 160) }
}

/** A finished generation job names its new images, so the model can view or place them. */
function withJobResults(result: AgentToolResult, outcome: AgentToolOutcome, generated: readonly GenerationResultEntry[]): AgentToolResult {
  if (!result.ok || outcome.jobId === null) return result
  const produced = generated.flatMap((entry, index) => entry.jobId === outcome.jobId ? [`R${index + 1}（${entry.width}×${entry.height}）`] : [])
  const line = produced.length === 0
    ? '生成任务还没有返回成图。'
    : `生成完成，新成图：${produced.join('、')}。可以用 view_result 查看，用 place_result 放到画布上。`
  return { ...result, details: [...(result.details ?? []), line] }
}

/** Under the per-image review policy, screenshots wait for one answer per turn. */
function screenshotPermission(items: readonly AgentItem[], context: AgentPlannerAttemptContext | undefined): 'allowed' | 'ask' | 'declined' {
  if (context?.outbound?.imageReview !== true) return 'allowed'
  const answer = [...items].reverse().find((item) => item.type === 'decision' && item.status === 'completed'
    && payloadOf<StoredDecisionPayload & { readonly proposal?: { readonly title?: string } }>(item).proposal?.title === SCREENSHOT_QUESTION)
  if (answer === undefined) return 'ask'
  return payloadOf<StoredDecisionPayload>(answer).optionId === 'option-1' ? 'allowed' : 'declined'
}

function withoutImages(message: LlmTranscriptMessage): LlmTranscriptMessage {
  if (message.role === 'user') {
    return { ...message, parts: message.parts.map((part) => part.type === 'image' ? { type: 'text' as const, text: '[图片未发送：隐私设置要求先确认]' } : part) }
  }
  if (message.role === 'tool') {
    return { ...message, results: message.results.map((result) => ({ ...result, content: result.content.map((part) => part.type === 'image' ? { type: 'text' as const, text: '[图片未发送：隐私设置要求先确认]' } : part) })) }
  }
  return message
}
