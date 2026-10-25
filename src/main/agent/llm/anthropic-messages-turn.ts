import { z } from 'zod'
import { resolveLlmProtocolEndpoint } from '../../../shared/provider-settings'
import { LlmProtocolError, type LlmProtocolRequest } from '../llm-provider'
import { addBounded, jsonFrame, type LlmStreamAccumulator } from '../llm-stream'
import { claudeUsesThinkingBudget, resolveThinkingEffort, type LlmDialect, type ThinkingEffort } from './dialects'
import {
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
  replayableNative,
  toolCallFromText,
  toolResultImages,
  toolResultText,
  type LlmTurnProtocol,
  type LlmTurnProtocolConfig
} from './turn-protocol'

export const ANTHROPIC_API_VERSION = '2023-06-01'

const THINKING_BUDGET: Readonly<Record<ThinkingEffort, number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768
}

const messageSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  type: z.literal('message').optional(),
  content: z.array(z.record(z.string(), z.unknown())).default([]),
  stop_reason: z.string().nullable().optional(),
  usage: z.unknown().optional()
}).passthrough()

type Block = Record<string, unknown>

export function anthropicUsage(value: unknown): LlmUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as Record<string, unknown>
  if (typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number') return null
  const cacheRead = finiteCount(usage.cache_read_input_tokens)
  const cacheWrite = finiteCount(usage.cache_creation_input_tokens)
  return {
    inputTokens: finiteCount(usage.input_tokens) + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: finiteCount(usage.output_tokens),
    reasoningTokens: null
  }
}

function stopReasonFor(value: string | null | undefined): LlmStopReason {
  if (value === 'tool_use') return 'tool_calls'
  if (value === 'end_turn' || value === 'stop_sequence' || value === null || value === undefined) return 'end_turn'
  if (value === 'max_tokens' || value === 'model_context_window_exceeded') return 'max_tokens'
  if (value === 'refusal') return 'refusal'
  return 'other'
}

function imageBlock(image: LlmImage): Block {
  return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } }
}

interface WireMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

/** Anthropic Messages, including Anthropic-compatible endpoints of other vendors. */
export class AnthropicMessagesTurnProtocol implements LlmTurnProtocol {
  readonly wire = 'anthropic-messages' as const
  readonly dialect: LlmDialect
  readonly model: string
  readonly capabilities: { readonly streaming: boolean; readonly vision: boolean }
  readonly #baseUrl: string
  readonly #effort: ThinkingEffort | null
  readonly #thinking: 'adaptive' | 'budget'

  constructor(config: LlmTurnProtocolConfig) {
    this.#baseUrl = llmTurnBaseUrlSchema.parse(config.baseUrl)
    this.model = llmTurnModelSchema.parse(config.model)
    this.dialect = config.dialect
    this.#effort = resolveThinkingEffort(config.reasoningEffort ?? 'auto', config.dialect.efforts)
    this.#thinking = config.dialect.anthropic.thinking === 'adaptive' && !claudeUsesThinkingBudget(this.model) ? 'adaptive' : 'budget'
    this.capabilities = { streaming: config.streaming ?? true, vision: config.vision ?? false }
    resolveLlmProtocolEndpoint(this.#baseUrl, 'anthropic-messages')
  }

  buildTurnRequest(inputValue: LlmTurnInput, stream: boolean): LlmProtocolRequest {
    const input = llmTurnInputSchema.parse(inputValue)
    const caching = this.dialect.anthropic.promptCaching
    const messages = this.#messages(input.messages)
    if (caching) markLastBlockForCache(messages)
    let maxTokens = input.maxOutputTokens
    let thinking: Block = { type: 'adaptive' }
    if (this.#thinking === 'budget') {
      // The budget has to stay below max_tokens and at least 1024.
      maxTokens = Math.max(maxTokens, 2_048)
      thinking = { type: 'enabled', budget_tokens: Math.max(1_024, Math.min(THINKING_BUDGET[this.#effort ?? 'medium'], maxTokens - 1_024)) }
    }
    return {
      url: resolveLlmProtocolEndpoint(this.#baseUrl, 'anthropic-messages'),
      authScheme: 'x-api-key',
      headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
      body: {
        model: this.model,
        max_tokens: maxTokens,
        stream,
        ...(input.system === '' ? {} : {
          system: caching ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }] : input.system
        }),
        messages,
        ...(input.tools.length === 0 ? {} : {
          tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
          tool_choice: { type: input.toolChoice }
        }),
        thinking,
        ...(this.#thinking === 'adaptive' && this.#effort !== null ? { output_config: { effort: this.#effort } } : {})
      }
    }
  }

  #messages(messages: readonly LlmTranscriptMessage[]): WireMessage[] {
    const target = { wire: this.wire, dialectId: this.dialect.id, model: this.model }
    const inlineImages = this.capabilities.vision && this.dialect.anthropic.toolResultImages === 'inline'
    const wire: WireMessage[] = []
    const push = (role: WireMessage['role'], content: Block[]): void => {
      if (content.length === 0) return
      const previous = wire.at(-1)
      // The API wants alternating roles; adjacent person messages are merged.
      if (previous !== undefined && previous.role === role && role === 'user') previous.content.push(...content)
      else wire.push({ role, content })
    }
    for (const message of messages) {
      if (message.role === 'user') {
        push('user', message.parts.map((part) => part.type === 'text'
          ? { type: 'text', text: part.text }
          : this.capabilities.vision ? imageBlock(part.image) : { type: 'text', text: IMAGE_WITHHELD_TEXT }))
      } else if (message.role === 'assistant') {
        const native = replayableNative(message.native, target)
        if (native !== null && Array.isArray(native.payload)) {
          push('assistant', native.payload.filter((block): block is Block => typeof block === 'object' && block !== null))
          continue
        }
        push('assistant', message.parts.flatMap((part): Block[] => {
          if (part.type === 'text') return part.text === '' ? [] : [{ type: 'text', text: part.text }]
          if (part.type === 'tool_call') {
            return [{ type: 'tool_use', id: part.call.callId, name: part.call.name, input: part.call.arguments ?? {} }]
          }
          return []
        }))
      } else {
        const followUp = !inlineImages && this.capabilities.vision
          ? message.results.filter((result) => toolResultImages(result).length > 0)
          : []
        push('user', [
          ...message.results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.callId,
            content: inlineImages
              ? result.content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : imageBlock(part.image))
              : [{ type: 'text', text: toolResultText(result, followUp.includes(result)) }],
            ...(result.isError ? { is_error: true } : {})
          })),
          // Tool results must open the message; their images may follow them.
          ...followUp.flatMap((result) => [
            { type: 'text', text: `工具 ${result.name} 的结果图片：` },
            ...toolResultImages(result).map(imageBlock)
          ])
        ])
      }
    }
    return wire
  }

  parseTurnResponse(value: unknown): LlmAssistantTurn {
    return this.#turnFromMessage(value, new Map())
  }

  #turnFromMessage(value: unknown, streamedArguments: ReadonlyMap<string, string>): LlmAssistantTurn {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    if (record.type === 'error') {
      throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商明确返回响应失败；本次没有执行任何工具。')
    }
    const parsed = messageSchema.parse(value)
    const parts: LlmAssistantPart[] = []
    for (const block of parsed.content) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
        parts.push({ type: 'reasoning', text: block.thinking })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const argumentsText = streamedArguments.get(block.id) ?? JSON.stringify(block.input ?? {})
        parts.push({ type: 'tool_call', call: toolCallFromText(block.id, block.name, argumentsText === '' ? '{}' : argumentsText) })
      }
    }
    return {
      responseId: parsed.id ?? null,
      parts,
      native: { wire: this.wire, dialectId: this.dialect.id, model: this.model, payload: parsed.content },
      stopReason: stopReasonFor(parsed.stop_reason),
      usage: anthropicUsage(parsed.usage)
    }
  }

  createTurnStreamAccumulator(): LlmStreamAccumulator<LlmAssistantTurn> {
    return createAnthropicTurnStreamAccumulator((message, streamedArguments) => this.#turnFromMessage(message, streamedArguments))
  }
}

/** Rolling cache breakpoint: everything up to the newest block is reused on the next step. */
function markLastBlockForCache(messages: WireMessage[]): void {
  const last = messages.at(-1)
  const block = last?.content.at(-1)
  if (last === undefined || block === undefined || last.role !== 'user') return
  last.content[last.content.length - 1] = { ...block, cache_control: { type: 'ephemeral' } }
}

/** Rebuilds the final message from Anthropic stream events, keeping thinking signatures intact. */
export function createAnthropicTurnStreamAccumulator(
  parse: (message: unknown, streamedArguments: ReadonlyMap<string, string>) => LlmAssistantTurn
): LlmStreamAccumulator<LlmAssistantTurn> {
  let message: Record<string, unknown> | null = null
  let usage: Record<string, unknown> = {}
  let stopReason: unknown = null
  let stopped = false
  const blocks = new Map<number, Block>()
  const partialJson = new Map<number, string>()
  return {
    accept(frame) {
      if (stopped) return []
      const payload = jsonFrame(frame)
      const responseId = typeof message?.id === 'string' ? message.id : null
      if (payload === null) return [{ kind: 'transport', responseId, semantic: false }]
      const index = typeof payload.index === 'number' ? payload.index : 0
      switch (payload.type) {
        case 'error':
          throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商在响应流中返回了失败；本次没有执行工具。')
        case 'message_start': {
          message = typeof payload.message === 'object' && payload.message !== null ? { ...payload.message as Record<string, unknown> } : {}
          usage = typeof message.usage === 'object' && message.usage !== null ? { ...message.usage as Record<string, unknown> } : {}
          return [{ kind: 'transport', responseId: typeof message.id === 'string' ? message.id : null, semantic: false }]
        }
        case 'content_block_start': {
          const block = typeof payload.content_block === 'object' && payload.content_block !== null
            ? { ...payload.content_block as Block }
            : { type: 'text', text: '' }
          blocks.set(index, block)
          if (block.type === 'tool_use') partialJson.set(index, '')
          return [{ kind: block.type === 'tool_use' ? 'tool_arguments' : 'transport', responseId, semantic: false }]
        }
        case 'content_block_delta': {
          const block = blocks.get(index)
          const delta = typeof payload.delta === 'object' && payload.delta !== null ? payload.delta as Record<string, unknown> : {}
          if (block === undefined) return [{ kind: 'transport', responseId, semantic: false }]
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = addBounded(typeof block.text === 'string' ? block.text : '', delta.text)
            return [{ kind: 'text', responseId, semantic: delta.text !== '' }]
          }
          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = addBounded(typeof block.thinking === 'string' ? block.thinking : '', delta.thinking)
            return [{ kind: 'reasoning', responseId, semantic: true }]
          }
          if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = (typeof block.signature === 'string' ? block.signature : '') + delta.signature
            return [{ kind: 'reasoning', responseId, semantic: false }]
          }
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            partialJson.set(index, addBounded(partialJson.get(index) ?? '', delta.partial_json))
            return [{ kind: 'tool_arguments', responseId, semantic: delta.partial_json !== '' }]
          }
          if (delta.type === 'citations_delta') {
            block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation]
          }
          return [{ kind: 'transport', responseId, semantic: false }]
        }
        case 'content_block_stop': {
          const block = blocks.get(index)
          if (block?.type !== 'tool_use') return [{ kind: 'transport', responseId, semantic: false }]
          const raw = partialJson.get(index) ?? ''
          try {
            block.input = raw.trim() === '' ? {} : JSON.parse(raw)
          } catch {
            block.input = {}
          }
          return [{ kind: 'tool_arguments_complete', responseId, semantic: true }]
        }
        case 'message_delta': {
          const delta = typeof payload.delta === 'object' && payload.delta !== null ? payload.delta as Record<string, unknown> : {}
          if (delta.stop_reason !== undefined) stopReason = delta.stop_reason
          if (typeof payload.usage === 'object' && payload.usage !== null) usage = { ...usage, ...payload.usage as Record<string, unknown> }
          return [{ kind: 'transport', responseId, semantic: false }]
        }
        case 'message_stop':
          stopped = true
          return [{ kind: 'terminal', responseId, semantic: true }]
        default:
          return [{ kind: 'transport', responseId, semantic: false }]
      }
    },
    finalize() {
      if (!stopped || message === null) {
        throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '响应流结束，但没有收到 message_stop。')
      }
      const ordered = [...blocks.entries()].sort(([left], [right]) => left - right)
      const streamedArguments = new Map<string, string>()
      for (const [index, block] of ordered) {
        if (block.type === 'tool_use' && typeof block.id === 'string') streamedArguments.set(block.id, partialJson.get(index) ?? '')
      }
      return parse({ ...message, content: ordered.map(([, block]) => block), stop_reason: stopReason, usage }, streamedArguments)
    }
  }
}
