import { z } from 'zod'
import type { NormalizedLlmResponse } from './llm-provider'
import { LlmProtocolError } from './llm-provider'

export const MAX_SSE_FRAME_BYTES = 1024 * 1024
export const MAX_LLM_RESPONSE_BYTES = 16 * 1024 * 1024
export const MAX_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024

export interface SseFrame {
  readonly event: string | null
  readonly data: string
  readonly id: string | null
  readonly commentOnly: boolean
}

export interface LlmStreamObservation {
  readonly kind: 'transport' | 'text' | 'tool_arguments' | 'tool_arguments_complete' | 'terminal'
  readonly responseId: string | null
  readonly semantic: boolean
}

export interface LlmStreamAccumulator {
  accept(frame: SseFrame): readonly LlmStreamObservation[]
  finalize(): NormalizedLlmResponse
}

/** Incremental UTF-8 SSE decoder. Network chunks may split any code point or line. */
export class SseDecoder {
  readonly #decoder = new TextDecoder()
  #buffer = ''

  push(chunk: Uint8Array): readonly SseFrame[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true })
    return this.#drain(false)
  }

  finish(): readonly SseFrame[] {
    this.#buffer += this.#decoder.decode()
    return this.#drain(true)
  }

  #drain(final: boolean): readonly SseFrame[] {
    const frames: SseFrame[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.#buffer)
      if (match === null) break
      const raw = this.#buffer.slice(0, match.index)
      this.#buffer = this.#buffer.slice(match.index + match[0].length)
      frames.push(parseSseFrame(raw))
    }
    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_SSE_FRAME_BYTES) {
      throw new LlmProtocolError('PROVIDER_RESPONSE_TOO_LARGE', '单个流式事件超过了 1 MiB 安全上限。')
    }
    if (final && this.#buffer.trim() !== '') {
      frames.push(parseSseFrame(this.#buffer))
      this.#buffer = ''
    }
    return frames
  }
}

function parseSseFrame(raw: string): SseFrame {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SSE_FRAME_BYTES) {
    throw new LlmProtocolError('PROVIDER_RESPONSE_TOO_LARGE', '单个流式事件超过了 1 MiB 安全上限。')
  }
  let event: string | null = null
  let id: string | null = null
  const data: string[] = []
  let comments = 0
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      comments += 1
      continue
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value.slice(0, 200)
    else if (field === 'id') id = value.slice(0, 500)
    else if (field === 'data') data.push(value)
  }
  return { event, id, data: data.join('\n'), commentOnly: data.length === 0 && comments > 0 }
}

function jsonFrame(frame: SseFrame): Record<string, unknown> | null {
  if (frame.data.trim() === '' || frame.commentOnly) return null
  try {
    const value = JSON.parse(frame.data)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new LlmProtocolError('PROVIDER_STREAM_MALFORMED', '供应商返回了无法解析的 SSE data 事件。')
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function addBounded(target: string, delta: string): string {
  if (Buffer.byteLength(target, 'utf8') + Buffer.byteLength(delta, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    throw new LlmProtocolError('PROVIDER_RESPONSE_TOO_LARGE', '单个工具参数超过了 4 MiB 安全上限。')
  }
  return target + delta
}

function replaceBounded(value: string): string {
  return addBounded('', value)
}

interface PendingTool {
  callId: string | null
  name: string | null
  arguments: string
}

export function createResponsesStreamAccumulator(
  parseResponse: (value: unknown) => NormalizedLlmResponse
): LlmStreamAccumulator {
  let responseId: string | null = null
  let text = ''
  let terminal = false
  let result: NormalizedLlmResponse | null = null
  const tools = new Map<number, PendingTool>()

  return {
    accept(frame) {
      if (terminal) return []
      const payload = jsonFrame(frame)
      if (payload === null) return [{ kind: 'transport', responseId, semantic: false }]
      const type = stringField(payload.type)
      if (typeof payload.response === 'object' && payload.response !== null) {
        responseId = stringField((payload.response as Record<string, unknown>).id) ?? responseId
      }
      responseId = stringField(payload.response_id) ?? responseId
      if (type === 'response.output_text.delta') {
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        text += delta
        return [{ kind: 'text', responseId, semantic: delta !== '' }]
      }
      if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
        return [{ kind: 'transport', responseId, semantic: false }]
      }
      if (type === 'response.output_item.added') {
        const item = typeof payload.item === 'object' && payload.item !== null ? payload.item as Record<string, unknown> : null
        const index = typeof payload.output_index === 'number' ? payload.output_index : 0
        if (item?.type === 'function_call') {
          const current = tools.get(index) ?? { callId: null, name: null, arguments: '' }
          current.callId = stringField(item.call_id) ?? current.callId
          current.name = stringField(item.name) ?? current.name
          if (typeof item.arguments === 'string') current.arguments = addBounded(current.arguments, item.arguments)
          tools.set(index, current)
          return [{ kind: 'tool_arguments', responseId, semantic: false }]
        }
        return [{ kind: 'transport', responseId, semantic: false }]
      }
      if (type === 'response.function_call_arguments.delta') {
        const index = typeof payload.output_index === 'number' ? payload.output_index : 0
        const current = tools.get(index) ?? { callId: null, name: null, arguments: '' }
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        current.arguments = addBounded(current.arguments, delta)
        tools.set(index, current)
        return [{ kind: 'tool_arguments', responseId, semantic: delta !== '' }]
      }
      if (type === 'response.function_call_arguments.done' || type === 'response.output_item.done') {
        const index = typeof payload.output_index === 'number' ? payload.output_index : 0
        const item = typeof payload.item === 'object' && payload.item !== null ? payload.item as Record<string, unknown> : null
        if (type === 'response.output_item.done' && item?.type !== 'function_call') {
          return [{ kind: 'transport', responseId, semantic: false }]
        }
        const current = tools.get(index) ?? { callId: null, name: null, arguments: '' }
        current.callId = stringField(payload.call_id) ?? stringField(item?.call_id) ?? current.callId
        current.name = stringField(payload.name) ?? stringField(item?.name) ?? current.name
        const completeArguments = typeof payload.arguments === 'string'
          ? payload.arguments
          : typeof item?.arguments === 'string'
            ? item.arguments
            : null
        if (completeArguments !== null) current.arguments = replaceBounded(completeArguments)
        tools.set(index, current)
        return [{ kind: 'tool_arguments_complete', responseId, semantic: true }]
      }
      if (type === 'response.failed') {
        terminal = true
        const response = typeof payload.response === 'object' && payload.response !== null ? payload.response as Record<string, unknown> : null
        responseId = stringField(response?.id) ?? responseId
        throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商明确返回响应失败；本次没有执行任何工具。')
      }
      if (type === 'response.incomplete') {
        terminal = true
        const response = typeof payload.response === 'object' && payload.response !== null
          ? payload.response as Record<string, unknown>
          : null
        const details = typeof response?.incomplete_details === 'object' && response.incomplete_details !== null
          ? response.incomplete_details as Record<string, unknown>
          : null
        if (stringField(details?.reason) === 'content_filter') {
          throw new LlmProtocolError('MODEL_OUTPUT_FILTERED', '供应商因内容策略停止了本次响应；本次没有执行任何工具。')
        }
        throw new LlmProtocolError('PROVIDER_RESPONSE_TRUNCATED', '供应商响应未完整结束；本次没有执行任何工具。')
      }
      if (type === 'response.completed') {
        terminal = true
        const response = typeof payload.response === 'object' && payload.response !== null
          ? payload.response as Record<string, unknown>
          : {}
        responseId = stringField(response.id) ?? responseId
        const hasOutput = Array.isArray(response.output)
        const synthesizedOutput: unknown[] = []
        if (text !== '') synthesizedOutput.push({ type: 'message', content: [{ type: 'output_text', text }] })
        for (const [, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
          if (tool.callId === null || tool.name === null) {
            throw new LlmProtocolError('PROVIDER_TOOL_ARGUMENTS_INCOMPLETE', '响应完成时工具身份仍不完整。')
          }
          synthesizedOutput.push({ type: 'function_call', call_id: tool.callId, name: tool.name, arguments: tool.arguments })
        }
        result = parseResponse({
          ...response,
          id: responseId ?? 'response-stream',
          status: response.status ?? 'completed',
          output: hasOutput ? response.output : synthesizedOutput
        })
        return [{ kind: 'terminal', responseId: result.id, semantic: true }]
      }
      return [{ kind: 'transport', responseId, semantic: false }]
    },
    finalize() {
      if (!terminal || result === null) {
        throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '响应流结束，但没有收到 response.completed。')
      }
      return result
    }
  }
}

const chatChunkSchema = z.object({
  id: z.string().min(1),
  choices: z.array(z.object({
    index: z.number().int().nonnegative().default(0),
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional()
      })).optional()
    })
  }))
})

export function createChatStreamAccumulator(
  parseResponse: (value: unknown) => NormalizedLlmResponse
): LlmStreamAccumulator {
  let responseId: string | null = null
  let done = false
  const choices = new Map<number, { text: string; finishReason: string | null; tools: Map<number, PendingTool> }>()
  return {
    accept(frame) {
      if (done) return []
      if (frame.data.trim() === '[DONE]') {
        done = true
        return [{ kind: 'terminal', responseId, semantic: true }]
      }
      const payload = jsonFrame(frame)
      if (payload === null) return [{ kind: 'transport', responseId, semantic: false }]
      if (!('choices' in payload)) {
        if ('error' in payload) throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商在响应流中返回了失败；本次没有执行工具。')
        return [{ kind: 'transport', responseId, semantic: false }]
      }
      const parsed = chatChunkSchema.safeParse(payload)
      if (!parsed.success) throw new LlmProtocolError('PROVIDER_STREAM_MALFORMED', '供应商返回了不符合 Chat Completions 的流式事件。')
      responseId = parsed.data.id
      let semantic = false
      let hasToolDelta = false
      let hasCompletedArguments = false
      for (const choice of parsed.data.choices) {
        const currentChoice = choices.get(choice.index) ?? { text: '', finishReason: null, tools: new Map<number, PendingTool>() }
        if (typeof choice.delta.content === 'string') {
          currentChoice.text += choice.delta.content
          semantic ||= choice.delta.content !== ''
        }
        for (const call of choice.delta.tool_calls ?? []) {
          hasToolDelta = true
          const current = currentChoice.tools.get(call.index) ?? { callId: null, name: null, arguments: '' }
          current.callId = call.id ?? current.callId
          if (call.function?.name !== undefined) current.name = addBounded(current.name ?? '', call.function.name)
          const delta = call.function?.arguments ?? ''
          current.arguments = addBounded(current.arguments, delta)
          currentChoice.tools.set(call.index, current)
          semantic ||= delta !== '' || current.callId !== null || current.name !== null
        }
        if (choice.finish_reason !== undefined) {
          currentChoice.finishReason = choice.finish_reason
          hasCompletedArguments ||= currentChoice.tools.size > 0 && choice.finish_reason !== null
        }
        choices.set(choice.index, currentChoice)
      }
      return [{
        kind: hasCompletedArguments ? 'tool_arguments_complete' : hasToolDelta ? 'tool_arguments' : 'text',
        responseId,
        semantic
      }]
    },
    finalize() {
      if (!done) throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '响应流结束，但没有收到 [DONE]。')
      const normalizedChoices = [...choices.entries()].sort(([left], [right]) => left - right).map(([, choice]) => {
        const toolCalls = [...choice.tools.entries()].sort(([left], [right]) => left - right).map(([, tool]) => {
          if (tool.callId === null || tool.name === null) {
            throw new LlmProtocolError('PROVIDER_TOOL_ARGUMENTS_INCOMPLETE', '响应结束时工具身份仍不完整。')
          }
          return { id: tool.callId, type: 'function', function: { name: tool.name, arguments: tool.arguments } }
        })
        return {
          finish_reason: choice.finishReason,
          message: { content: choice.text === '' ? null : choice.text, tool_calls: toolCalls }
        }
      })
      return parseResponse({
        id: responseId ?? 'chat-stream',
        choices: normalizedChoices.length === 0
          ? [{ finish_reason: null, message: { content: null, tool_calls: [] } }]
          : normalizedChoices
      })
    }
  }
}
