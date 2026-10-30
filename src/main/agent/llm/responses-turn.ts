import { z } from 'zod'
import { resolveLlmProtocolEndpoint, type LlmImageDetail } from '../../../shared/provider-settings'
import { LlmProtocolError, type LlmProtocolRequest } from '../llm-provider'
import { addBounded, jsonFrame, type LlmStreamAccumulator } from '../llm-stream'
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

const responseSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  status: z.string().nullable().optional(),
  incomplete_details: z.object({ reason: z.string().nullable().optional() }).passthrough().nullable().optional(),
  error: z.object({ message: z.string().nullable().optional() }).passthrough().nullable().optional(),
  output: z.array(z.unknown()).default([]),
  usage: z.unknown().optional()
}).passthrough()

type Item = Record<string, unknown>

function asItem(value: unknown): Item | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Item : null
}

function textsOf(value: unknown, types: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = asItem(entry)
    return item !== null && typeof item.type === 'string' && types.includes(item.type) && typeof item.text === 'string'
      ? [item.text]
      : []
  })
}

export function responsesUsage(value: unknown): LlmUsage | null {
  const usage = asItem(value)
  if (usage === null || typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number') return null
  return {
    inputTokens: finiteCount(usage.input_tokens),
    cachedInputTokens: finiteCount(recordField(usage, 'input_tokens_details')?.cached_tokens),
    cacheWriteInputTokens: 0,
    outputTokens: finiteCount(usage.output_tokens),
    reasoningTokens: optionalCount(recordField(usage, 'output_tokens_details')?.reasoning_tokens)
  }
}

function hasEncryptedReasoning(item: Item): boolean {
  return typeof item.encrypted_content === 'string' && item.encrypted_content !== ''
}

/** Responses API (OpenAI, xAI, Ark and relays) with thinking and output-item replay. */
export class ResponsesTurnProtocol implements LlmTurnProtocol {
  readonly wire = 'responses' as const
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
    resolveLlmProtocolEndpoint(this.#baseUrl, 'openai-responses')
  }

  buildTurnRequest(inputValue: LlmTurnInput, stream: boolean): LlmProtocolRequest {
    const input = llmTurnInputSchema.parse(inputValue)
    const dialect = this.dialect.responses
    const reasoning: Record<string, unknown> = {
      ...(this.#effort === null ? {} : { effort: this.#effort }),
      ...(dialect.reasoningSummary ? { summary: 'auto' } : {})
    }
    return {
      url: resolveLlmProtocolEndpoint(this.#baseUrl, 'openai-responses'),
      body: {
        model: this.model,
        input: this.#items(input.messages),
        stream,
        store: false,
        ...(input.system === '' ? {} : { instructions: input.system }),
        ...(input.tools.length === 0 ? {} : {
          tools: input.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          })),
          tool_choice: input.toolChoice
        }),
        ...(dialect.thinking === 'ark-thinking' ? { thinking: { type: 'enabled' } } : {}),
        ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
        ...(dialect.includeEncryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
        max_output_tokens: input.maxOutputTokens,
        ...(this.dialect.promptCacheKey && input.cacheKey !== undefined ? { prompt_cache_key: input.cacheKey } : {})
      }
    }
  }

  #imageContent(image: LlmImage): Item {
    return { type: 'input_image', image_url: imageDataUri(image), ...(this.#imageDetail === 'auto' ? {} : { detail: this.#imageDetail }) }
  }

  #items(messages: readonly LlmTranscriptMessage[]): readonly Item[] {
    const target = { wire: this.wire, dialectId: this.dialect.id, model: this.model }
    const inlineImages = this.capabilities.vision && this.dialect.responses.toolResultImages === 'inline'
    return messages.flatMap((message): Item[] => {
      if (message.role === 'user') {
        const onlyText = message.parts.every((part) => part.type === 'text')
        return [{
          type: 'message',
          role: 'user',
          content: onlyText
            ? message.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')
            : message.parts.map((part) => part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : this.capabilities.vision ? this.#imageContent(part.image) : { type: 'input_text', text: IMAGE_WITHHELD_TEXT })
        }]
      }
      if (message.role === 'assistant') {
        const native = replayableNative(message.native, target)
        if (native !== null && Array.isArray(native.payload)) return this.#replayItems(native.payload)
        return message.parts.flatMap((part): Item[] => {
          if (part.type === 'text') return [{ type: 'message', role: 'assistant', content: part.text }]
          if (part.type === 'tool_call') {
            return [{ type: 'function_call', call_id: part.call.callId, name: part.call.name, arguments: part.call.argumentsText }]
          }
          return []
        })
      }
      const followUp = !inlineImages && this.capabilities.vision
        ? message.results.filter((result) => toolResultImages(result).length > 0)
        : []
      return [
        ...message.results.map((result) => ({
          type: 'function_call_output',
          call_id: result.callId,
          output: inlineImages && toolResultImages(result).length > 0
            ? result.content.map((part) => part.type === 'text' ? { type: 'input_text', text: part.text } : this.#imageContent(part.image))
            : toolResultText(result, followUp.includes(result))
        })),
        ...(followUp.length === 0 ? [] : [{
          type: 'message',
          role: 'user',
          content: followUp.flatMap((result) => [
            { type: 'input_text', text: `工具 ${result.name} 的结果图片：` },
            ...toolResultImages(result).map((image) => this.#imageContent(image))
          ])
        }])
      ]
    })
  }

  /**
   * Sends the step's output items back unchanged. Where reasoning cannot be
   * replayed without server-side storage, it is dropped together with the item
   * IDs that would point at it.
   */
  #replayItems(payload: readonly unknown[]): Item[] {
    const items = payload.flatMap((entry) => {
      const item = asItem(entry)
      return item === null ? [] : [item]
    })
    if (this.dialect.responses.replayReasoning === 'all') return items
    const dropped = items.some((item) => item.type === 'reasoning' && !hasEncryptedReasoning(item))
    if (!dropped) return items
    return items.flatMap((item) => {
      if (item.type === 'reasoning') return hasEncryptedReasoning(item) ? [item] : []
      return [Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))]
    })
  }

  parseTurnResponse(value: unknown): LlmAssistantTurn {
    const parsed = responseSchema.parse(value)
    const status = parsed.status ?? 'completed'
    if (status === 'failed') {
      throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商明确返回响应失败；本次没有执行任何工具。')
    }
    if (status !== 'completed' && status !== 'incomplete') {
      throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '供应商响应尚未完成；本次没有执行工具。')
    }
    const parts: LlmAssistantPart[] = []
    let refused = false
    let toolCalls = 0
    for (const entry of parsed.output) {
      const item = asItem(entry)
      if (item === null) continue
      if (item.type === 'reasoning') {
        const text = [...textsOf(item.summary, ['summary_text']), ...textsOf(item.content, ['reasoning_text'])].join('\n')
        if (text !== '') parts.push({ type: 'reasoning', text })
      } else if (item.type === 'message') {
        const text = textsOf(item.content, ['output_text']).join('')
        if (text !== '') parts.push({ type: 'text', text })
        refused ||= Array.isArray(item.content) && item.content.some((part) => asItem(part)?.type === 'refusal')
      } else if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
        toolCalls += 1
        parts.push({ type: 'tool_call', call: toolCallFromText(item.call_id, item.name, typeof item.arguments === 'string' ? item.arguments : '') })
      }
    }
    const reason = parsed.incomplete_details?.reason ?? null
    const stopReason: LlmStopReason = status === 'incomplete'
      ? reason === 'content_filter' ? 'content_filter' : reason === 'max_output_tokens' ? 'max_tokens' : 'other'
      : refused ? 'refusal' : toolCalls > 0 ? 'tool_calls' : 'end_turn'
    return {
      responseId: parsed.id ?? null,
      parts,
      native: { wire: this.wire, dialectId: this.dialect.id, model: this.model, payload: parsed.output },
      stopReason,
      usage: responsesUsage(parsed.usage)
    }
  }

  createTurnStreamAccumulator(): LlmStreamAccumulator<LlmAssistantTurn> {
    return createResponsesTurnStreamAccumulator((value) => this.parseTurnResponse(value))
  }
}

interface PendingFunctionCall {
  item: Item
  arguments: string
}

/**
 * Collects finished output items from the stream. The terminal event's own
 * output wins when present; otherwise the collected items, and only as a last
 * resort items rebuilt from deltas.
 */
export function createResponsesTurnStreamAccumulator(
  parse: (value: unknown) => LlmAssistantTurn
): LlmStreamAccumulator<LlmAssistantTurn> {
  let responseId: string | null = null
  let result: LlmAssistantTurn | null = null
  let text = ''
  const doneItems = new Map<number, Item>()
  const pendingCalls = new Map<number, PendingFunctionCall>()
  return {
    accept(frame) {
      if (result !== null) return []
      const payload = jsonFrame(frame)
      if (payload === null) return [{ kind: 'transport', responseId, semantic: false }]
      const type = typeof payload.type === 'string' ? payload.type : ''
      const response = asItem(payload.response)
      if (typeof response?.id === 'string') responseId = response.id
      const index = typeof payload.output_index === 'number' ? payload.output_index : 0
      if (type === 'error' || type === 'response.failed') {
        throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商明确返回响应失败；本次没有执行任何工具。')
      }
      if (type === 'response.output_text.delta') {
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        text = addBounded(text, delta)
        return [{ kind: 'text', responseId, semantic: delta !== '' }]
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        return [{ kind: 'reasoning', responseId, semantic: true }]
      }
      if (type === 'response.output_item.added') {
        const item = asItem(payload.item)
        if (item?.type === 'function_call') {
          pendingCalls.set(index, { item, arguments: typeof item.arguments === 'string' ? item.arguments : '' })
          return [{ kind: 'tool_arguments', responseId, semantic: false }]
        }
        return [{ kind: 'transport', responseId, semantic: false }]
      }
      if (type === 'response.function_call_arguments.delta') {
        const pending = pendingCalls.get(index)
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        if (pending !== undefined) pending.arguments = addBounded(pending.arguments, delta)
        return [{ kind: 'tool_arguments', responseId, semantic: delta !== '' }]
      }
      if (type === 'response.output_item.done') {
        const item = asItem(payload.item)
        if (item !== null) doneItems.set(index, item)
        return [{ kind: item?.type === 'function_call' ? 'tool_arguments_complete' : 'transport', responseId, semantic: item?.type === 'function_call' }]
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        const terminalResponse = response ?? {}
        const reported = Array.isArray(terminalResponse.output) && terminalResponse.output.length > 0 ? terminalResponse.output : null
        const collected = [...doneItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
        const rebuilt: Item[] = [
          ...(text === '' ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]),
          ...[...pendingCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({ ...call.item, arguments: call.arguments }))
        ]
        result = parse({
          ...terminalResponse,
          id: responseId,
          status: terminalResponse.status ?? (type === 'response.completed' ? 'completed' : 'incomplete'),
          output: reported ?? (collected.length > 0 ? collected : rebuilt)
        })
        return [{ kind: 'terminal', responseId, semantic: true }]
      }
      return [{ kind: 'transport', responseId, semantic: false }]
    },
    finalize() {
      if (result === null) {
        throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '响应流结束，但没有收到 response.completed。')
      }
      return result
    }
  }
}
