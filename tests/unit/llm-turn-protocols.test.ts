import { describe, expect, it, vi } from 'vitest'
import { AnthropicMessagesTurnProtocol } from '../../src/main/agent/llm/anthropic-messages-turn'
import { ChatCompletionsTurnProtocol } from '../../src/main/agent/llm/chat-completions-turn'
import {
  GENERIC_DIALECT,
  claudeUsesThinkingBudget,
  resolveLlmDialect,
  resolveThinkingEffort,
  type LlmDialect
} from '../../src/main/agent/llm/dialects'
import { ResponsesTurnProtocol } from '../../src/main/agent/llm/responses-turn'
import type { LlmTranscriptMessage, LlmTurnInput } from '../../src/main/agent/llm/transcript'
import type { LlmTurnProtocol } from '../../src/main/agent/llm/turn-protocol'
import { createConfiguredLlmProtocol, createConfiguredTurnProtocol } from '../../src/main/agent/llm-protocol-factory'
import type { LlmStreamAccumulator } from '../../src/main/agent/llm-stream'
import { ArkHttpClient } from '../../src/main/security/ark-http-client'
import { DEFAULT_PROVIDER_CONFIG, resolveLlmProtocolEndpoint, type ProviderPublicConfig } from '../../src/shared/provider-settings'

const PNG = { mimeType: 'image/png' as const, base64: 'iVBORw0KGgo=' }
const TOOL = {
  name: 'add_text',
  description: '添加文字',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

function dialect(id: string): LlmDialect {
  const hosts: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    deepseek: 'https://api.deepseek.com',
    ark: 'https://ark.cn-beijing.volces.com/api/v3',
    xai: 'https://api.x.ai/v1'
  }
  return resolveLlmDialect({ baseUrl: hosts[id]!, model: 'any' }).dialect
}

function turnInput(messages: LlmTranscriptMessage[], extra: Partial<LlmTurnInput> = {}): LlmTurnInput {
  return { system: '你是设计搭档。', messages, tools: [TOOL], maxOutputTokens: 8_000, ...extra }
}

function sse(events: readonly unknown[]): { event: null; id: null; data: string; commentOnly: false }[] {
  return events.map((event) => ({ event: null, id: null, data: typeof event === 'string' ? event : JSON.stringify(event), commentOnly: false }))
}

function drain<T>(accumulator: LlmStreamAccumulator<T>, events: readonly unknown[]): T {
  for (const frame of sse(events)) accumulator.accept(frame)
  return accumulator.finalize()
}

/** A finished step, followed by the tool result the loop sends back. */
function stepThenResult(protocol: LlmTurnProtocol, response: unknown, callId: string): LlmTranscriptMessage[] {
  const turn = protocol.parseTurnResponse(response)
  return [
    { role: 'user', parts: [{ type: 'text', text: '加一个标题' }] },
    { role: 'assistant', parts: [...turn.parts], native: turn.native },
    {
      role: 'tool',
      results: [{ callId, name: 'add_text', isError: false, content: [{ type: 'text', text: '已添加标题 E3' }, { type: 'image', image: PNG }] }]
    }
  ]
}

describe('vendor dialects', () => {
  it('matches the vendor by address first, then by model name, else the generic dialect', () => {
    expect(resolveLlmDialect({ baseUrl: 'https://api.deepseek.com', model: 'gpt-5' })).toMatchObject({ dialect: { id: 'deepseek' }, matchedBy: 'host' })
    expect(resolveLlmDialect({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'x' }).dialect.id).toBe('ark')
    expect(resolveLlmDialect({ baseUrl: 'https://relay.example.test/v1', model: 'claude-sonnet-5-5' })).toMatchObject({ dialect: { id: 'anthropic' }, matchedBy: 'model' })
    expect(resolveLlmDialect({ baseUrl: 'https://relay.example.test/v1', model: 'house-model' })).toMatchObject({ dialect: { id: 'generic' }, matchedBy: 'default' })
  })

  it('keeps thinking on: auto sends no effort, none asks for the lightest level offered', () => {
    expect(resolveThinkingEffort('auto', ['low', 'medium', 'high'])).toBeNull()
    expect(resolveThinkingEffort('none', ['low', 'medium', 'high'])).toBe('low')
    expect(resolveThinkingEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(resolveThinkingEffort('max', ['low', 'medium', 'high', 'max'])).toBe('max')
    expect(resolveThinkingEffort('high', [])).toBeNull()
  })

  it('uses a fixed thinking budget only for Claude models before 4.6', () => {
    expect(claudeUsesThinkingBudget('claude-3-7-sonnet-20250219')).toBe(true)
    expect(claudeUsesThinkingBudget('claude-sonnet-4-20250514')).toBe(true)
    expect(claudeUsesThinkingBudget('claude-sonnet-4-5-20250929')).toBe(true)
    expect(claudeUsesThinkingBudget('claude-haiku-4-5')).toBe(true)
    expect(claudeUsesThinkingBudget('claude-opus-4-6')).toBe(false)
    expect(claudeUsesThinkingBudget('claude-opus-5-5')).toBe(false)
  })
})

describe('Chat Completions turns', () => {
  const deepseek = () => new ChatCompletionsTurnProtocol({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash', dialect: dialect('deepseek'), vision: true })
  const deepseekResponse = {
    id: 'chat-1',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: '标题应放在上三分之一。',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_text', arguments: '{"text":"晨雾"}' } }]
      }
    }],
    usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_cache_hit_tokens: 1000, completion_tokens_details: { reasoning_tokens: 50 } }
  }

  it('switches thinking on and never sends parameters thinking mode rejects', () => {
    const request = deepseek().buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: '做一张海报' }] }]), true)
    expect(request.url).toBe('https://api.deepseek.com/chat/completions')
    expect(request.body).toMatchObject({
      model: 'deepseek-v4.1-flash',
      thinking: { type: 'enabled' },
      tool_choice: 'auto',
      max_tokens: 8_000,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: '你是设计搭档。' }, { role: 'user', content: '做一张海报' }]
    })
    expect(request.body).not.toHaveProperty('temperature')
    expect(request.body).not.toHaveProperty('reasoning_effort')
  })

  it('parses reasoning, tool calls and usage, keeping the assistant message for replay', () => {
    const turn = deepseek().parseTurnResponse(deepseekResponse)
    expect(turn.parts).toEqual([
      { type: 'reasoning', text: '标题应放在上三分之一。' },
      { type: 'tool_call', call: { callId: 'call-1', name: 'add_text', argumentsText: '{"text":"晨雾"}', arguments: { text: '晨雾' }, argumentsError: null } }
    ])
    expect(turn.stopReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 80, reasoningTokens: 50 })
    expect(turn.native.payload).toMatchObject({ reasoning_content: '标题应放在上三分之一。', tool_calls: [{ id: 'call-1' }] })
  })

  it('replays reasoning_content in the current tool loop and sends tool images in a following user message', () => {
    const protocol = deepseek()
    const body = protocol.buildTurnRequest(turnInput(stepThenResult(protocol, deepseekResponse, 'call-1')), false).body
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: '标题应放在上三分之一。',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_text', arguments: '{"text":"晨雾"}' } }]
    })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '已添加标题 E3\n[附带 1 张图片，见下一条消息]' })
    expect(messages[4]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '工具 add_text 的结果图片：' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }]
    })
  })

  it('drops reasoning from earlier person turns and does not replay output from another model', () => {
    const protocol = deepseek()
    const turn = protocol.parseTurnResponse(deepseekResponse)
    const earlier: LlmTranscriptMessage[] = [
      ...stepThenResult(protocol, deepseekResponse, 'call-1'),
      { role: 'assistant', parts: [{ type: 'text', text: '好了' }], native: null },
      { role: 'user', parts: [{ type: 'text', text: '再大一点' }] }
    ]
    const messages = protocol.buildTurnRequest(turnInput(earlier), false).body.messages as Record<string, unknown>[]
    expect(messages[2]).not.toHaveProperty('reasoning_content')
    expect(messages[2]).toHaveProperty('tool_calls')

    const other = new ChatCompletionsTurnProtocol({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4.1-pro', dialect: dialect('deepseek') })
    const rebuilt = other.buildTurnRequest(turnInput([
      { role: 'user', parts: [{ type: 'text', text: '加标题' }] },
      { role: 'assistant', parts: [...turn.parts], native: turn.native }
    ]), false).body.messages as Record<string, unknown>[]
    expect(rebuilt[2]).toEqual({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add_text', arguments: '{"text":"晨雾"}' } }]
    })
  })

  it('keeps malformed arguments as data for the loop to hand back', () => {
    const turn = deepseek().parseTurnResponse({
      id: 'bad', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c', function: { name: 'add_text', arguments: '{"text": "晨' } }] } }]
    })
    expect(turn.parts[0]).toMatchObject({ type: 'tool_call', call: { arguments: null, argumentsError: 'incomplete' } })
  })

  it('rebuilds the same turn from a stream, including Gemini thought signatures on tool calls', () => {
    const gemini = new ChatCompletionsTurnProtocol({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3-pro', dialect: resolveLlmDialect({ baseUrl: 'https://generativelanguage.googleapis.com', model: 'x' }).dialect
    })
    const turn = drain(gemini.createTurnStreamAccumulator(), [
      { id: 'g1', choices: [{ index: 0, delta: { reasoning_content: '先看' } }] },
      { id: 'g1', choices: [{ index: 0, delta: { reasoning_content: '画布' } }] },
      { id: 'g1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-9', type: 'function', function: { name: 'add_text', arguments: '{"te' }, extra_content: { google: { thought_signature: 'sig-abc' } } }] } }] },
      { id: 'g1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"晨雾"}' } }] } }] },
      { id: 'g1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { id: 'g1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      '[DONE]'
    ])
    expect(turn.parts).toEqual([
      { type: 'reasoning', text: '先看画布' },
      { type: 'tool_call', call: { callId: 'call-9', name: 'add_text', argumentsText: '{"text":"晨雾"}', arguments: { text: '晨雾' }, argumentsError: null } }
    ])
    expect(turn.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(turn.native.payload).toMatchObject({
      tool_calls: [{ id: 'call-9', extra_content: { google: { thought_signature: 'sig-abc' } } }]
    })
  })

  it('uses max_completion_tokens and the chosen effort for OpenAI', () => {
    const openai = new ChatCompletionsTurnProtocol({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', dialect: dialect('openai'), reasoningEffort: 'high' })
    const body = openai.buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]), false).body
    expect(body).toMatchObject({ max_completion_tokens: 8_000, reasoning_effort: 'high' })
    expect(body).not.toHaveProperty('max_tokens')
  })
})

describe('Responses turns', () => {
  const openai = () => new ResponsesTurnProtocol({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', dialect: dialect('openai'), reasoningEffort: 'medium', vision: true })
  const openaiOutput = [
    { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '需要一个标题。' }], encrypted_content: 'gAAAA-encrypted' },
    { id: 'msg_1', type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '我先加标题。' }] },
    { id: 'fc_1', type: 'function_call', call_id: 'call-1', name: 'add_text', arguments: '{"text":"晨雾"}', status: 'completed' }
  ]
  const openaiResponse = {
    id: 'resp-1', status: 'completed', output: openaiOutput,
    usage: { input_tokens: 900, output_tokens: 120, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 90 } }
  }

  it('requests encrypted reasoning without server-side storage and sends no temperature', () => {
    const request = openai().buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: '做海报' }] }]), true)
    expect(request.url).toBe('https://api.openai.com/v1/responses')
    expect(request.body).toMatchObject({
      store: false,
      instructions: '你是设计搭档。',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
      tool_choice: 'auto',
      max_output_tokens: 8_000,
      tools: [{ type: 'function', name: 'add_text' }]
    })
    expect(request.body).not.toHaveProperty('temperature')
  })

  it('switches Ark thinking on with its own field', () => {
    const ark = new ResponsesTurnProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-turbo-260628', dialect: dialect('ark') })
    const body = ark.buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]), false).body
    expect(body).toMatchObject({ thinking: { type: 'enabled' } })
    expect(body).not.toHaveProperty('include')
    expect(body).not.toHaveProperty('reasoning')
  })

  it('replays output items byte for byte and puts tool images inside the result where supported', () => {
    const protocol = openai()
    const input = protocol.buildTurnRequest(turnInput(stepThenResult(protocol, openaiResponse, 'call-1')), false).body.input as unknown[]
    expect(input.slice(1, 4)).toEqual(openaiOutput)
    expect(input[4]).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: [{ type: 'input_text', text: '已添加标题 E3' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }]
    })
  })

  it('sends tool images in a following user message where results take text only', () => {
    const ark = new ResponsesTurnProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-turbo-260628', dialect: dialect('ark'), vision: true })
    const input = ark.buildTurnRequest(turnInput(stepThenResult(ark, openaiResponse, 'call-1')), false).body.input as Record<string, unknown>[]
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call-1', output: '已添加标题 E3\n[附带 1 张图片，见下一条消息]' })
    expect(input[5]).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text' }, { type: 'input_image' }] })
  })

  it('drops unreplayable reasoning and the item IDs that point at it', () => {
    const relay = new ResponsesTurnProtocol({ baseUrl: 'https://relay.example.test/v1', model: 'house-model', dialect: GENERIC_DIALECT })
    const response = { id: 'r', status: 'completed', output: [
      { id: 'rs_9', type: 'reasoning', summary: [] },
      { id: 'fc_9', type: 'function_call', call_id: 'call-9', name: 'add_text', arguments: '{}' }
    ] }
    const input = relay.buildTurnRequest(turnInput(stepThenResult(relay, response, 'call-9')), false).body.input as unknown[]
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'call-9', name: 'add_text', arguments: '{}' })
  })

  it('reports a cut-off step instead of throwing, and still fails on an explicit failure', () => {
    const protocol = openai()
    expect(protocol.parseTurnResponse({ id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).stopReason).toBe('max_tokens')
    expect(() => protocol.parseTurnResponse({ id: 'r', status: 'failed', output: [] })).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_FAILED' }))
    const turn = protocol.parseTurnResponse(openaiResponse)
    expect(turn.parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool_call'])
    expect(turn.usage).toEqual({ inputTokens: 900, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 120, reasoningTokens: 90 })
  })

  it('collects finished items from a stream whose terminal event carries no output', () => {
    const turn = drain(openai().createTurnStreamAccumulator(), [
      { type: 'response.created', response: { id: 'resp-s' } },
      { type: 'response.reasoning_summary_text.delta', delta: '需要' },
      { type: 'response.output_item.done', output_index: 0, item: openaiOutput[0] },
      { type: 'response.output_text.delta', delta: '我先加标题。' },
      { type: 'response.output_item.done', output_index: 1, item: openaiOutput[1] },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"text"' },
      { type: 'response.output_item.done', output_index: 2, item: openaiOutput[2] },
      { type: 'response.completed', response: { id: 'resp-s', status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } } }
    ])
    expect(turn.responseId).toBe('resp-s')
    expect(turn.native.payload).toEqual(openaiOutput)
    expect(turn.stopReason).toBe('tool_calls')
  })
})

describe('Anthropic Messages turns', () => {
  const claude = (model = 'claude-sonnet-5-5') => new AnthropicMessagesTurnProtocol({
    baseUrl: 'https://api.anthropic.com', model, dialect: dialect('anthropic'), reasoningEffort: 'high', vision: true
  })
  const claudeContent = [
    { type: 'thinking', thinking: '标题放上方。', signature: 'EqQBCkgIARABGAIi-signature' },
    { type: 'text', text: '我先加标题。' },
    { type: 'tool_use', id: 'toolu_1', name: 'add_text', input: { text: '晨雾' } }
  ]
  const claudeResponse = {
    id: 'msg_1', type: 'message', role: 'assistant', content: claudeContent, stop_reason: 'tool_use',
    usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 150 }
  }

  it('uses x-api-key, adaptive thinking with effort, caching breakpoints and no forced tool', () => {
    const request = claude().buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: '做海报' }] }]), true)
    expect(request).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages',
      authScheme: 'x-api-key',
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        max_tokens: 8_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        tool_choice: { type: 'auto' },
        tools: [{ name: 'add_text', input_schema: TOOL.parameters }],
        system: [{ type: 'text', text: '你是设计搭档。', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '做海报', cache_control: { type: 'ephemeral' } }] }]
      }
    })
    expect(request.body).not.toHaveProperty('temperature')
  })

  it('uses a thinking budget below max_tokens for older Claude models and compatible endpoints', () => {
    expect(claude('claude-sonnet-4-5-20250929').buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]), false).body)
      .toMatchObject({ thinking: { type: 'enabled', budget_tokens: 6_976 }, max_tokens: 8_000 })
    const compatible = new AnthropicMessagesTurnProtocol({ baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4.1-flash', dialect: dialect('deepseek') })
    const request = compatible.buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], { maxOutputTokens: 512 }), false)
    expect(request.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(request.body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1_024 }, max_tokens: 2_048, system: '你是设计搭档。' })
    expect(request.body).not.toHaveProperty('output_config')
  })

  it('replays signed thinking unchanged and puts tool images inside the tool result', () => {
    const protocol = claude()
    const messages = protocol.buildTurnRequest(turnInput(stepThenResult(protocol, claudeResponse, 'toolu_1')), false).body.messages as Record<string, unknown>[]
    expect(messages[1]).toEqual({ role: 'assistant', content: claudeContent })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: '已添加标题 E3' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
        cache_control: { type: 'ephemeral' }
      }]
    })
  })

  it('places tool images after the results on compatible endpoints and merges adjacent person messages', () => {
    const compatible = new AnthropicMessagesTurnProtocol({ baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2.5', dialect: resolveLlmDialect({ baseUrl: 'https://api.moonshot.cn', model: 'x' }).dialect, vision: true })
    const transcript: LlmTranscriptMessage[] = [
      ...stepThenResult(compatible, claudeResponse, 'toolu_1'),
      { role: 'user', parts: [{ type: 'text', text: '先停一下' }] }
    ]
    const messages = compatible.buildTurnRequest(turnInput(transcript), false).body.messages as { role: string; content: Record<string, unknown>[] }[]
    expect(messages).toHaveLength(3)
    expect(messages[2]!.content.map((block) => block.type)).toEqual(['tool_result', 'text', 'image', 'text'])
    expect(messages[2]!.content[0]).toMatchObject({ content: [{ type: 'text', text: '已添加标题 E3\n[附带 1 张图片，见下一条消息]' }] })
  })

  it('parses thinking, text, tool use and cache-aware usage', () => {
    const turn = claude().parseTurnResponse(claudeResponse)
    expect(turn.parts).toEqual([
      { type: 'reasoning', text: '标题放上方。' },
      { type: 'text', text: '我先加标题。' },
      { type: 'tool_call', call: { callId: 'toolu_1', name: 'add_text', argumentsText: '{"text":"晨雾"}', arguments: { text: '晨雾' }, argumentsError: null } }
    ])
    expect(turn.stopReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 2_400, cachedInputTokens: 2_000, cacheWriteInputTokens: 300, outputTokens: 150, reasoningTokens: null })
  })

  it('rebuilds the signed message from a stream and keeps broken arguments as data', () => {
    const turn = drain(claude().createTurnStreamAccumulator(), [
      { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '标题' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '放上方。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCkgIARABGAIi-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'add_text', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text": ' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 42 } },
      { type: 'message_stop' }
    ])
    expect(turn.native.payload).toEqual([
      { type: 'thinking', thinking: '标题放上方。', signature: 'EqQBCkgIARABGAIi-signature' },
      { type: 'tool_use', id: 'toolu_2', name: 'add_text', input: {} }
    ])
    expect(turn.parts[1]).toMatchObject({ type: 'tool_call', call: { argumentsText: '{"text": ', arguments: null, argumentsError: 'incomplete' } })
    expect(turn.stopReason).toBe('max_tokens')
    expect(turn.usage).toMatchObject({ inputTokens: 10, outputTokens: 42 })
  })
})

describe('Anthropic access through the configured provider', () => {
  const config: Extract<ProviderPublicConfig, { kind: 'llm' }> = {
    ...(DEFAULT_PROVIDER_CONFIG.providers[0] as Extract<ProviderPublicConfig, { kind: 'llm' }>),
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    protocol: 'anthropic-messages'
  }

  it('resolves the messages endpoint from the usual address forms', () => {
    expect(resolveLlmProtocolEndpoint('https://api.anthropic.com', 'anthropic-messages')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveLlmProtocolEndpoint('https://api.anthropic.com/v1', 'anthropic-messages')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveLlmProtocolEndpoint('https://open.bigmodel.cn/api/anthropic', 'anthropic-messages')).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(resolveLlmProtocolEndpoint('https://api.anthropic.com/v1/messages', 'anthropic-messages')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('serves the plan-once planner without temperature or a forced tool', () => {
    const protocol = createConfiguredLlmProtocol(config)
    const request = protocol.buildRequest({
      messages: [{ role: 'system', content: '规划' }, { role: 'user', content: '做海报' }],
      tools: [{ name: 'submitAgentPlan', description: '计划', parameters: { type: 'object' } }],
      toolChoice: { name: 'submitAgentPlan' },
      temperature: 0,
      maxOutputTokens: 4_096
    }, false)
    expect(request.body).toMatchObject({ tool_choice: { type: 'auto' }, system: [{ text: '规划' }] })
    expect(request.body).not.toHaveProperty('temperature')
    expect(() => protocol.parseResponse({ id: 'm', content: [], stop_reason: 'max_tokens' }))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TRUNCATED' }))
    expect(protocol.parseResponse({ id: 'm', content: [{ type: 'tool_use', id: 't', name: 'submitAgentPlan', input: { ok: true } }], stop_reason: 'tool_use' }).toolCalls)
      .toEqual([{ id: 't', name: 'submitAgentPlan', arguments: { ok: true } }])
    expect(createConfiguredTurnProtocol(config).wire).toBe('anthropic-messages')
  })

  it('sends the key as x-api-key with the version header and never as a Bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'm', content: [], stop_reason: 'end_turn' }), { headers: { 'content-type': 'application/json' } }))
    const client = new ArkHttpClient({
      secrets: { get: async () => 'sk-ant-fixture' }, authorization: { reserve: async () => undefined },
      allowedBaseUrls: ['https://api.anthropic.com'], fetcher
    })
    const turn = claudeProtocol().buildTurnRequest(turnInput([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]), false)
    await client.postLlmJson({
      ...turn,
      headers: { ...turn.headers, authorization: 'Bearer smuggled', 'x-other': 'no' },
      secretId: 'openai-compatible-llm', expectedImages: 0, costCeilingCny: 0, signal: new AbortController().signal,
      timeoutMs: 10_000, connectTimeoutMs: 5_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 5_000
    })
    const headers = fetcher.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers).toMatchObject({ 'x-api-key': 'sk-ant-fixture', 'anthropic-version': '2023-06-01' })
    expect(headers).not.toHaveProperty('authorization')
    expect(headers).not.toHaveProperty('x-other')
  })
})

function claudeProtocol(): AnthropicMessagesTurnProtocol {
  return new AnthropicMessagesTurnProtocol({ baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', dialect: dialect('anthropic') })
}

