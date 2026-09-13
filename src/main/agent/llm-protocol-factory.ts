import type { ProviderPublicConfig } from '../../shared/provider-settings'
import { ArkResponsesLlmProtocol, ResponsesLlmProtocol } from './ark-responses-protocol'
import { OpenAiCompatibleLlmProtocol, type LlmProtocolAdapter } from './llm-provider'

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
  return new ResponsesLlmProtocol({
    ...common,
    id: 'openai-responses-llm',
    label: 'Responses 兼容协议'
  })
}
