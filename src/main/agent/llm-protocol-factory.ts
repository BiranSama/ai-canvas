import type { ProviderPublicConfig } from '../../shared/provider-settings'
import { ArkResponsesLlmProtocol, ResponsesLlmProtocol } from './ark-responses-protocol'
import { OpenAiCompatibleLlmProtocol, type LlmProtocolAdapter } from './llm-provider'
import { AnthropicMessagesTurnProtocol } from './llm/anthropic-messages-turn'
import { ChatCompletionsTurnProtocol } from './llm/chat-completions-turn'
import { resolveLlmDialect } from './llm/dialects'
import { TurnProtocolLegacyAdapter } from './llm/legacy-adapter'
import { ResponsesTurnProtocol } from './llm/responses-turn'
import type { LlmTurnProtocol } from './llm/turn-protocol'

type LlmConfig = Extract<ProviderPublicConfig, { kind: 'llm' }>

/** Maps the owner's explicit protocol choice to one protocol adapter. */
export function createConfiguredLlmProtocol(config: LlmConfig): LlmProtocolAdapter {
  const common = {
    baseUrl: config.baseUrl,
    model: config.defaultModel,
    reasoningEffort: config.reasoningEffort,
    imageDetail: config.imageDetail,
    vision: config.capabilities.vision,
    streaming: config.capabilities.streaming
  }
  if (config.protocol === 'ark-responses') {
    return new ArkResponsesLlmProtocol(common)
  }
  if (config.protocol === 'openai-chat-completions') {
    return new OpenAiCompatibleLlmProtocol(common)
  }
  if (config.protocol === 'anthropic-messages') {
    return new TurnProtocolLegacyAdapter(createConfiguredTurnProtocol(config), {
      id: 'anthropic-messages-llm',
      label: 'Anthropic Messages 兼容协议'
    })
  }
  return new ResponsesLlmProtocol({
    ...common,
    id: 'openai-responses-llm',
    label: 'Responses 兼容协议'
  })
}

/** The multi-step access layer: one protocol adapter plus the vendor dialect matched from address and model. */
export function createConfiguredTurnProtocol(config: LlmConfig): LlmTurnProtocol {
  const { dialect } = resolveLlmDialect({ baseUrl: config.baseUrl, model: config.defaultModel })
  const common = {
    baseUrl: config.baseUrl,
    model: config.defaultModel,
    dialect,
    reasoningEffort: config.reasoningEffort,
    imageDetail: config.imageDetail,
    vision: config.capabilities.vision,
    streaming: config.capabilities.streaming
  }
  if (config.protocol === 'openai-chat-completions') return new ChatCompletionsTurnProtocol(common)
  if (config.protocol === 'anthropic-messages') return new AnthropicMessagesTurnProtocol(common)
  return new ResponsesTurnProtocol(common)
}
