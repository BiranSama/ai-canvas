import {
  LlmProtocolError,
  openAiCompatibleRequestSchema,
  type LlmProtocolAdapter,
  type LlmProtocolRequest,
  type NormalizedLlmResponse,
  type OpenAiCompatibleRequest
} from '../llm-provider'
import type { LlmStreamAccumulator } from '../llm-stream'
import { turnText, turnToolCalls, type LlmAssistantTurn, type LlmTranscriptMessage } from './transcript'
import type { LlmTurnProtocol } from './turn-protocol'

function legacyResponse(turn: LlmAssistantTurn): NormalizedLlmResponse {
  if (turn.stopReason === 'content_filter') {
    throw new LlmProtocolError('MODEL_OUTPUT_FILTERED', '供应商因内容策略停止了本次响应；本次没有执行任何工具。')
  }
  if (turn.stopReason === 'max_tokens') {
    throw new LlmProtocolError('PROVIDER_RESPONSE_TRUNCATED', '模型响应达到输出上限，工具参数可能不完整；请提高输出预算或降低思考强度。')
  }
  return {
    id: turn.responseId ?? 'response',
    text: turnText(turn),
    toolCalls: turnToolCalls(turn).map((call) => {
      if (call.arguments === null) {
        throw call.argumentsError === 'incomplete'
          ? new LlmProtocolError('PROVIDER_RESPONSE_TRUNCATED', '模型返回的操作参数没有完整结束；本次没有修改画布。请降低单次操作复杂度，或提高模型输出预算后重试。')
          : call.argumentsError === 'too_large'
            ? new LlmProtocolError('PROVIDER_RESPONSE_TOO_LARGE', '工具参数超过 4 MiB 安全上限；本次没有执行工具。')
            : new LlmProtocolError('MODEL_ARGUMENTS_INVALID', '模型返回的操作参数不是有效 JSON；本次没有修改画布。应用没有猜测或修补不确定的命令。')
      }
      return { id: call.callId, name: call.name, arguments: call.arguments }
    }),
    finishReason: turn.stopReason
  }
}

/**
 * Serves the plan-once planner and the connection check through a turn
 * protocol, for protocols that only exist in the new access layer.
 */
export class TurnProtocolLegacyAdapter implements LlmProtocolAdapter {
  readonly id: string
  readonly label: string
  readonly capabilities: { readonly streaming: boolean; readonly toolCalling: true; readonly vision: boolean }
  readonly #turn: LlmTurnProtocol

  constructor(turn: LlmTurnProtocol, meta: { readonly id: string; readonly label: string }) {
    this.#turn = turn
    this.id = meta.id
    this.label = meta.label
    this.capabilities = { streaming: turn.capabilities.streaming, toolCalling: true, vision: turn.capabilities.vision }
  }

  buildRequest(inputValue: OpenAiCompatibleRequest, stream: boolean): LlmProtocolRequest {
    const input = openAiCompatibleRequestSchema.parse(inputValue)
    const conversation = input.messages.filter((message) => message.role !== 'system')
    const lastUser = conversation.map((message) => message.role).lastIndexOf('user')
    const messages = conversation.map((message, index): LlmTranscriptMessage => message.role === 'assistant'
      ? { role: 'assistant', parts: [{ type: 'text', text: message.content }], native: null }
      : {
          role: 'user',
          parts: [
            { type: 'text', text: message.content },
            ...(index === lastUser ? (input.images ?? []).map((image) => ({ type: 'image' as const, image })) : [])
          ]
        })
    return this.#turn.buildTurnRequest({
      system: input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n'),
      messages,
      tools: input.tools,
      // Thinking is always on, and thinking models reject a forced tool choice.
      toolChoice: 'auto',
      maxOutputTokens: input.maxOutputTokens ?? 4_096
    }, stream)
  }

  parseResponse(value: unknown): NormalizedLlmResponse {
    return legacyResponse(this.#turn.parseTurnResponse(value))
  }

  createStreamAccumulator(): LlmStreamAccumulator {
    const inner = this.#turn.createTurnStreamAccumulator()
    return {
      accept: (frame) => inner.accept(frame),
      finalize: () => legacyResponse(inner.finalize())
    }
  }
}
