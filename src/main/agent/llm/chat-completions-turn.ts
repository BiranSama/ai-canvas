import { z } from 'zod'
import { resolveLlmProtocolEndpoint, type LlmImageDetail } from '../../../shared/provider-settings'
import { LlmProtocolError, type LlmProtocolRequest } from '../llm-provider'
import { addBounded, jsonFrame, type LlmStreamAccumulator, type LlmStreamObservation } from '../llm-stream'
import { resolveThinkingEffort, type LlmDialect, type ThinkingEffort } from './dialects'
import {
  imageDataUri,
  llmTurnInputSchema,
  type LlmAssistantPart,
  type LlmAssistantTurn,
  type LlmImage,
  type LlmStopReason,
  type LlmTranscriptMessage,
  type LlmTurnInput,
  type LlmUsage
} from './transcript'
import {
  IMAGE_WITHHELD_TEXT,
  currentLoopStart,
  finiteCount,
  llmTurnBaseUrlSchema,
  llmTurnModelSchema,
  optionalCount,
  recordField,
  replayableNative,
  toolCallFromText,
  toolResultImages,
  toolResultText,
  type LlmTurnProtocol,
  type LlmTurnProtocolConfig
} from './turn-protocol'

/** Reasoning fields some vendors require back on later steps of the same tool loop. */
const REASONING_REPLAY_FIELDS = ['reasoning_content', 'reasoning_details'] as const

const chatToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string().min(1), arguments: z.string().nullable().default('') }).passthrough()
}).passthrough()

const chatResponseSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      content: z.union([z.string(), z.array(z.unknown())]).nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
      tool_calls: z.array(chatToolCallSchema).nullable().optional()
    }).passthrough()
  }).passthrough()).min(1),
  usage: z.unknown().optional()
}).passthrough()

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const record = typeof part === 'object' && part !== null ? part as Record<string, unknown> : null
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('')
}

export function chatUsage(value: unknown): LlmUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as Record<string, unknown>
  if (typeof usage.prompt_tokens !== 'number' && typeof usage.completion_tokens !== 'number') return null
  const promptDetails = recordField(usage, 'prompt_tokens_details')
  const completionDetails = recordField(usage, 'completion_tokens_details')
  return {
    inputTokens: finiteCount(usage.prompt_tokens),
    cachedInputTokens: finiteCount(promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens),
    cacheWriteInputTokens: 0,
    outputTokens: finiteCount(usage.completion_tokens),
    reasoningTokens: optionalCount(completionDetails?.reasoning_tokens)
  }
}

function stopReasonFor(finishReason: string | null | undefined, hasToolCalls: boolean, refused: boolean): LlmStopReason {
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'content_filter') return 'content_filter'
  if (refused) return 'refusal'
  if (hasToolCalls || finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_calls'
  if (finishReason === 'stop' || finishReason === null || finishReason === undefined) return 'end_turn'
  return 'other'
}

function imagePart(image: LlmImage, detail: LlmImageDetail): Record<string, unknown> {
  return { type: 'image_url', image_url: { url: imageDataUri(image), ...(detail === 'auto' ? {} : { detail }) } }
}

/** Chat Completions with thinking, tool calls and per-vendor reasoning replay. */
export class ChatCompletionsTurnProtocol implements LlmTurnProtocol {
  readonly wire = 'chat-completions' as const
  readonly dialect: LlmDialect
  readonly model: string
  readonly capabilities: { readonly streaming: boolean; readonly vision: boolean }
  readonly #baseUrl: string
  readonly #effort: ThinkingEffort | null
  readonly #imageDetail: LlmImageDetail

  constructor(config: LlmTurnProtocolConfig) {
    this.#baseUrl = llmTurnBaseUrlSchema.parse(config.baseUrl)
    this.model = llmTurnModelSchema.parse(config.model)
    this.dialect = config.dialect
    this.#effort = resolveThinkingEffort(config.reasoningEffort ?? 'auto', config.dialect.efforts)
    this.#imageDetail = config.imageDetail ?? 'auto'
    this.capabilities = { streaming: config.streaming ?? true, vision: config.vision ?? false }
    resolveLlmProtocolEndpoint(this.#baseUrl, 'openai-chat-completions')
  }

  buildTurnRequest(inputValue: LlmTurnInput, stream: boolean): LlmProtocolRequest {
    const input = llmTurnInputSchema.parse(inputValue)
    const dialect = this.dialect.chat
    const thinking = dialect.thinking === 'thinking-type'
      ? { thinking: { type: 'enabled' } }
      : dialect.thinking === 'enable-thinking'
        ? { enable_thinking: true }
        : {}
    return {
      url: resolveLlmProtocolEndpoint(this.#baseUrl, 'openai-chat-completions'),
      body: {
        model: this.model,
        messages: [
          ...(input.system === '' ? [] : [{ role: 'system', content: input.system }]),
          ...this.#messages(input.messages)
        ],
        stream,
        ...(stream && dialect.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(input.tools.length === 0 ? {} : {
          tools: input.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters }
          })),
          tool_choice: input.toolChoice
        }),
        ...thinking,
        ...(dialect.effortField === null || this.#effort === null ? {} : { [dialect.effortField]: this.#effort }),
        [dialect.maxTokensField]: input.maxOutputTokens,
        ...(this.dialect.promptCacheKey && input.cacheKey !== undefined ? { prompt_cache_key: input.cacheKey } : {})
      }
    }
  }

  #messages(messages: readonly LlmTranscriptMessage[]): readonly Record<string, unknown>[] {
    const loopStart = currentLoopStart(messages)
    const target = { wire: this.wire, dialectId: this.dialect.id, model: this.model }
    return messages.flatMap((message, index): Record<string, unknown>[] => {
      if (message.role === 'user') {
        const onlyText = message.parts.every((part) => part.type === 'text')
        if (onlyText) return [{ role: 'user', content: message.parts.map((part) => part.type === 'text' ? part.text : '').join('\n') }]
        return [{
          role: 'user',
          content: message.parts.map((part) => part.type === 'text'
            ? { type: 'text', text: part.text }
            : this.capabilities.vision ? imagePart(part.image, this.#imageDetail) : { type: 'text', text: IMAGE_WITHHELD_TEXT })
        }]
      }
      if (message.role === 'assistant') {
        const native = replayableNative(message.native, target)
        if (native !== null && typeof native.payload === 'object' && native.payload !== null) {
          const replay: Record<string, unknown> = { ...native.payload as Record<string, unknown> }
          // Reasoning from earlier person turns is not needed and some vendors reject it.
          if (index < loopStart) for (const field of REASONING_REPLAY_FIELDS) delete replay[field]
          return [replay]
        }
        const text = message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
        const calls = message.parts.flatMap((part) => part.type === 'tool_call' ? [part.call] : [])
        return [{
          role: 'assistant',
          content: calls.length > 0 && text === '' ? null : text,
          ...(calls.length === 0 ? {} : {
            tool_calls: calls.map((call) => ({
              id: call.callId,
              type: 'function',
              function: { name: call.name, arguments: call.argumentsText }
            }))
          })
        }]
      }
      // Chat tool messages carry text only; images follow in one user message.
      const withImages = this.capabilities.vision
        ? message.results.filter((result) => toolResultImages(result).length > 0)
        : []
      return [
        ...message.results.map((result) => ({
          role: 'tool',
          tool_call_id: result.callId,
          content: toolResultText(result, withImages.includes(result))
        })),
        ...(withImages.length === 0 ? [] : [{
          role: 'user',
          content: withImages.flatMap((result) => [
            { type: 'text', text: `工具 ${result.name} 的结果图片：` },
            ...toolResultImages(result).map((image) => imagePart(image, this.#imageDetail))
          ])
        }])
      ]
    })
  }

  parseTurnResponse(value: unknown): LlmAssistantTurn {
    const parsed = chatResponseSchema.parse(value)
    const choice = parsed.choices[0]!
    const message = choice.message
    const reasoning = message.reasoning_content ?? message.reasoning ?? ''
    const text = contentText(message.content)
    const toolCalls = message.tool_calls ?? []
    const parts: LlmAssistantPart[] = [
      ...(reasoning === '' ? [] : [{ type: 'reasoning' as const, text: reasoning }]),
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...toolCalls.map((call) => ({
        type: 'tool_call' as const,
        call: toolCallFromText(call.id, call.function.name, call.function.arguments ?? '')
      }))
    ]
    const replay: Record<string, unknown> = { role: 'assistant', content: message.content ?? null }
    for (const field of [...REASONING_REPLAY_FIELDS, 'extra_content'] as const) {
      if (message[field] !== undefined && message[field] !== null) replay[field] = message[field]
    }
    if (toolCalls.length > 0) replay.tool_calls = toolCalls.map((call) => ({ ...call, type: 'function' }))
    return {
      responseId: parsed.id ?? null,
      parts,
      native: { wire: this.wire, dialectId: this.dialect.id, model: this.model, payload: replay },
      stopReason: stopReasonFor(choice.finish_reason, toolCalls.length > 0, (message.refusal ?? '') !== ''),
      usage: chatUsage(parsed.usage)
    }
  }

  createTurnStreamAccumulator(): LlmStreamAccumulator<LlmAssistantTurn> {
    return createChatTurnStreamAccumulator((value) => this.parseTurnResponse(value))
  }
}

interface PendingChatToolCall {
  id: string | null
  name: string
  arguments: string
  extra: Record<string, unknown>
}

const chatChunkSchema = z.object({
  id: z.string().nullable().optional(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative().default(0),
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().nullable().optional(),
        function: z.object({ name: z.string().nullable().optional(), arguments: z.string().nullable().optional() }).passthrough().optional()
      }).passthrough()).nullable().optional()
    }).passthrough().default({})
  }).passthrough()).default([]),
  usage: z.unknown().optional()
}).passthrough()

/** Rebuilds a complete Chat Completions response from its stream, then parses it like a buffered one. */
export function createChatTurnStreamAccumulator(
  parse: (value: unknown) => LlmAssistantTurn
): LlmStreamAccumulator<LlmAssistantTurn> {
  let responseId: string | null = null
  let done = false
  let content = ''
  let reasoning = ''
  let reasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content'
  let refusal = ''
  let finishReason: string | null = null
  let usage: unknown = undefined
  let extraContent: unknown = undefined
  const calls = new Map<number, PendingChatToolCall>()
  return {
    accept(frame) {
      if (done) return []
      if (frame.data.trim() === '[DONE]') {
        done = true
        return [{ kind: 'terminal', responseId, semantic: true }]
      }
      const payload = jsonFrame(frame)
      if (payload === null) return [{ kind: 'transport', responseId, semantic: false }]
      if ('error' in payload && !('choices' in payload)) {
        throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商在响应流中返回了失败；本次没有执行工具。')
      }
      const parsed = chatChunkSchema.safeParse(payload)
      if (!parsed.success) throw new LlmProtocolError('PROVIDER_STREAM_MALFORMED', '供应商返回了不符合 Chat Completions 的流式事件。')
      responseId = parsed.data.id ?? responseId
      if (parsed.data.usage !== undefined && parsed.data.usage !== null) usage = parsed.data.usage
      const observations: LlmStreamObservation[] = []
      for (const choice of parsed.data.choices) {
        if (choice.index !== 0) continue
        const delta = choice.delta
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? ''
        if (reasoningDelta !== '') {
          // Replay uses the field name the vendor itself used.
          if (typeof delta.reasoning_content !== 'string') reasoningField = 'reasoning'
          reasoning += reasoningDelta
          observations.push({ kind: 'reasoning', responseId, semantic: true })
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          content += delta.content
          observations.push({ kind: 'text', responseId, semantic: true })
        }
        if (typeof delta.refusal === 'string') refusal += delta.refusal
        if (delta.extra_content !== undefined) extraContent = delta.extra_content
        for (const call of delta.tool_calls ?? []) {
          const current = calls.get(call.index) ?? { id: null, name: '', arguments: '', extra: {} }
          const { id, function: fn } = call
          const extra = Object.fromEntries(Object.entries(call).filter(([key]) => !['index', 'id', 'type', 'function'].includes(key)))
          current.id = id ?? current.id
          if (typeof fn?.name === 'string') current.name = addBounded(current.name, fn.name)
          if (typeof fn?.arguments === 'string') current.arguments = addBounded(current.arguments, fn.arguments)
          current.extra = { ...current.extra, ...extra }
          calls.set(call.index, current)
          observations.push({ kind: 'tool_arguments', responseId, semantic: (fn?.arguments ?? '') !== '' })
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = choice.finish_reason
          observations.push({ kind: calls.size > 0 ? 'tool_arguments_complete' : 'text', responseId, semantic: true })
        }
      }
      return observations.length > 0 ? observations : [{ kind: 'transport', responseId, semantic: false }]
    },
    finalize() {
      // A stream that reported why it finished is complete even if the closing [DONE] was lost.
      if (!done && finishReason === null) {
        throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '响应流结束，但没有收到结束标记。')
      }
      const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => {
        if (call.id === null || call.name === '') {
          throw new LlmProtocolError('PROVIDER_TOOL_ARGUMENTS_INCOMPLETE', '响应结束时工具身份仍不完整。')
        }
        return { ...call.extra, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }
      })
      return parse({
        id: responseId,
        choices: [{
          finish_reason: finishReason,
          message: {
            content: content === '' && toolCalls.length > 0 ? null : content,
            ...(reasoning === '' ? {} : { [reasoningField]: reasoning }),
            ...(refusal === '' ? {} : { refusal }),
            ...(extraContent === undefined ? {} : { extra_content: extraContent }),
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
          }
        }],
        ...(usage === undefined ? {} : { usage })
      })
    }
  }
}
