import { createHash } from 'node:crypto'
import type { AgentRequest } from '../../shared/agent'
import type { AgentEvent, AgentGoalContract, AgentItem, AgentTurn } from '../../shared/agent-harness'
import type {
  ContextCompaction,
  ContextDisposition,
  ContextManifest,
  ContextSourceType,
  OutboundContextPolicy,
  ProjectDirective,
  ProjectMemoryEntry
} from '../../shared/agent-context'
import { redactSensitive } from '../security/redacted-logger'
import type { ContextManifestEntryInput, CreateContextCompactionInput, CreateContextManifestInput } from './agent-context-repository'

const DEFAULT_TEXT_BUDGET = 64_000
const DEFAULT_INLINE_ELEMENTS = 20
export const RECENT_CONVERSATION_ITEM_LIMIT = 10
const ABSOLUTE_PATH_PATTERNS = [
  /\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/g,
  /\\\\[^\s"'<>|]+\\[^\s"'<>|]+(?:\\[^\s"'<>|]+)*/g,
  /\bfile:\/\/[^\s"'<>]+/gi,
  /\/(?:Users|home|tmp|var|etc|opt)\/(?:[^\s"'<>]+\/)*[^\s"'<>]*/g
]
const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|cookie|credential|header/i

export interface DirectiveConflict {
  readonly id: string
  readonly kind: 'generation' | 'aspect_ratio' | 'language'
  readonly directiveId: string
  readonly directiveText: string
  readonly requestText: string
  readonly explanation: string
}

export interface ContextBuildInput {
  readonly projectId: string
  readonly threadId: string
  readonly turn: AgentTurn
  readonly goal: AgentGoalContract | null
  readonly request: AgentRequest
  readonly items: readonly AgentItem[]
  readonly directives: readonly ProjectDirective[]
  readonly memories: readonly ProjectMemoryEntry[]
  readonly compactions?: readonly ContextCompaction[]
  readonly outboundPolicy: OutboundContextPolicy
  readonly allowedTools: readonly string[]
  readonly resolvedDirectiveIds?: readonly string[]
  readonly maxTextBytes?: number
  readonly maxInlineElements?: number
}

export interface ContextBuildResult {
  readonly manifest: CreateContextManifestInput
  readonly conflicts: readonly DirectiveConflict[]
}

export interface OutboundPolicyEvaluationInput {
  readonly policy: OutboundContextPolicy
  readonly dataTypes: readonly string[]
  readonly imageAssetIds: readonly string[]
  readonly providerLocal: boolean
  readonly permissionAllowsExternal: boolean
  readonly imageReviewApproved?: boolean
  readonly customAllowedDataTypes?: readonly string[]
}

export interface OutboundPolicyEvaluation {
  readonly allowed: boolean
  readonly status: 'prepared' | 'approved' | 'blocked'
  readonly reason: string
}

export interface PlannerContextEnvelope {
  readonly instructions: {
    readonly policy: readonly unknown[]
    readonly user: readonly unknown[]
    readonly directives: readonly unknown[]
  }
  readonly authoritativeData: readonly unknown[]
  readonly untrustedData: readonly unknown[]
  readonly toolAvailable: readonly { readonly sourceType: ContextSourceType; readonly sourceId: string; readonly scope: string }[]
  readonly excluded: readonly { readonly sourceType: ContextSourceType; readonly sourceId: string; readonly reason: string }[]
}

function redactAbsolutePaths(value: string): string {
  return ABSOLUTE_PATH_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[LOCAL_PATH_REDACTED]'), value)
}

export function sanitizeContextText(value: string): string {
  return redactAbsolutePaths(redactSensitive(value)).slice(0, 64_000)
}

export function sanitizeContextValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeContextText(value)
  if (Array.isArray(value)) return value.map(sanitizeContextValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeContextValue(nested)
    ]))
  }
  return value
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]))
  }
  return value
}

export function contextSourceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export function compilePlannerContext(manifest: ContextManifest): PlannerContextEnvelope {
  const included = manifest.entries.filter((entry) => entry.disposition === 'inline' || entry.disposition === 'outbound')
  return {
    instructions: {
      policy: included.filter((entry) => entry.sourceType === 'policy').map((entry) => entry.content),
      user: included.filter((entry) => entry.sourceType === 'user').map((entry) => entry.content),
      directives: included.filter((entry) => entry.sourceType === 'directive').map((entry) => entry.content)
    },
    authoritativeData: included
      .filter((entry) => ['scene', 'selection', 'job', 'result'].includes(entry.sourceType))
      .map((entry) => entry.content),
    untrustedData: included
      .filter((entry) => ['memory', 'summary', 'preference'].includes(entry.sourceType))
      .map((entry) => entry.content),
    toolAvailable: manifest.entries
      .filter((entry) => entry.disposition === 'tool_available')
      .map((entry) => ({ sourceType: entry.sourceType, sourceId: entry.sourceId, scope: entry.scope })),
    excluded: manifest.entries
      .filter((entry) => entry.disposition === 'excluded')
      .map((entry) => ({ sourceType: entry.sourceType, sourceId: entry.sourceId, reason: entry.reason }))
  }
}

function estimatedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function requestAspect(text: string): string | null {
  const match = text.match(/\b(\d{1,3})\s*[:：/]\s*(\d{1,3})\b/)
  return match === null ? null : `${Number(match[1])}:${Number(match[2])}`
}

function generationIntent(text: string): 'allow' | 'deny' | null {
  const normalized = text.toLowerCase()
  if (/(不要|禁止|不准|先不|无需|别).{0,8}(生成|生图)|(?:do not|don't|never|without).{0,12}(?:generate|generation|image)/i.test(normalized)) return 'deny'
  if (/(现在|直接|立即|开始|请|要).{0,8}(生成|生图)|(?:generate|create|make).{0,8}(?:image|picture|artwork)/i.test(normalized)) return 'allow'
  return null
}

function languageIntent(text: string): 'english' | 'chinese' | null {
  if (/(必须|只用|保留|使用).{0,6}(英文|英语)|(?:must|only|keep|use).{0,8}english/i.test(text)) return 'english'
  if (/(必须|只用|使用).{0,6}(中文|汉字)|(?:must|only|use).{0,8}chinese/i.test(text)) return 'chinese'
  return null
}

export function detectDirectiveConflicts(
  requestText: string,
  directives: readonly ProjectDirective[],
  resolvedDirectiveIds: readonly string[] = []
): readonly DirectiveConflict[] {
  const resolved = new Set(resolvedDirectiveIds)
  const conflicts: DirectiveConflict[] = []
  const requestGeneration = generationIntent(requestText)
  const requestRatio = requestAspect(requestText)
  const requestLanguage = languageIntent(requestText)
  for (const directive of directives.filter((entry) => entry.enabled && !resolved.has(entry.id))) {
    const directiveGeneration = generationIntent(directive.text)
    if (requestGeneration !== null && directiveGeneration !== null && requestGeneration !== directiveGeneration) {
      conflicts.push({
        id: `generation:${directive.id}`,
        kind: 'generation',
        directiveId: directive.id,
        directiveText: directive.text,
        requestText,
        explanation: '本轮是否生成与项目长期规则相反，需要用户明确选择。'
      })
      continue
    }
    const directiveRatio = requestAspect(directive.text)
    if (requestRatio !== null && directiveRatio !== null && requestRatio !== directiveRatio) {
      conflicts.push({
        id: `aspect_ratio:${directive.id}`,
        kind: 'aspect_ratio',
        directiveId: directive.id,
        directiveText: directive.text,
        requestText,
        explanation: `本轮要求 ${requestRatio}，项目规则要求 ${directiveRatio}。`
      })
      continue
    }
    const directiveLanguage = languageIntent(directive.text)
    if (requestLanguage !== null && directiveLanguage !== null && requestLanguage !== directiveLanguage) {
      conflicts.push({
        id: `language:${directive.id}`,
        kind: 'language',
        directiveId: directive.id,
        directiveText: directive.text,
        requestText,
        explanation: '本轮文字语言与项目长期规则相反。'
      })
    }
  }
  return conflicts
}

function recentConversation(items: readonly AgentItem[]): readonly unknown[] {
  return items
    .filter((item) => item.status === 'completed' && (item.type === 'user_message' || item.type === 'assistant_message'))
    .slice(-RECENT_CONVERSATION_ITEM_LIMIT)
    .map((item) => {
      const stored = item.payload as { readonly request?: { readonly text?: unknown }; readonly content?: unknown }
      const text = item.type === 'user_message' ? stored.request?.text : stored.content
      return {
        itemId: item.id,
        type: item.type,
        payload: { trust: 'untrusted_data', text: sanitizeContextText(typeof text === 'string' ? text : '') }
      }
    })
}

function latestCompaction(compactions: readonly ContextCompaction[]): ContextCompaction | null {
  return [...compactions].sort((left, right) =>
    right.sourceSequenceTo - left.sourceSequenceTo || right.version - left.version || left.id.localeCompare(right.id)
  )[0] ?? null
}

function memoryRelevance(requestText: string, memory: ProjectMemoryEntry): number {
  if (memory.kind === 'constraint') return 100 + memory.confidence
  if (memory.kind === 'direction') return 80 + memory.confidence
  const request = requestText.toLowerCase()
  const chunks = memory.content.toLowerCase().split(/[\s，。！？、,.;:：；]+/).filter((chunk) => chunk.length >= 2)
  const overlap = chunks.filter((chunk) => request.includes(chunk)).length
  return overlap * 10 + memory.confidence
}

function safeElementSummary(element: AgentRequest['sceneSummary']['elements'][number]): unknown {
  return sanitizeContextValue({
    id: element.id,
    type: element.type,
    name: element.name,
    description: element.description,
    semanticRole: element.semanticRole,
    groupId: element.groupId,
    ...(element.childIds === undefined ? {} : { childIds: element.childIds }),
    locked: element.locked,
    visible: element.visible,
    transform: element.transform,
    content: element.content,
    fontSize: element.fontSize,
    fontFamily: element.fontFamily,
    fontWeight: element.fontWeight,
    align: element.align,
    fill: element.fill,
    assetId: element.assetId,
    hasEditMask: element.hasEditMask,
    trust: 'untrusted_data'
  })
}

function itemPayload(entry: ContextManifestEntryInput): unknown {
  return {
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    version: entry.version,
    scope: entry.scope,
    disposition: entry.disposition,
    reason: entry.reason,
    content: entry.content
  }
}

export class ContextBuilder {
  build(input: ContextBuildInput): ContextBuildResult {
    const maxTextBytes = Math.max(4_096, Math.floor(input.maxTextBytes ?? DEFAULT_TEXT_BUDGET))
    const maxInlineElements = Math.max(1, Math.floor(input.maxInlineElements ?? DEFAULT_INLINE_ELEMENTS))
    const entries: ContextManifestEntryInput[] = []
    let usedBytes = 0
    const append = (
      sourceType: ContextSourceType,
      sourceId: string,
      version: number | null,
      scope: string,
      disposition: ContextDisposition,
      reason: string,
      rawContent: unknown,
      required = false
    ): void => {
      const content = sanitizeContextValue(rawContent)
      const bytes = estimatedBytes(content)
      const fits = required || disposition !== 'inline' || usedBytes + bytes <= maxTextBytes
      const actualDisposition: ContextDisposition = fits ? disposition : 'excluded'
      const actualReason = fits ? reason : `${reason}；超过本轮 ${maxTextBytes} bytes 上下文预算，保留来源但不内联。`
      entries.push({ sourceType, sourceId, version, scope, disposition: actualDisposition, reason: actualReason, content, estimatedBytes: bytes })
      if (actualDisposition === 'inline' || actualDisposition === 'outbound') usedBytes += bytes
    }

    append('policy', 'product-v1-charter', 1, 'turn', 'inline', '最高优先级的权限、预算和禁止项。', {
      trust: 'trusted_policy',
      mode: input.goal?.mode ?? 'collaboration',
      budget: input.goal?.budget ?? null,
      generationUsage: input.request.generationBudget ?? null,
      prohibitions: input.goal?.prohibitions ?? ['没有活动 Goal；外部调用必须等待明确请求'],
      realApiAllowed: input.goal?.permissionProfileId === 'owner-full-v1',
      permissionExpansionAllowed: false
    }, true)
    append('user', input.turn.inputMessageId ?? input.turn.id, null, 'current_turn', 'inline', '当前明确请求优先于项目记忆和模型推断。', {
      trust: 'trusted_user_instruction',
      text: input.request.text,
      autoGenerate: input.request.autoGenerate,
      attachments: input.request.attachments,
      ephemeralAnnotation: input.request.ephemeralAnnotation === null ? null : {
        targetElementId: input.request.ephemeralAnnotation.targetElementId,
        regionCount: input.request.ephemeralAnnotation.regions?.length ?? 1
      }
    }, true)
    if (input.goal !== null) {
      append('policy', input.goal.id, input.goal.version, 'goal', 'inline', '持久 Goal Contract 定义范围和完成标准。', {
        trust: 'trusted_goal_contract',
        objective: input.goal.objective,
        completionDefinition: input.goal.completionDefinition,
        scope: input.goal.scope,
        budget: input.goal.budget
      }, true)
    }

    const conflicts = detectDirectiveConflicts(input.request.text, input.directives, input.resolvedDirectiveIds)
    const conflictDirectiveIds = new Set(conflicts.map((conflict) => conflict.directiveId))
    for (const directive of [...input.directives].filter((entry) => entry.enabled).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
      append('directive', directive.id, directive.version, 'project', 'inline',
        conflictDirectiveIds.has(directive.id)
          ? '项目规则与本轮明确请求冲突；必须先完成 Decision，不允许模型自行取舍。'
          : '用户维护的项目长期规则。', {
          trust: 'trusted_project_directive',
          text: directive.text,
          category: directive.category,
          priority: directive.priority,
          conflictsWithCurrentRequest: conflictDirectiveIds.has(directive.id)
        }, true)
    }

    const sceneElements = input.request.sceneSummary.elements.slice(0, maxInlineElements).map(safeElementSummary)
    append('scene', 'scene-summary', input.request.sceneSummary.revision, 'current_project', 'inline', '当前权威 Scene 的有界结构摘要。', {
      trust: 'authoritative_project_data',
      revision: input.request.sceneSummary.revision,
      canvas: input.request.sceneSummary.canvas,
      elementCount: input.request.sceneSummary.elementCount,
      inlineElementCount: sceneElements.length,
      creativeBrief: input.request.sceneSummary.creativeBrief ?? null,
      elements: sceneElements
    }, true)
    append('scene', 'scene-full', input.request.sceneSummary.revision, 'current_project', 'tool_available', '完整 Scene 默认不内联，Planner 可通过受控 read_scene 工具按需读取。', {
      trust: 'authoritative_project_data',
      available: true,
      elementCount: input.request.sceneSummary.elementCount,
      allowedReadTool: input.allowedTools.includes('read_scene') || input.allowedTools.includes('scene.get_elements')
    })
    append('result', 'asset-catalog', null, 'current_project', 'tool_available', '素材元数据与生成结果按需读取，图片字节不会自动进入上下文。', {
      trust: 'authoritative_project_data',
      metadataTool: input.allowedTools.includes('assets.get_metadata'),
      resultsTool: input.allowedTools.includes('generation.get_results')
    })
    append('summary', 'thread-ledger', null, 'thread', 'tool_available', '完整 Thread/Event 历史保留在 Ledger，默认只读取近期必要消息。', {
      trust: 'authoritative_project_data',
      available: true
    })
    append('capability', 'capability-packs', null, 'turn', 'tool_available', '能力包只在当前任务确有需要时按名称加载。', {
      trust: 'trusted_capability_contract',
      loadTool: input.allowedTools.includes('capability.load')
    })

    append('selection', 'current-selection', input.request.sceneSummary.revision, 'current_turn', 'inline', '选区是本轮操作范围的直接信号。', {
      trust: 'authoritative_project_data',
      selectedIds: input.request.selectedIds,
      selectedElements: input.request.selectedElements.slice(0, maxInlineElements).map((element) => sanitizeContextValue({
        id: element.id,
        type: element.type,
        name: element.name,
        description: element.description,
        transform: element.transform,
        semanticRole: element.semanticRole
      })),
      truncated: input.request.selectedElements.length > maxInlineElements
    }, true)
    if (input.request.selectedElements.length > maxInlineElements) {
      append('selection', 'selection-full', input.request.sceneSummary.revision, 'current_turn', 'tool_available', '大型选区的完整元素数据按需读取。', {
        trust: 'authoritative_project_data',
        selectedIds: input.request.selectedIds
      })
    }

    if (input.request.activeGenerationJobId !== null) {
      append('job', input.request.activeGenerationJobId, null, 'current_project', 'inline', '当前未完成 Job 必须进入本轮上下文。', {
        trust: 'authoritative_project_data',
        jobId: input.request.activeGenerationJobId,
        details: 'Use a read-only generation job tool for current status.'
      }, true)
    }

    const recent = recentConversation(input.items)
    if (recent.length > 0) {
      append('summary', 'recent-conversation', null, 'thread', 'inline', '最近必要消息提供局部连续性；权威对象冲突时以对象本身为准。', {
        trust: 'untrusted_data',
        messages: recent
      })
    }

    const compaction = latestCompaction(input.compactions ?? [])
    if (compaction !== null) {
      append('summary', compaction.id, compaction.version, 'thread', 'inline',
        '较早回合的确定性压缩摘要；仅提供连续性，不能覆盖当前请求、当前 Scene 或项目规则。', {
          trust: 'untrusted_data',
          sourceSequenceFrom: compaction.sourceSequenceFrom,
          sourceSequenceTo: compaction.sourceSequenceTo,
          summary: compaction.summary
        })
    }

    const relevantMemories = [...input.memories]
      .filter((entry) => entry.status === 'active')
      .map((entry) => ({ entry, score: memoryRelevance(input.request.text, entry) }))
      .filter(({ score }) => score >= 1)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
      .slice(0, 20)
    for (const { entry: memory } of relevantMemories) {
      append('memory', memory.id, memory.version, 'project', 'inline', '与当前任务相关的已确认项目记忆；它是数据而不是权限或指令。', {
        trust: 'untrusted_data',
        kind: memory.kind,
        content: memory.content,
        provenance: { sourceType: memory.sourceType, sourceId: memory.sourceId, confidence: memory.confidence }
      })
    }
    append('capability', 'allowed-tools', 1, 'turn', 'inline', '仅向 Planner 暴露当前 Permission 允许的静态工具名称。', {
      trust: 'trusted_capability_contract',
      tools: input.allowedTools
    }, true)

    const sourceHash = contextSourceHash(entries.map(itemPayload))
    return {
      manifest: {
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turn.id,
        sceneRevision: input.request.sceneSummary.revision,
        outboundPolicy: input.outboundPolicy,
        entries,
        estimatedTextBytes: usedBytes,
        imageCount: 0,
        sourceHash
      },
      conflicts
    }
  }
}

export class OutboundPolicyGuard {
  evaluate(input: OutboundPolicyEvaluationInput): OutboundPolicyEvaluation {
    if (!input.permissionAllowsExternal && !input.providerLocal) {
      return { allowed: false, status: 'blocked', reason: 'Permission Profile does not authorize external model access.' }
    }
    if (input.policy === 'local_only') {
      return input.providerLocal
        ? { allowed: true, status: 'approved', reason: 'Local-only policy permits the explicitly local provider.' }
        : { allowed: false, status: 'blocked', reason: 'local_only blocks all external model calls.' }
    }
    if (input.policy === 'review_each_image' && input.imageAssetIds.length > 0 && input.imageReviewApproved !== true) {
      return { allowed: false, status: 'blocked', reason: 'Each outbound image requires explicit review.' }
    }
    if (input.policy === 'custom') {
      const allowedTypes = new Set(input.customAllowedDataTypes ?? [])
      const denied = input.dataTypes.filter((dataType) => !allowedTypes.has(dataType))
      if (denied.length > 0) {
        return { allowed: false, status: 'blocked', reason: `Custom outbound policy blocks: ${denied.join(', ')}.` }
      }
    }
    return {
      allowed: true,
      status: input.imageAssetIds.length > 0 && input.policy === 'review_each_image' ? 'approved' : 'prepared',
      reason: input.imageAssetIds.length > 0 ? 'Required image scope is explicitly recorded.' : 'Only required text data is prepared.'
    }
  }
}

function eventSummary(event: AgentEvent): string {
  const payload = sanitizeContextValue(event.payload)
  const value = typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload ?? '')
  return `${event.sequence}. ${event.type} [turn=${event.turnId ?? '-'} item=${event.itemId ?? '-'}]: ${value.slice(0, 240)}`
}

function compactItemSummary(item: AgentItem): string | null {
  const stored = item.payload as {
    readonly request?: { readonly text?: unknown }
    readonly content?: unknown
    readonly summary?: unknown
    readonly notes?: unknown
    readonly proposal?: { readonly title?: unknown; readonly explanation?: unknown }
    readonly optionId?: unknown
    readonly errorCode?: unknown
    readonly message?: unknown
    readonly jobId?: unknown
    readonly intentId?: unknown
    readonly lastJobStatus?: unknown
    readonly failure?: { readonly code?: unknown; readonly safeMessage?: unknown; readonly retryClass?: unknown }
    readonly outcome?: { readonly failure?: { readonly code?: unknown; readonly safeMessage?: unknown; readonly retryClass?: unknown } }
  }
  const identity = `[turn=${item.turnId} item=${item.id} type=${item.type} status=${item.status}]`
  if (item.type === 'user_message') {
    const text = typeof stored.request?.text === 'string' ? sanitizeContextText(stored.request.text) : ''
    return text.length === 0 ? `${identity} 用户消息无可用文本。` : `${identity} 用户：${text}`
  }
  if (item.type === 'assistant_message') {
    const text = typeof stored.content === 'string' ? sanitizeContextText(stored.content) : ''
    return text.length === 0 ? `${identity} 助手消息无可用文本。` : `${identity} 助手：${text}`
  }
  if (item.type === 'completion_assessment' && item.status === 'completed') {
    const summary = typeof stored.summary === 'string' ? sanitizeContextText(stored.summary) : ''
    const notes = Array.isArray(stored.notes)
      ? stored.notes.filter((note): note is string => typeof note === 'string').map(sanitizeContextText).slice(0, 4)
      : []
    return summary.length === 0 && notes.length === 0
      ? null
      : `${identity} 结果：${summary}${notes.length === 0 ? '' : `；备注：${notes.join('；')}`}`
  }
  if (item.type === 'decision') {
    const title = typeof stored.proposal?.title === 'string' ? sanitizeContextText(stored.proposal.title) : '用户决定'
    const explanation = typeof stored.proposal?.explanation === 'string' ? sanitizeContextText(stored.proposal.explanation) : ''
    const option = typeof stored.optionId === 'string' ? sanitizeContextText(stored.optionId) : ''
    return `${identity} 决定：${title}${explanation.length === 0 ? '' : `；${explanation}`}${option.length === 0 ? '；尚未选择' : `；选择 ${option}`}`
  }
  if (item.type === 'recovery') {
    const failure = stored.failure
    const code = typeof failure?.code === 'string' ? sanitizeContextText(failure.code) : 'RECOVERY'
    const retryClass = typeof failure?.retryClass === 'string' ? sanitizeContextText(failure.retryClass) : 'unknown'
    const message = typeof failure?.safeMessage === 'string' ? sanitizeContextText(failure.safeMessage).slice(0, 240) : ''
    return `${identity} 恢复：errorCode=${code}；retryClass=${retryClass}${message === '' ? '' : `；message=${message}`}`
  }
  if (item.status !== 'completed') {
    const failure = stored.failure ?? stored.outcome?.failure
    const facts = [
      typeof failure?.code === 'string'
        ? `errorCode=${sanitizeContextText(failure.code)}`
        : typeof stored.errorCode === 'string' ? `errorCode=${sanitizeContextText(stored.errorCode)}` : null,
      typeof failure?.safeMessage === 'string'
        ? `message=${sanitizeContextText(failure.safeMessage).slice(0, 240)}`
        : typeof stored.message === 'string' ? `message=${sanitizeContextText(stored.message).slice(0, 240)}` : null,
      typeof stored.jobId === 'string' ? `jobId=${sanitizeContextText(stored.jobId)}` : null,
      typeof stored.intentId === 'string' ? `intentId=${sanitizeContextText(stored.intentId)}` : null,
      typeof stored.lastJobStatus === 'string' ? `jobStatus=${sanitizeContextText(stored.lastJobStatus)}` : null
    ].filter((fact): fact is string => fact !== null)
    const kind = item.status === 'waiting' || item.status === 'queued' || item.status === 'started' ? '未完成活动' : '异常活动'
    return `${identity} ${kind}${facts.length === 0 ? '' : `：${facts.join('；')}`}`
  }
  return null
}

function isCriticalEvent(event: AgentEvent): boolean {
  if (event.type === 'turn.usage') return true
  if (/failed|waiting|interrupted|cancelled|budget|usage|decision|queue|job\./i.test(event.type)) return true
  if (event.type !== 'turn.completed') return false
  const status = (event.payload as { readonly status?: unknown } | null)?.status
  return typeof status === 'string' && !['completed', 'completed_with_notes'].includes(status)
}

function eventTypeCounts(events: readonly AgentEvent[]): string {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}=${count}`)
    .join('；')
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function boundedCompactionSummary(lines: readonly string[], maxBytes = 24_000): string {
  const joined = lines.join('\n')
  if (Buffer.byteLength(joined, 'utf8') <= maxBytes) return joined
  const marker = '\n… 已省略部分较早活动；完整记录仍保存在本地事件账本 …\n'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const headBudget = Math.floor((maxBytes - markerBytes) / 3)
  const tailBudget = maxBytes - markerBytes - headBudget
  const head = utf8Prefix(joined, headBudget)
  const reversed = [...joined].reverse().join('')
  const tail = [...utf8Prefix(reversed, tailBudget)].reverse().join('')
  return `${head}${marker}${tail}`
}

export class ContextCompactor {
  compact(
    projectId: string,
    threadId: string,
    events: readonly AgentEvent[],
    items: readonly AgentItem[] = []
  ): CreateContextCompactionInput | null {
    const ordered = [...events].sort((left, right) => left.sequence - right.sequence)
    const first = ordered[0]
    const last = ordered.at(-1)
    if (first === undefined || last === undefined) return null
    const turnSequence = new Map<string, number>()
    for (const event of ordered) {
      if (event.turnId !== null && !turnSequence.has(event.turnId)) turnSequence.set(event.turnId, event.sequence)
    }
    const orderedItems = [...items].sort((left, right) =>
      (turnSequence.get(left.turnId) ?? Number.MAX_SAFE_INTEGER) - (turnSequence.get(right.turnId) ?? Number.MAX_SAFE_INTEGER)
      || left.ordinal - right.ordinal
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    )
    const summarizedItems = orderedItems
      .map((item) => ({ item, summary: compactItemSummary(item) }))
      .filter((entry): entry is { readonly item: AgentItem; readonly summary: string } => entry.summary !== null)
    const source = {
      events: ordered.map((event) => ({ sequence: event.sequence, type: event.type, payload: sanitizeContextValue(event.payload) })),
      items: summarizedItems.map(({ item, summary }) => ({ id: item.id, turnId: item.turnId, type: item.type, summary }))
    }
    const semanticLines = summarizedItems.map((entry) => entry.summary)
    const criticalEventLines = ordered.filter(isCriticalEvent).map(eventSummary)
    return {
      projectId,
      threadId,
      sourceSequenceFrom: first.sequence,
      sourceSequenceTo: last.sequence,
      sourceHash: contextSourceHash(source),
      summary: boundedCompactionSummary([
        ...(semanticLines.length === 0 ? [] : ['早期创作对话与状态：', ...semanticLines]),
        ...(criticalEventLines.length === 0 ? [] : ['关键决定、失败、预算与未完成活动：', ...criticalEventLines]),
        '完整活动计数（完整事件仍保存在本地 Ledger，可按来源序列读取）：',
        eventTypeCounts(ordered)
      ])
    }
  }
}
