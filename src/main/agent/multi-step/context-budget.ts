import { turnToolCalls, type LlmToolDefinition, type LlmToolResult, type LlmTranscriptMessage } from '../llm/transcript'
import { MAX_STORED_BRIEF_CHARS, type AssistantStep } from './trace'

/**
 * Above this estimate the earlier steps of the turn are replaced by a
 * checkpoint. Every vendor in the dialect list offers at least 128K tokens;
 * staying well below keeps long turns cheap and the model's attention on the
 * recent steps.
 */
export const CHECKPOINT_TOKENS = 64_000
/** A checkpoint needs this many new steps since the last one, so a large brief alone cannot loop. */
export const MIN_STEPS_BETWEEN_CHECKPOINTS = 4
const MAX_LOGGED_CALLS = 40
/** Roughly what a 1024 px image costs as input across vendors. */
const IMAGE_TOKENS = 1_600
const WIDE = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/gu

export function estimateTextTokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0
  return Math.ceil(wide + (text.length - wide) / 3.5)
}

/**
 * An estimate of the input a request costs. Replay payloads are counted
 * instead of the parts they carry, since that is what goes on the wire.
 */
export function estimateRequestTokens(request: {
  readonly system: string
  readonly messages: readonly LlmTranscriptMessage[]
  readonly tools: readonly LlmToolDefinition[]
}): number {
  let total = estimateTextTokens(request.system) + estimateTextTokens(JSON.stringify(request.tools))
  for (const message of request.messages) {
    if (message.role === 'user') {
      for (const part of message.parts) total += part.type === 'image' ? IMAGE_TOKENS : estimateTextTokens(part.text)
    } else if (message.role === 'assistant') {
      total += message.native === null
        ? message.parts.reduce((sum, part) => sum + estimateTextTokens(part.type === 'tool_call' ? part.call.argumentsText : part.text), 0)
        : estimateTextTokens(JSON.stringify(message.native.payload))
    } else {
      for (const result of message.results) {
        for (const part of result.content) total += part.type === 'image' ? IMAGE_TOKENS : estimateTextTokens(part.text)
      }
    }
  }
  return total
}

function firstLine(result: LlmToolResult | undefined): string {
  const text = result?.content.find((part) => part.type === 'text')?.text ?? '没有结果'
  const line = text.split('\n', 1)[0]!
  return line.length <= 160 ? line : `${line.slice(0, 159)}…`
}

/**
 * The first message after a checkpoint: a fresh brief with the current canvas,
 * then one line per call made so far in the turn. No assistant step precedes
 * it, so it is valid whatever a vendor requires of replayed reasoning.
 */
export function checkpointText(input: {
  readonly brief: string
  readonly assistants: readonly AssistantStep[]
  readonly results: ReadonlyMap<string, LlmToolResult>
}): string {
  const calls = input.assistants.flatMap((assistant) => turnToolCalls(assistant))
  const logged = calls.slice(-MAX_LOGGED_CALLS)
  return [
    // With at most 40 short lines below, the text stays within what a trace stores.
    input.brief.slice(0, MAX_STORED_BRIEF_CHARS),
    '',
    `这一轮已经做了 ${calls.length} 步，较早的过程已压缩成下面的记录；画布以上面的描述为准${logged.length < calls.length ? `，只列出最近 ${logged.length} 步` : ''}：`,
    ...logged.map((call) => `- ${call.name}(${call.argumentsText.slice(0, 120)}${call.argumentsText.length > 120 ? '…' : ''}) → ${firstLine(input.results.get(call.callId))}`),
    '',
    '接着完成用户的要求；已经做完的不要重复。'
  ].join('\n')
}
