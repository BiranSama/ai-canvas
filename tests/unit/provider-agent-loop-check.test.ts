import { describe, expect, it, vi } from 'vitest'
import { ProviderConnectionValidator } from '../../src/main/security/provider-connection-validator'
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfigFile } from '../../src/shared/provider-settings'

function config(overrides: Partial<ProviderConfigFile['providers'][0]>): ProviderConfigFile {
  const value = structuredClone(DEFAULT_PROVIDER_CONFIG)
  value.providers[0] = {
    ...value.providers[0],
    label: 'Fixture LLM',
    transport: { ...value.providers[0].transport, mode: 'buffered' },
    ...overrides
  }
  return value
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function validator(file: ProviderConfigFile, fetcher: typeof fetch) {
  const authorization = { reserve: vi.fn(async () => undefined) }
  return {
    authorization,
    instance: new ProviderConnectionValidator({ config: { read: async () => file }, secrets: { get: async () => 'fixture-key' }, authorization, fetcher })
  }
}

const deepseekCall = {
  id: 'chat-1',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: null,
      reasoning_content: '按要求调用验证工具。',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'verifyAiCanvasConnection', arguments: '{"ok":true}' } }]
    }
  }]
}

describe('multi-step connection check', () => {
  it('runs two steps, sends the reasoning back and checks the image inside the tool result', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return bodies.length === 1
        ? json(deepseekCall)
        : json({ id: 'chat-2', choices: [{ finish_reason: 'stop', message: { content: '红色', reasoning_content: '图片是红色。' } }] })
    })
    const file = config({ baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4.1-flash', protocol: 'openai-chat-completions', capabilities: { streaming: false, toolCalling: true, vision: true } })
    const { instance, authorization } = validator(file, fetcher)

    await expect(instance.validate({ providerId: 'openai-compatible-llm', confirmed: true, scope: 'agent_loop' })).resolves.toMatchObject({
      ok: true,
      requestsUsed: 2,
      toolCallingVerified: true,
      agentLoop: { dialect: 'DeepSeek', thinkingObserved: true, visionVerified: true }
    })
    expect(authorization.reserve).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, tool_choice: 'auto' })
    expect(bodies[0]).not.toHaveProperty('temperature')
    const replay = (bodies[1]!.messages as Record<string, unknown>[])
    expect(replay[2]).toMatchObject({ role: 'assistant', reasoning_content: '按要求调用验证工具。' })
    expect(replay[3]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    expect(JSON.stringify(replay[4])).toContain('data:image/png;base64,')
  })

  it('reports a rejected replay separately from a broken first step', async () => {
    let calls = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      calls += 1
      return calls === 1
        ? json(deepseekCall)
        : json({ error: { message: 'Missing reasoning_content in assistant message' } }, 400)
    })
    const file = config({ baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4.1-flash', protocol: 'openai-chat-completions' })

    await expect(validator(file, fetcher).instance.validate({ providerId: 'openai-compatible-llm', confirmed: true, scope: 'agent_loop' })).resolves.toMatchObject({
      ok: false,
      requestsUsed: 2,
      failure: { code: 'PROVIDER_REPLAY_REJECTED', title: '多步工具调用未通过', httpStatus: 400 }
    })
  })

  it('stops after the first step when the model does not call the tool', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ id: 'm', type: 'message', content: [{ type: 'text', text: '好的' }], stop_reason: 'end_turn' }))
    const file = config({ baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5-5', protocol: 'anthropic-messages' })

    await expect(validator(file, fetcher).instance.validate({ providerId: 'openai-compatible-llm', confirmed: true, scope: 'agent_loop' })).resolves.toMatchObject({
      ok: false,
      requestsUsed: 1,
      failure: { code: 'MODEL_TOOL_CALL_MISSING' }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps the single tool-call check as the default', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(deepseekCall))
    const file = config({ baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4.1-flash', protocol: 'openai-chat-completions' })

    await expect(validator(file, fetcher).instance.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: true, requestsUsed: 1, agentLoop: null
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
