import { z } from 'zod'

/**
 * Wire formats the access layer speaks. Ark Responses and OpenAI Responses share
 * one wire format and differ only in their dialect.
 */
export const llmWireProtocolSchema = z.enum(['chat-completions', 'responses', 'anthropic-messages'])
export type LlmWireProtocol = z.infer<typeof llmWireProtocolSchema>

const base64Schema = z.string().min(1).max(40 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+=*$/)

export const llmImageSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  base64: base64Schema
}).strict()
export type LlmImage = z.infer<typeof llmImageSchema>

const textPartSchema = z.object({ type: z.literal('text'), text: z.string().max(200_000) }).strict()
const imagePartSchema = z.object({ type: z.literal('image'), image: llmImageSchema }).strict()

export const llmToolCallSchema = z.object({
  callId: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  /** The arguments exactly as the model wrote them. */
  argumentsText: z.string().max(4 * 1024 * 1024),
  /** Parsed arguments, or null when the model wrote something that is not a JSON object. */
  arguments: z.record(z.string(), z.unknown()).nullable(),
  argumentsError: z.enum(['empty', 'incomplete', 'invalid', 'too_large']).nullable()
}).strict()
export type LlmToolCall = z.infer<typeof llmToolCallSchema>

export const llmAssistantPartSchema = z.discriminatedUnion('type', [
  /** Readable thinking for display and diagnostics. It is never sent back on its own. */
  z.object({ type: z.literal('reasoning'), text: z.string().max(400_000) }).strict(),
  textPartSchema,
  z.object({ type: z.literal('tool_call'), call: llmToolCallSchema }).strict()
])
export type LlmAssistantPart = z.infer<typeof llmAssistantPartSchema>

/**
 * The provider's own output for one assistant step, kept byte for byte so it can
 * be sent back: reasoning signatures and encrypted reasoning are rejected when
 * altered. Responses keeps the output items, Anthropic the content blocks and
 * Chat Completions the assistant message.
 */
export const llmNativeReplaySchema = z.object({
  wire: llmWireProtocolSchema,
  dialectId: z.string().min(1).max(64),
  model: z.string().min(1).max(160),
  payload: z.unknown()
}).strict()
export type LlmNativeReplay = z.infer<typeof llmNativeReplaySchema>

export const llmToolResultSchema = z.object({
  callId: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  content: z.array(z.discriminatedUnion('type', [textPartSchema, imagePartSchema])).min(1).max(16),
  isError: z.boolean()
}).strict()
export type LlmToolResult = z.infer<typeof llmToolResultSchema>

export const llmTranscriptMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    parts: z.array(z.discriminatedUnion('type', [textPartSchema, imagePartSchema])).min(1).max(32)
  }).strict(),
  z.object({
    role: z.literal('assistant'),
    parts: z.array(llmAssistantPartSchema).max(256),
    native: llmNativeReplaySchema.nullable()
  }).strict(),
  z.object({
    role: z.literal('tool'),
    results: z.array(llmToolResultSchema).min(1).max(64)
  }).strict()
])
export type LlmTranscriptMessage = z.infer<typeof llmTranscriptMessageSchema>

export const llmToolDefinitionSchema = z.object({
  // The strictest provider rule (Anthropic) applies to every protocol.
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().max(4_096),
  parameters: z.record(z.string(), z.unknown())
}).strict()
export type LlmToolDefinition = z.infer<typeof llmToolDefinitionSchema>

export const llmTurnInputSchema = z.object({
  system: z.string().max(200_000),
  messages: z.array(llmTranscriptMessageSchema).min(1).max(512),
  tools: z.array(llmToolDefinitionSchema).max(64),
  /** Forcing a specific tool is rejected by most providers while thinking. */
  toolChoice: z.enum(['auto', 'none']).default('auto'),
  maxOutputTokens: z.number().int().min(256).max(131_072),
  /** Names a conversation whose requests share a prefix, for providers that route caching by it. */
  cacheKey: z.string().min(1).max(64).optional()
}).strict()
export type LlmTurnInput = z.input<typeof llmTurnInputSchema>
export type ParsedLlmTurnInput = z.output<typeof llmTurnInputSchema>

export interface LlmUsage {
  /** All input tokens, cached ones included. */
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteInputTokens: number
  /** All output tokens, reasoning included. */
  readonly outputTokens: number
  /** Null when the provider does not report reasoning tokens separately. */
  readonly reasoningTokens: number | null
}

export type LlmStopReason = 'tool_calls' | 'end_turn' | 'max_tokens' | 'content_filter' | 'refusal' | 'other'

export interface LlmAssistantTurn {
  readonly responseId: string | null
  readonly parts: readonly LlmAssistantPart[]
  readonly native: LlmNativeReplay
  readonly stopReason: LlmStopReason
  readonly usage: LlmUsage | null
}

export function turnText(turn: Pick<LlmAssistantTurn, 'parts'>): string {
  return turn.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
}

export function turnToolCalls(turn: Pick<LlmAssistantTurn, 'parts'>): readonly LlmToolCall[] {
  return turn.parts.flatMap((part) => part.type === 'tool_call' ? [part.call] : [])
}

export function imageDataUri(image: LlmImage): string {
  return `data:${image.mimeType};base64,${image.base64}`
}
