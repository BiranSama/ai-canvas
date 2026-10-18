import { z } from 'zod'
import type { AgentItem } from '../../../shared/agent-harness'
import {
  llmAssistantPartSchema,
  llmNativeReplaySchema,
  llmToolResultSchema,
  turnToolCalls,
  type LlmAssistantPart,
  type LlmImage,
  type LlmNativeReplay,
  type LlmToolResult,
  type LlmTranscriptMessage,
  type LlmUsage
} from '../llm/transcript'

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable()
})

/**
 * What one planning pass of the multi-step engine adds to the turn, stored on
 * the plan item the loop writes for that pass. Replaying every trace of the
 * turn in order rebuilds the model transcript after a restart.
 */
export const modelTraceSchema = z.object({
  version: z.literal(1),
  promptVersion: z.string().min(1).max(64),
  /** Short references in force after this pass. */
  refs: z.record(z.string(), z.string()),
  /** Assistant steps the model produced during this pass, in order. */
  assistants: z.array(z.object({
    parts: z.array(llmAssistantPartSchema).max(256),
    native: llmNativeReplaySchema.nullable()
  })).max(16),
  /** Tool results that became known during this pass. Images are not stored. */
  results: z.array(llmToolResultSchema).max(64),
  /** The call this pass handed to the loop (a tool run or a question), if any. */
  emitted: z.object({ callId: z.string().min(1).max(256), name: z.string().min(1).max(128) }).nullable(),
  usage: z.array(usageSchema).max(16)
})

export type ModelTrace = z.infer<typeof modelTraceSchema>

interface StoredPlanPayload {
  readonly step?: { readonly trace?: unknown }
}

/** The trace of a plan item written by the multi-step engine, or null for any other item. */
export function traceOf(item: AgentItem): ModelTrace | null {
  if (item.type !== 'plan') return null
  const parsed = modelTraceSchema.safeParse((item.payload as StoredPlanPayload).step?.trace)
  return parsed.success ? parsed.data : null
}

const IMAGE_NOT_STORED = '[图片未保存在记录里]'

/** Results are stored without image bytes; the screenshots stay in memory only. */
export function storableResult(result: LlmToolResult): LlmToolResult {
  return {
    ...result,
    content: result.content.map((part) => part.type === 'image' ? { type: 'text' as const, text: IMAGE_NOT_STORED } : part)
  }
}

export interface AssistantStep {
  readonly parts: readonly LlmAssistantPart[]
  readonly native: LlmNativeReplay | null
}

/**
 * Rebuilds the transcript: the turn brief, then each assistant step followed by
 * the results of its calls. Images come back from the in-memory cache when
 * still there; a call without a result (an interrupted turn) is reported as
 * not executed so the transcript stays valid for every protocol.
 */
export function transcriptFrom(input: {
  readonly brief: LlmTranscriptMessage
  readonly assistants: readonly AssistantStep[]
  readonly results: ReadonlyMap<string, LlmToolResult>
  readonly images: ReadonlyMap<string, readonly LlmImage[]>
}): LlmTranscriptMessage[] {
  const messages: LlmTranscriptMessage[] = [input.brief]
  for (const assistant of input.assistants) {
    messages.push({ role: 'assistant', parts: [...assistant.parts], native: assistant.native })
    const calls = turnToolCalls(assistant)
    if (calls.length === 0) continue
    messages.push({
      role: 'tool',
      results: calls.map((call) => {
        const stored = input.results.get(call.callId)
        if (stored === undefined) {
          return { callId: call.callId, name: call.name, isError: true, content: [{ type: 'text' as const, text: '未执行：这一步在执行前被中断。' }] }
        }
        const images = input.images.get(call.callId)
        if (images === undefined || images.length === 0) return stored
        return {
          ...stored,
          content: [...stored.content.filter((part) => !(part.type === 'text' && part.text === IMAGE_NOT_STORED)), ...images.map((image) => ({ type: 'image' as const, image }))]
        }
      })
    })
  }
  return messages
}

export function sumUsage(entries: readonly LlmUsage[]): LlmUsage {
  return entries.reduce<LlmUsage>((total, entry) => ({
    inputTokens: total.inputTokens + entry.inputTokens,
    cachedInputTokens: total.cachedInputTokens + entry.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + entry.cacheWriteInputTokens,
    outputTokens: total.outputTokens + entry.outputTokens,
    reasoningTokens: total.reasoningTokens === null && entry.reasoningTokens === null ? null : (total.reasoningTokens ?? 0) + (entry.reasoningTokens ?? 0)
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: null })
}
