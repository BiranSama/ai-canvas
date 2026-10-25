import { z } from 'zod'
import type { LlmImageDetail, LlmReasoningEffort } from '../../../shared/provider-settings'
import type { LlmProtocolRequest } from '../llm-provider'
import type { LlmStreamAccumulator } from '../llm-stream'
import { parseModelToolArguments, ToolArgumentsParseError } from '../tool-arguments'
import type { LlmDialect } from './dialects'
import type {
  LlmAssistantTurn,
  LlmImage,
  LlmNativeReplay,
  LlmToolCall,
  LlmToolResult,
  LlmTranscriptMessage,
  LlmTurnInput,
  LlmWireProtocol
} from './transcript'

const MAX_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024

export const llmTurnBaseUrlSchema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
}, 'LLM base URL must be HTTP(S) and cannot contain credentials.')

export const llmTurnModelSchema = z.string().trim().min(1).max(160)

/**
 * One model step in the multi-step agent loop: the whole transcript goes out,
 * one assistant step comes back with its native output kept for replay.
 */
export interface LlmTurnProtocol {
  readonly wire: LlmWireProtocol
  readonly dialect: LlmDialect
  readonly model: string
  readonly capabilities: { readonly streaming: boolean; readonly vision: boolean }
  buildTurnRequest(input: LlmTurnInput, stream: boolean): LlmProtocolRequest
  parseTurnResponse(value: unknown): LlmAssistantTurn
  createTurnStreamAccumulator(): LlmStreamAccumulator<LlmAssistantTurn>
}

export interface LlmTurnProtocolConfig {
  readonly baseUrl: string
  readonly model: string
  readonly dialect: LlmDialect
  readonly reasoningEffort?: LlmReasoningEffort
  readonly imageDetail?: LlmImageDetail
  readonly vision?: boolean
  readonly streaming?: boolean
}

/** Keeps malformed arguments as data so the loop can hand the error back to the model. */
export function toolCallFromText(callId: string, name: string, argumentsText: string): LlmToolCall {
  if (Buffer.byteLength(argumentsText, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    return { callId, name, argumentsText: '', arguments: null, argumentsError: 'too_large' }
  }
  try {
    return { callId, name, argumentsText, arguments: { ...parseModelToolArguments(argumentsText) }, argumentsError: null }
  } catch (error) {
    return {
      callId,
      name,
      argumentsText,
      arguments: null,
      argumentsError: error instanceof ToolArgumentsParseError ? error.failure : 'invalid'
    }
  }
}

/**
 * A step's native output is replayed only to the protocol, vendor and model that
 * produced it; signatures and encrypted reasoning are not portable.
 */
export function replayableNative(
  native: LlmNativeReplay | null,
  target: { readonly wire: LlmWireProtocol; readonly dialectId: string; readonly model: string }
): LlmNativeReplay | null {
  if (native === null) return null
  return native.wire === target.wire && native.dialectId === target.dialectId && native.model === target.model
    ? native
    : null
}

/** Index of the last person-written message; steps after it form the current tool loop. */
export function currentLoopStart(messages: readonly LlmTranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return 0
}

export const IMAGE_WITHHELD_TEXT = '[图片未发送：当前文字模型未开启看图]'

export function toolResultText(result: LlmToolResult, imagesFollow: boolean): string {
  const text = result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
  const imageCount = result.content.filter((part) => part.type === 'image').length
  if (imageCount === 0) return text
  const note = imagesFollow ? `[附带 ${imageCount} 张图片，见下一条消息]` : IMAGE_WITHHELD_TEXT
  return text === '' ? note : `${text}\n${note}`
}

export function toolResultImages(result: LlmToolResult): readonly LlmImage[] {
  return result.content.flatMap((part) => part.type === 'image' ? [part.image] : [])
}

export function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

export function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

export function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'object' && field !== null && !Array.isArray(field) ? field as Record<string, unknown> : null
}
