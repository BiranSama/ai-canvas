import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  agentPlanSchema,
  agentToolPlanSchema,
  agentRequestSchema,
  type AgentPlan,
  type AgentRequest
} from '../../shared/agent'
import type { AssetMetadata } from '../storage/project-repository'
import type {
  LlmProtocol,
  LlmTransportSettings,
  ProviderConfigFile,
  ProviderPublicConfig
} from '../../shared/provider-settings'
import type { ArkHttpClient, ArkLlmTransportObservation } from '../security/ark-http-client'
import type { LlmProtocolAdapter, NormalizedLlmResponse } from './llm-provider'
import type { AgentPlanner, AgentPlannerAttemptContext } from './planner'
import { normalizeAgentPlanCreativeBriefs } from './creative-brief-normalizer'
import { agentErrorRecipe, normalizeAgentFailureEnvelope, type AgentFailureEnvelope } from '../../shared/agent-recovery'
import { availablePlannerToolKinds } from './agent-tool-registry'

const MAX_ATTACHMENT_COUNT = 4
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024
const LLM_PLAN_COST_CEILING_CNY = 0.25
const SUPPORTED_PLAN_TOOL_KINDS = new Set<string>(availablePlannerToolKinds())

const ACTION_INTENT_PATTERN = /(?:创建|新建|生成|画一|画个|画张|画幅|做一|做个|做张|做幅|来一|来个|来张|来幅|添加|放置|插入|移动|挪动|调整|修改|更改|改成|改为|删除|移除|隐藏|显示|锁定|解锁|放大|缩小|旋转|排版|布局|设置|设为|替换|编辑|记住|以后都|始终|撤销|取消生成|放入画布|置入画布|create|generate|add|insert|move|resize|rotate|delete|remove|edit|replace|remember)/iu
const REFINEMENT_INTENT_PATTERN = /(?:向上|向下|向左|向右|上移|下移|左移|右移|再(?:大|小|亮|暗|疏|密|高|低|近|远)[一两]?(?:点|些)|更(?:大|小|亮|暗|疏|密|高|低|近|远)[一两]?(?:点|些)|换成|换为)/u
const NEGATED_CLAUSE_PATTERN = /(?:不要|请勿|无需|不必|不需要|先不|先别|别再)[^，。；;!?！？]{0,32}/gu

export class AgentPlannerError extends Error {
  readonly code: string
  readonly schemaIssues: readonly { readonly issueCode: string; readonly path: string; readonly expected: string }[]

  constructor(
    code: string,
    message: string,
    schemaIssues: readonly { readonly issueCode: string; readonly path: string; readonly expected: string }[] = []
  ) {
    super(message)
    this.name = 'AgentPlannerError'
    this.code = code
    this.schemaIssues = schemaIssues
  }
}

export function requestRequiresToolPlan(request: AgentRequest): boolean {
  if (request.autoGenerate) return true
  const actionableText = request.text.replace(NEGATED_CLAUSE_PATTERN, '')
  return ACTION_INTENT_PATTERN.test(actionableText) || REFINEMENT_INTENT_PATTERN.test(actionableText)
}

interface SecretAvailability {
  has(id: string): Promise<boolean>
}

interface AssetResolver {
  resolveAsset(assetId: string): Promise<{ readonly asset: AssetMetadata; readonly filePath: string }>
}

interface ArkJsonPoster {
  postJson(request: Parameters<ArkHttpClient['postJson']>[0]): Promise<unknown>
  postLlmJson?(request: Parameters<ArkHttpClient['postLlmJson']>[0]): Promise<unknown>
  postEventStream?(
    request: Parameters<ArkHttpClient['postEventStream']>[0],
    accumulator: Parameters<ArkHttpClient['postEventStream']>[1]
  ): ReturnType<ArkHttpClient['postEventStream']>
}

const planJsonSchema = (() => {
  const generated = { ...z.toJSONSchema(agentPlanSchema) } as Record<string, unknown>
  delete generated.$schema
  return generated
})()

function systemPrompt(imageProviderId: string, imageModel: string, maxImages: number, imageGenerationAvailable: boolean): string {
  const imageBoundary = imageGenerationAvailable
    ? `所有生图工具的 providerId 固定为 ${imageProviderId}，model 固定为 ${imageModel}，count 为 1 至 ${maxImages}。`
    : '当前未配置可用的图片模型。禁止创建 generation、canvas_generation 或 canvas_edit；仍可正常理解需求并使用 scene_batch 修改结构化画布。'
  return `你是 AI Canvas 的画布规划 Agent。你的唯一输出必须是一次 submitAgentPlan 函数调用。

边界：
1. 只根据用户要求和提供的场景摘要规划；不要访问网络、文件、密钥或任何未提供的信息。
2. 普通聊天可以返回 tools 为空的计划。优先使用 scene.set_canvas、scene.create_elements、scene.update_elements、scene.reorder_elements、scene.group_elements、scene.remove_elements 这些窄工具；只有多个紧密操作必须原子提交时才使用 scene_batch。
2.1 tools[].kind 只允许 ${[...SUPPORTED_PLAN_TOOL_KINDS].join('、')}；这些名称由当前 Tool Registry 生成，不要输出未列出的运行时工具名。
3. 只有用户明确要求生成图片，或 autoGenerate=true，才创建 generation、canvas_generation 或 canvas_edit。
4. 直接生图用 generation；已有画布布局需要编译成参考图时用 canvas_generation。已有单张图片的参考修改仍用 generation：references 填入该图片真实 assetId，intent=subject，referenceMode=visual，并从 generationResults 匹配 parentResultId；普通位图不使用 structure/hybrid。只有目标 hasEditMask=true 或本轮有真实临时修改标注时才用 canvas_edit，不得凭空构造蒙版。
5. ${imageBoundary}
6. 不得编造场景中不存在的 elementId、assetId 或 jobId。新增元素必须使用合法 UUID。
7. response、summary、nextAction 使用简洁自然的中文。不要把内部协议、JSON、resultId/assetId/elementId/jobId、UUID 或供应商密钥展示给用户。用对象名称解释结果。
8. 只有用户明确说“记住/以后/始终/必须/规则”这类长期约束时，才可使用 directive_create；从对话推断出的偏好只能使用 memory_candidate，等待用户确认后才进入长期记忆。
9. 用户要求放入或替换图片时使用 place_generation_result 或 result.place_on_canvas。已有结果从 generationResults 选真实 resultId；本轮先生成再放入时必须在同一 tools 计划中追加放置工具，resultId="generated:N"，N 是前置生图工具在 tools 中的零起始索引，该次生图 count=1。替换已有图片/占位必须带 targetElementId，保留其布局和身份；禁止先删占位，禁止为未知结果猜 UUID。用户已要求“生成后替换”时，不要额外要求一次结果确认，也不要只计划生图便结束任务。
10. 如果需求含糊，宁可只说明理解并给出下一步，不要擅自生成图片、大幅改动画布或写入长期规则。
11. 新建设计时，把用户可能独立选择、移动、描述或继续修改的主体部件、准确文字、光影与辅助结构建成独立可编辑元素；不要把所有主题退化为一个通用主体矩形。
12. 只为真正需要整体控制的语义组件建立浅层 Group。先添加子元素，再执行 element.group；背景、全局标题和全局光影通常保持根元素。当前 Scene 不支持嵌套 Group。
13. Group 摘要中的 childIds 是真实组内成员。修改现有结构时只能引用 scene 或本批次前序新增的真实 ID，不得编造组或子元素。
14. 图片 Provider 返回的最终位图仍是一个 Image 元素；不得把最终位图描述成已经自动拆层。只有模型明确返回可验证分层结果时，才可以说明存在真实分层。
15. 新建设计或明确修订创作简报时优先返回 Creative Brief v3 与 Creative Design Contract v2，并为字段提供 user、scene 或 agent_inference 来源；禁止为新内容使用 legacy_unattributed。Main 会最终生成 createdAt 和修订链。
16. 修改字号、颜色、对齐时以 scene.elements 的真实属性为准。缩小20%是原 fontSize×0.8，不是猜一个默认字号再缩小。属性缺失时先读取对象，不得猜测；只提交被要求改变的属性，不重建无关元素。`
}

function parseAgentPlan(argumentsValue: Readonly<Record<string, unknown>>): AgentPlan {
  const tools = Array.isArray(argumentsValue.tools) ? argumentsValue.tools : []
  const rejectPlan = (error: AgentPlannerError): never => {
    // Main-only, non-enumerable repair context. Never serialized to a failure
    // event or a Renderer snapshot. Only already schema-valid tools survive.
    Object.defineProperty(error, 'validatedTools', { value: tools.slice(0, 12).map((tool) => {
      const parsedTool = agentToolPlanSchema.safeParse(tool)
      return parsedTool.success ? parsedTool.data : null
    }) })
    throw error
  }
  const hasUnsupportedTool = tools.some((tool) => {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return false
    const kind = (tool as { readonly kind?: unknown }).kind
    return typeof kind === 'string' && !SUPPORTED_PLAN_TOOL_KINDS.has(kind)
  })
  if (hasUnsupportedTool) {
    return rejectPlan(new AgentPlannerError(
      'MODEL_TOOL_UNSUPPORTED',
      '模型选择了当前应用未提供的操作；本次没有修改画布。',
      tools.slice(0, 12).flatMap((tool, index) => {
        if (typeof tool !== 'object' || tool === null || !('kind' in tool) || typeof tool.kind !== 'string' || SUPPORTED_PLAN_TOOL_KINDS.has(tool.kind)) return []
        return [{ issueCode: 'UNSUPPORTED_TOOL_KIND', path: `tools.${index}.kind`, expected: '只能使用 allowedToolKinds 中的工具名；Scene command 必须放入 scene_batch.commands，不能直接作为 tools 项。' }]
      })
    ))
  }
  const parsed = agentPlanSchema.safeParse(argumentsValue)
  if (!parsed.success) {
    return rejectPlan(new AgentPlannerError(
      'MODEL_PLAN_SCHEMA_INVALID',
      '模型给出的操作参数不符合当前画布约束；本次没有修改画布。请缩小单次修改范围后重试。',
      parsed.error.issues.slice(0, 40).map((issue) => ({
        issueCode: issue.code.toUpperCase().slice(0, 120),
        path: issue.path.map(String).join('.').slice(0, 240),
        expected: issue.message.slice(0, 300)
      }))
    ))
  }
  return parsed.data
}

function mimeFor(format: AssetMetadata['format']): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (format === 'jpeg') return 'image/jpeg'
  return `image/${format}`
}

function boundedSceneContext(request: AgentRequest): string {
  const compact = {
    requirement: request.text,
    autoGenerate: request.autoGenerate,
    activeGenerationJobId: request.activeGenerationJobId,
    selectedIds: request.selectedIds,
    selectedElements: request.selectedElements.slice(0, 60),
    attachments: request.attachments,
    generationResults: request.generationResults ?? [],
    scene: {
      revision: request.sceneSummary.revision,
      canvas: request.sceneSummary.canvas,
      elementCount: request.sceneSummary.elementCount,
      relationCount: request.sceneSummary.relationCount,
      creativeBrief: request.sceneSummary.creativeBrief ?? request.sceneSummary.creativeContext?.brief ?? null,
      elements: request.sceneSummary.elements.slice(0, 240).map((element) => ({
        ...element,
        name: element.name.slice(0, 160),
        description: element.description.slice(0, 600)
      }))
    }
  }
  const serialized = JSON.stringify(compact)
  if (serialized.length <= 150_000) return serialized
  return JSON.stringify({
    ...compact,
    selectedElements: compact.selectedElements.slice(0, 20),
    scene: { ...compact.scene, elements: compact.scene.elements.slice(0, 60) }
  })
}

function recoveryInstruction(failure: AgentFailureEnvelope | null | undefined): string {
  if (failure === null || failure === undefined) return ''
  const normalized = normalizeAgentFailureEnvelope(failure)
  const recipe = agentErrorRecipe(normalized.code)
  return `\n\n上一次尝试未完成。保留 completedToolIndexes 对应的已提交操作，不得重放；只替换 replacementScope 指定的失败及未执行部分，不得重复原错误。公开失败事实：\n${JSON.stringify({
    failureId: normalized.failureId,
    parentFailureId: normalized.parentFailureId,
    code: normalized.code,
    phase: normalized.phase,
    category: normalized.category,
    safeMessage: normalized.safeMessage,
    toolName: normalized.toolName,
    schemaIssues: normalized.schemaIssues,
    expectedSceneRevision: normalized.expectedSceneRevision,
    currentSceneRevision: normalized.currentSceneRevision,
    affectedElementIds: normalized.affectedElementIds,
    replacementScope: normalized.replacementScope,
    completedToolIndexes: normalized.completedToolIndexes,
    failedToolIndex: normalized.failedToolIndex,
    unstartedToolIndexes: normalized.unstartedToolIndexes,
    repairFacts: normalized.repairFacts,
    prohibitedRepairs: normalized.prohibitedRepairs,
    allowedActions: normalized.allowedActions,
    remainingModelTurns: normalized.remainingModelTurns,
    remainingRecoveryAttempts: normalized.remainingRecoveryAttempts,
    remainingWallTimeMs: normalized.remainingWallTimeMs,
    remainingCostCny: normalized.remainingCostCny,
    attempt: normalized.attempt,
    maxAttempts: normalized.maxAttempts,
    repairInstruction: recipe.repairInstruction,
    allowedToolKinds: recipe.includeAllowedToolSchemas ? [...SUPPORTED_PLAN_TOOL_KINDS] : []
  })}`
}

function isGenerationTool(tool: AgentPlan['tools'][number]): boolean {
  return tool.kind === 'generation' || tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit'
}

function annotateProviderAttempt(error: unknown, attemptId: string, requestCorrelationId: string): Error {
  const surfaced = error instanceof Error ? error : new Error('文字模型请求未能完成。')
  return Object.assign(surfaced, { providerAttemptId: attemptId, requestCorrelationId })
}

function lockGenerationProvider(
  plan: AgentPlan,
  providerId: string,
  model: string,
  maxImages: number,
  imageGenerationAvailable: boolean
): AgentPlan {
  const blockedGeneration = !imageGenerationAvailable && plan.tools.some(isGenerationTool)
  return agentPlanSchema.parse({
    ...plan,
    ...(blockedGeneration ? {
      response: `${plan.response}\n\n图片模型尚未完成配置，因此本轮没有提交付费生图任务。画布操作仍可正常执行。`,
      nextAction: plan.nextAction ?? '在设置中配置图片模型后继续生成。'
    } : {}),
    tools: plan.tools.filter((tool) => imageGenerationAvailable || !isGenerationTool(tool)).map((tool) => {
      if (tool.kind === 'generation') {
        return {
          ...tool,
          request: {
            ...tool.request,
            providerId,
            model,
            count: Math.min(tool.request.count, maxImages)
          }
        }
      }
      if (tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit') {
        return { ...tool, providerId, model, count: Math.min(tool.count, maxImages) }
      }
      return tool
    })
  })
}

/** Check dependencies and operation prerequisites before any confirmation or external work. */
export function validateChatPlan(plan: AgentPlan, request: AgentRequest): AgentPlan {
  const reject = (index: number, message: string): never => {
    throw new AgentPlannerError('MODEL_PLAN_SCHEMA_INVALID', message, [{
      issueCode: 'CHAT_TOOL_PRECONDITION', path: `tools.${index}`, expected: message
    }])
  }
  const targets = new Map(request.sceneSummary.elements.map((element) => [element.id, { type: element.type, locked: element.locked }]))
  const tools = plan.tools.map((tool, index) => {
    if (tool.kind === 'scene.create_elements') {
      for (const element of tool.elements) targets.set(element.id, { type: element.type, locked: element.locked })
    } else if (tool.kind === 'scene_batch') {
      for (const command of tool.commands) {
        if (command.kind === 'element.add') targets.set(command.element.id, { type: command.element.type, locked: command.element.locked })
        if (command.kind === 'element.remove') targets.delete(command.elementId)
      }
    } else if (tool.kind === 'scene.remove_elements') {
      for (const id of tool.elementIds) targets.delete(id)
    }
    if (tool.kind === 'canvas_edit') {
      const target = request.sceneSummary.elements.find((element) => element.id === tool.targetElementId)
      const annotation = request.ephemeralAnnotation
      const annotated = annotation !== null && annotation !== undefined
        && (annotation.targetElementId === null || annotation.targetElementId === target?.id)
        && (annotation.regions ?? [annotation]).some((region) => region.mode === 'edit')
      if (target?.type !== 'image' || (target.hasEditMask !== true && !annotated)) {
        reject(index, '该图片没有可用修改蒙版。普通整图参考修改应使用 generation、真实 assetId 引用和 referenceMode=visual；不要要求确认一个无法执行的蒙版操作。')
      }
    }
    if (tool.kind === 'place_generation_result' || tool.kind === 'result.place_on_canvas') {
      if (tool.resultId.startsWith('generated:')) {
        const sourceIndex = Number(tool.resultId.slice('generated:'.length))
        const source = plan.tools[sourceIndex]
        if (sourceIndex >= index || source === undefined || !isGenerationTool(source)) reject(index, 'generated:N 必须指向同一计划中更早的生图工具。')
        const count = source!.kind === 'generation' ? source!.request.count : 'count' in source! ? source!.count : 0
        if (count !== 1) reject(index, '自动回填的前置图片任务必须只生成1张，不能猜测多图中的选择。')
      } else if (!(request.generationResults ?? []).some((result) => result.resultId === tool.resultId)) {
        reject(index, '放置已有图片必须使用当前结果列表的真实 resultId；尚未生成的结果使用 generated:N。')
      }
      if (tool.targetElementId !== undefined) {
        if (request.selectedIds.length > 0 && !request.selectedIds.includes(tool.targetElementId)) reject(index, '替换目标不在本轮选区中，不能修改选区之外的对象。')
        const target = targets.get(tool.targetElementId)
        if (target === undefined || !['image', 'placeholder'].includes(target.type) || target.locked) reject(index, '替换目标必须是当前未锁定的图片或占位。')
      }
    }
    // Explicit asset references are pixels, not a structured Scene. Their supported
    // meaning is visual regardless of a schema default emitted by the model.
    if (tool.kind === 'generation' && (tool.request.references.length > 0 || tool.request.parentResultId !== null)) {
      return { ...tool, request: { ...tool.request, referenceMode: 'visual' as const } }
    }
    return tool
  })
  const publicText = (text: string) => text.replace(/(?:resultId|assetId|elementId|jobId)\s*[:：]\s*[0-9a-f]{8}-[0-9a-f-]{27,36}/giu, '当前对象')
  return agentPlanSchema.parse({ ...plan, tools, response: publicText(plan.response), summary: publicText(plan.summary), nextAction: plan.nextAction === null ? null : publicText(plan.nextAction) })
}

/** Uses Ark Responses Function Calling to turn natural language into one validated AgentPlan. */
export class ArkAgentPlanner implements AgentPlanner {
  readonly #protocol: LlmProtocolAdapter
  readonly #http: ArkJsonPoster
  readonly #assets: AssetResolver
  readonly #timeoutMs: number
  readonly #imageProviderId: string
  readonly #imageModel: string
  readonly #maxImages: number
  readonly #imageGenerationAvailable: boolean
  readonly #llmProviderLabel: string
  readonly #maxOutputTokens: number
  readonly #protocolId: LlmProtocol
  readonly #model: string
  readonly #transport: LlmTransportSettings

  constructor(options: {
    readonly protocol: LlmProtocolAdapter
    readonly http: ArkJsonPoster
    readonly assets: AssetResolver
    readonly timeoutMs: number
    readonly imageProviderId?: string
    readonly imageModel?: string
    readonly maxImages?: number
    readonly imageGenerationAvailable?: boolean
    readonly llmProviderLabel?: string
    readonly maxOutputTokens?: number
    readonly protocolId?: LlmProtocol
    readonly model?: string
    readonly transport?: LlmTransportSettings
  }) {
    this.#protocol = options.protocol
    this.#http = options.http
    this.#assets = options.assets
    this.#timeoutMs = options.timeoutMs
    this.#imageProviderId = options.imageProviderId ?? 'image-provider'
    this.#imageModel = options.imageModel ?? 'doubao-seedream-5-0-260128'
    this.#maxImages = Math.max(1, Math.min(16, Math.floor(options.maxImages ?? 4)))
    this.#imageGenerationAvailable = options.imageGenerationAvailable ?? true
    this.#llmProviderLabel = options.llmProviderLabel?.trim() || this.#protocol.label
    this.#maxOutputTokens = Math.max(256, Math.min(131_072, Math.floor(options.maxOutputTokens ?? 4_096)))
    this.#protocolId = options.protocolId ?? 'openai-responses'
    this.#model = options.model?.trim() || 'configured-model'
    this.#transport = options.transport ?? {
      mode: 'buffered',
      connectTimeoutMs: Math.min(20_000, this.#timeoutMs),
      firstEventTimeoutMs: Math.min(45_000, this.#timeoutMs),
      idleTimeoutMs: Math.min(60_000, this.#timeoutMs)
    }
  }

  async plan(
    requestValue: AgentRequest,
    signal: AbortSignal,
    recovery?: AgentFailureEnvelope | null,
    context?: AgentPlannerAttemptContext
  ): Promise<AgentPlan> {
    const request = agentRequestSchema.parse(requestValue)
    const images = await this.#readAttachments(request)
    const transportMode = this.#transport.mode === 'buffered'
      ? 'buffered'
      : this.#transport.mode === 'stream'
        ? 'stream'
        : this.#protocol.capabilities.streaming
          ? 'stream'
          : 'buffered'
    if (this.#transport.mode === 'stream' && !this.#protocol.capabilities.streaming) {
      throw new AgentPlannerError('PROVIDER_STREAM_UNSUPPORTED', '当前协议没有声明流式能力；请求尚未发送。')
    }
    if (transportMode === 'stream' && this.#http.postEventStream === undefined) {
      throw new AgentPlannerError('PROVIDER_STREAM_UNSUPPORTED', '当前 Main 传输没有启用流式能力；请求尚未发送。')
    }
    const now = Date.now()
    const providerDeadline = now + this.#timeoutMs
    const harnessDeadline = context?.deadlineAt ?? providerDeadline
    const effectiveDeadline = Math.min(providerDeadline, harnessDeadline)
    const effectiveTimeoutMs = Math.floor(effectiveDeadline - now)
    if (effectiveTimeoutMs < 1_000) {
      throw new AgentPlannerError('BUDGET_WALL_TIME', '本轮剩余时间不足 1 秒，没有发送新的模型请求。')
    }
    const attemptId = randomUUID()
    const requestCorrelationId = context?.requestCorrelationId ?? randomUUID()
    const attempt = context?.attempt ?? 1
    const observedStartedAt = Date.now()
    const observePlannerEvent = async (
      event: Parameters<NonNullable<AgentPlannerAttemptContext['observe']>>[0],
      delivery?: { readonly checkpoint: boolean }
    ): Promise<void> => {
      try { await context?.observe?.(event, delivery) } catch { /* observability cannot change Provider semantics */ }
    }
    const observeAttempt = async (observation: ArkLlmTransportObservation): Promise<void> => {
      await observePlannerEvent({
        type: `provider.attempt.${observation.phase}`,
        payload: {
          schemaVersion: 1,
          attemptId,
          requestCorrelationId,
          providerId: 'openai-compatible-llm',
          providerLabel: this.#llmProviderLabel,
          protocol: this.#protocolId,
          model: this.#model,
          transportMode,
          attempt,
          phase: observation.phase,
          occurredAt: new Date().toISOString(),
          elapsedMs: observation.elapsedMs,
          lastTransportActivityAt: observation.lastTransportActivityAt,
          lastSemanticProgressAt: observation.lastSemanticProgressAt,
          receivedBytes: observation.receivedBytes,
          recognizedEventCount: observation.recognizedEventCount,
          providerResponseId: observation.providerResponseId,
          httpStatus: observation.httpStatus,
          failureCode: observation.failureCode
        }
      }, { checkpoint: observation.checkpoint !== false })
    }
    const protocolRequest = this.#protocol.buildRequest({
      messages: [
        { role: 'system', content: systemPrompt(this.#imageProviderId, this.#imageModel, this.#maxImages, this.#imageGenerationAvailable) },
        { role: 'user', content: `请为下面的 AI Canvas 状态提交结构化计划：\n${boundedSceneContext(request)}${recoveryInstruction(recovery)}` }
      ],
      images,
      tools: [{
        name: 'submitAgentPlan',
        description: '提交一个经过结构化验证的 AI Canvas 操作计划。',
        parameters: planJsonSchema
      }],
      temperature: 0,
      maxOutputTokens: this.#maxOutputTokens
    }, transportMode === 'stream')
    const llmRequest = {
      ...protocolRequest,
      secretId: 'openai-compatible-llm',
      providerId: 'openai-compatible-llm',
      providerLabel: this.#llmProviderLabel,
      authorizationScopeId: `agent-plan:${requestCorrelationId}`,
      expectedImages: 0,
      costCeilingCny: LLM_PLAN_COST_CEILING_CNY,
      signal,
      timeoutMs: effectiveTimeoutMs,
      connectTimeoutMs: Math.min(this.#transport.connectTimeoutMs, effectiveTimeoutMs),
      firstEventTimeoutMs: Math.min(this.#transport.firstEventTimeoutMs, effectiveTimeoutMs),
      idleTimeoutMs: Math.min(this.#transport.idleTimeoutMs, effectiveTimeoutMs),
      totalTimeoutCode: harnessDeadline < providerDeadline ? 'BUDGET_WALL_TIME' : 'PROVIDER_TOTAL_TIMEOUT',
      observe: observeAttempt
    } as const
    let raw: unknown
    try {
      raw = transportMode === 'stream'
        ? await this.#http.postEventStream!(llmRequest, this.#protocol.createStreamAccumulator())
        : this.#http.postLlmJson === undefined
          ? await this.#http.postJson(llmRequest)
          : await this.#http.postLlmJson(llmRequest)
    } catch (error) {
      throw annotateProviderAttempt(error, attemptId, requestCorrelationId)
    }
    await observePlannerEvent({
      type: 'plan.validation.started',
      payload: {
        schemaVersion: 1, requestCorrelationId, occurredAt: new Date().toISOString(),
        elapsedMs: Date.now() - observedStartedAt, toolCount: null, failureCode: null
      }
    })
    let response: NormalizedLlmResponse | null = null
    try {
      response = transportMode === 'stream'
        ? raw as NormalizedLlmResponse
        : this.#protocol.parseResponse(raw)
      const calls = response.toolCalls.filter((call) => call.name === 'submitAgentPlan')
      if (calls.length !== 1) {
        if (calls.length === 0 && response.toolCalls.length > 0) {
          throw new AgentPlannerError(
            'MODEL_TOOL_UNSUPPORTED',
            '模型调用了当前应用未注册的工具；本次没有修改画布。请换一种说法，或在设置中改用更稳定的工具调用模型。'
          )
        }
        throw new AgentPlannerError(
          'MODEL_TOOL_CALL_MISSING',
          '文字模型没有返回可验证的操作计划；本次没有修改画布。请检查协议选择和模型的工具调用能力。'
        )
      }
      const rawPlan = normalizeAgentPlanCreativeBriefs(
        parseAgentPlan(calls[0]!.arguments),
        request,
        { idFactory: randomUUID, createdAt: new Date().toISOString() }
      )
      const blockedGeneration = !this.#imageGenerationAvailable && rawPlan.tools.some(isGenerationTool)
      const plan = validateChatPlan(lockGenerationProvider(
        rawPlan,
        this.#imageProviderId,
        this.#imageModel,
        this.#maxImages,
        this.#imageGenerationAvailable
      ), request)
      if (plan.tools.length === 0 && requestRequiresToolPlan(request) && !blockedGeneration) {
        throw new AgentPlannerError(
          'MODEL_ACTION_PLAN_EMPTY',
          '文字模型理解到了执行型要求，但没有给出任何可执行操作；本次没有修改画布。请重试，或检查协议与工具调用配置。'
        )
      }
      await observePlannerEvent({
        type: 'plan.validation.completed',
        payload: {
          schemaVersion: 1, requestCorrelationId, occurredAt: new Date().toISOString(),
          elapsedMs: Date.now() - observedStartedAt, toolCount: plan.tools.length, failureCode: null
        }
      })
      return plan
    } catch (error) {
      const failureCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'MODEL_PLAN_SCHEMA_INVALID'
      await observePlannerEvent({
        type: 'plan.validation.failed',
        payload: {
          schemaVersion: 1, requestCorrelationId, occurredAt: new Date().toISOString(),
          elapsedMs: Date.now() - observedStartedAt, toolCount: response?.toolCalls.length ?? null, failureCode
        }
      })
      throw annotateProviderAttempt(error, attemptId, requestCorrelationId)
    }
  }

  async #readAttachments(request: AgentRequest): Promise<{
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    base64: string
  }[]> {
    const assetIds = [...new Set(request.attachments
      .filter((attachment) => attachment.kind === 'asset')
      .map((attachment) => attachment.id))]
      .slice(0, MAX_ATTACHMENT_COUNT)
    const images: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }[] = []
    let total = 0
    for (const assetId of assetIds) {
      const resolved = await this.#assets.resolveAsset(assetId)
      const bytes = await readFile(resolved.filePath)
      if (bytes.length > MAX_ATTACHMENT_BYTES || total + bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) continue
      total += bytes.length
      images.push({ mimeType: mimeFor(resolved.asset.format), base64: bytes.toString('base64') })
    }
    return images
  }
}

/** Keeps all offline tests deterministic and activates Ark only when the local LLM key exists. */
export class CredentialAwareAgentPlanner implements AgentPlanner {
  readonly #secrets: SecretAvailability
  readonly #live: AgentPlanner
  readonly #fallback: AgentPlanner

  constructor(options: {
    readonly secrets: SecretAvailability
    readonly live: AgentPlanner
    readonly fallback: AgentPlanner
  }) {
    this.#secrets = options.secrets
    this.#live = options.live
    this.#fallback = options.fallback
  }

  async plan(request: AgentRequest, signal: AbortSignal, recovery?: AgentFailureEnvelope | null, context?: AgentPlannerAttemptContext): Promise<AgentPlan> {
    const planner = await this.#secrets.has('openai-compatible-llm') ? this.#live : this.#fallback
    return forwardPlan(planner, request, signal, recovery, context)
  }
}

function forwardPlan(
  planner: AgentPlanner,
  request: AgentRequest,
  signal: AbortSignal,
  recovery?: AgentFailureEnvelope | null,
  context?: AgentPlannerAttemptContext
): Promise<AgentPlan> {
  if ((recovery === undefined || recovery === null) && context === undefined) {
    return planner.plan(request, signal)
  }
  return planner.plan(request, signal, recovery ?? undefined, context)
}

/**
 * Reads the owner configuration for every turn, so changing a Provider does
 * not require reopening a project and credentials never leave Main.
 */
export class ConfiguredAgentPlanner implements AgentPlanner {
  readonly #secrets: SecretAvailability
  readonly #config: { read(): Promise<ProviderConfigFile> }
  readonly #createLive: (
    llm: Extract<ProviderPublicConfig, { kind: 'llm' }>,
    image: Extract<ProviderPublicConfig, { kind: 'image' }>,
    maxImages: number,
    imageGenerationAvailable: boolean
  ) => AgentPlanner
  readonly #fallback: AgentPlanner

  constructor(options: {
    readonly secrets: SecretAvailability
    readonly config: { read(): Promise<ProviderConfigFile> }
    readonly createLive: (
      llm: Extract<ProviderPublicConfig, { kind: 'llm' }>,
      image: Extract<ProviderPublicConfig, { kind: 'image' }>,
      maxImages: number,
      imageGenerationAvailable: boolean
    ) => AgentPlanner
    readonly fallback: AgentPlanner
  }) {
    this.#secrets = options.secrets
    this.#config = options.config
    this.#createLive = options.createLive
    this.#fallback = options.fallback
  }

  async plan(request: AgentRequest, signal: AbortSignal, recovery?: AgentFailureEnvelope | null, context?: AgentPlannerAttemptContext): Promise<AgentPlan> {
    if (!await this.#secrets.has('openai-compatible-llm')) {
      return forwardPlan(this.#fallback, request, signal, recovery, context)
    }
    const config = await this.#config.read()
    const llm = config.providers.find((provider): provider is Extract<ProviderPublicConfig, { kind: 'llm' }> => provider.kind === 'llm')
    const image = config.providers.find((provider): provider is Extract<ProviderPublicConfig, { kind: 'image' }> => provider.kind === 'image')
    if (llm === undefined || image === undefined || llm.baseUrl === '' || llm.defaultModel === '' || !llm.capabilities.toolCalling) {
      return forwardPlan(this.#fallback, request, signal, recovery, context)
    }
    const imageGenerationAvailable = image.protocol !== 'unconfigured'
      && image.baseUrl !== ''
      && image.defaultModel !== ''
      && image.capabilities.textToImage
      && (image.protocol !== 'task-images' || config.executionPolicy.maxRequestsPerJob >= 3)
    const boundedRequest = request.autoGenerate && !config.executionPolicy.autoGenerate
      ? { ...request, autoGenerate: false }
      : request
    const live = this.#createLive(llm, image, config.executionPolicy.maxImagesPerJob, imageGenerationAvailable)
    return forwardPlan(live, boundedRequest, signal, recovery, context)
  }
}
