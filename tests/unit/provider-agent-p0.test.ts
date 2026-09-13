import { describe, expect, it, vi } from 'vitest'
import { ArkAgentPlanner, createConfiguredLlmProtocol } from '../../src/main/agent'
import { ArkHttpClient } from '../../src/main/security/ark-http-client'
import { ProviderConnectionValidator } from '../../src/main/security/provider-connection-validator'
import {
  DEFAULT_PROVIDER_CONFIG,
  providerConfigFileSchema,
  type ProviderConfigFile
} from '../../src/shared/provider-settings'
import type { AgentRequest } from '../../src/shared/agent'
import { createAgentFailureEnvelope } from '../../src/main/agent/agent-failure'

function request(text: string): AgentRequest {
  return {
    text,
    sceneSummary: {
      revision: 0,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    autoGenerate: false,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

function llmConfig(
  protocol: ProviderConfigFile['providers'][0]['protocol'],
  reasoningEffort: ProviderConfigFile['providers'][0]['reasoningEffort'] = 'auto'
): ProviderConfigFile {
  const config = structuredClone(DEFAULT_PROVIDER_CONFIG)
  config.providers[0] = {
    ...config.providers[0],
    label: 'Fixture LLM',
    baseUrl: 'https://llm.example.test/v1',
    defaultModel: 'fixture-model',
    protocol,
    reasoningEffort,
    transport: {
      ...config.providers[0].transport,
      mode: 'buffered'
    }
  }
  return config
}

describe('Provider and Agent P0 contracts without external calls', () => {
  it('unwraps one complete JSON object from common model wrappers but rejects incomplete arguments', () => {
    const protocol = createConfiguredLlmProtocol(llmConfig('openai-responses').providers[0])
    const wrapped = protocol.parseResponse({
      id: 'response-wrapped',
      status: 'completed',
      output: [{
        type: 'function_call',
        call_id: 'call-wrapped',
        name: 'submitAgentPlan',
        arguments: '```json\n{"summary":"已理解","response":"好的","nextAction":null,"tools":[]}\n```'
      }]
    })
    expect(wrapped.toolCalls[0]?.arguments).toMatchObject({ summary: '已理解', tools: [] })
    for (const argumentsValue of ['Here is the plan: {"tools":[]}', '"{\\"tools\\":[]}"']) {
      expect(() => protocol.parseResponse({ id: 'response-wrapper', status: 'completed', output: [
        { type: 'function_call', call_id: 'call-wrapper', name: 'submitAgentPlan', arguments: argumentsValue }
      ] })).toThrowError(expect.objectContaining({ code: 'MODEL_ARGUMENTS_INVALID' }))
    }

    expect(() => protocol.parseResponse({
      id: 'response-incomplete',
      status: 'completed',
      output: [{
        type: 'function_call',
        call_id: 'call-incomplete',
        name: 'submitAgentPlan',
        arguments: '{"summary":"未结束"'
      }]
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TRUNCATED' }))
  })

  it('distinguishes an unregistered model tool from malformed registered-tool arguments', async () => {
    const planner = new ArkAgentPlanner({
      protocol: createConfiguredLlmProtocol(llmConfig('openai-responses').providers[0]),
      http: {
        postJson: vi.fn(async () => ({
          id: 'response-unknown-tool',
          status: 'completed',
          output: [{
            type: 'function_call',
            call_id: 'call-unknown-tool',
            name: 'scene.apply_batch',
            arguments: '{}'
          }]
        }))
      },
      assets: { resolveAsset: async () => { throw new Error('No attachments expected') } },
      timeoutMs: 2_000
    })

    await expect(planner.plan(request('清空画布'), new AbortController().signal)).rejects.toMatchObject({
      code: 'MODEL_TOOL_UNSUPPORTED'
    })
  })

  it('migrates legacy Provider files and routes only through the explicit LLM protocol', () => {
    const legacy = structuredClone(DEFAULT_PROVIDER_CONFIG) as unknown as Record<string, unknown>
    legacy.version = 2
    const providers = legacy.providers as Array<Record<string, unknown>>
    delete providers[0]!.protocol
    const migrated = providerConfigFileSchema.parse(legacy)
    expect(migrated.version).toBe(5)
    expect(migrated.providers[0].protocol).toBe('ark-responses')
    expect(migrated.providers[0].transport.mode).toBe('auto')

    expect(createConfiguredLlmProtocol(llmConfig('openai-responses').providers[0]).buildRequest({
      messages: [{ role: 'user', content: 'test' }], tools: []
    }, false).url).toBe('https://llm.example.test/v1/responses')
    expect(createConfiguredLlmProtocol(llmConfig('openai-chat-completions').providers[0]).buildRequest({
      messages: [{ role: 'user', content: 'test' }], tools: []
    }, false).url).toBe('https://llm.example.test/v1/chat/completions')
    const direct = llmConfig('openai-responses')
    direct.providers[0] = { ...direct.providers[0], baseUrl: 'https://llm.example.test/v1/responses' }
    expect(createConfiguredLlmProtocol(direct.providers[0]).buildRequest({
      messages: [{ role: 'user', content: 'test' }], tools: []
    }, false).url).toBe('https://llm.example.test/v1/responses')
  })

  it('preserves HTTP status and content type when an upstream returns an HTML error page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>upstream failed</html>', {
      status: 520,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    }))
    const client = new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      allowedBaseUrls: ['https://llm.example.test/v1'],
      fetcher
    })
    await expect(client.postJson({
      url: 'https://llm.example.test/v1/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      providerLabel: 'Fixture LLM',
      expectedImages: 0,
      costCeilingCny: 0.05,
      signal: new AbortController().signal,
      timeoutMs: 2_000
    })).rejects.toMatchObject({
      code: 'PROVIDER_UPSTREAM_ERROR',
      status: 520,
      contentType: 'text/html; charset=utf-8'
    })
    await expect(client.postJson({
      url: 'https://llm.example.test/v1/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      providerLabel: 'Fixture LLM',
      expectedImages: 0,
      costCeilingCny: 0.05,
      signal: new AbortController().signal,
      timeoutMs: 2_000
    })).rejects.toThrow(/Base URL 与协议/)
  })

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [504, 'PROVIDER_TIMEOUT']
  ] as const)('classifies HTTP %s without hiding it behind JSON parsing', async (status, code) => {
    const client = new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      allowedBaseUrls: ['https://llm.example.test/v1'],
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { code: 'fixture', message: 'provider detail' } }), {
        status,
        headers: { 'content-type': 'application/json' }
      }))
    })
    await expect(client.postJson({
      url: 'https://llm.example.test/v1/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      expectedImages: 0,
      costCeilingCny: 0.05,
      signal: new AbortController().signal,
      timeoutMs: 2_000
    })).rejects.toMatchObject({ code, status })
  })

  it('reports a successful non-JSON response as a protocol mismatch', async () => {
    const client = new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      allowedBaseUrls: ['https://llm.example.test/v1'],
      fetcher: vi.fn(async () => new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      }))
    })
    await expect(client.postJson({
      url: 'https://llm.example.test/v1/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      expectedImages: 0,
      costCeilingCny: 0.05,
      signal: new AbortController().signal,
      timeoutMs: 2_000
    })).rejects.toMatchObject({ code: 'PROVIDER_PROTOCOL_MISMATCH', status: 200, contentType: 'text/plain' })
  })

  it('rejects an empty tool plan for an execution request but permits ordinary conversation', async () => {
    const protocol = createConfiguredLlmProtocol(llmConfig('openai-responses').providers[0])
    const planner = new ArkAgentPlanner({
      protocol,
      http: {
        postJson: vi.fn(async () => ({
          id: 'response-1',
          status: 'completed',
          output: [{
            type: 'function_call',
            call_id: 'call-1',
            name: 'submitAgentPlan',
            arguments: JSON.stringify({ summary: '已理解', response: '好的', nextAction: null, tools: [] })
          }]
        }))
      },
      assets: { resolveAsset: async () => { throw new Error('No attachments expected') } },
      timeoutMs: 2_000
    })
    await expect(planner.plan(request('创建一张香水海报'), new AbortController().signal)).rejects.toMatchObject({
      code: 'MODEL_ACTION_PLAN_EMPTY'
    })
    await expect(planner.plan(request('标题再疏一点'), new AbortController().signal)).rejects.toMatchObject({
      code: 'MODEL_ACTION_PLAN_EMPTY'
    })
    await expect(planner.plan(request('聊聊这个构图给人的感受'), new AbortController().signal)).resolves.toMatchObject({ tools: [] })
    await expect(planner.plan(request('先不要生成图片，只聊聊这个构图'), new AbortController().signal)).resolves.toMatchObject({ tools: [] })
  })

  it('instructs the live planner to build editable semantic parts without claiming bitmap auto-layering', async () => {
    const postJson = vi.fn(async (input: Parameters<ArkHttpClient['postJson']>[0]) => {
      void input
      return {
        id: 'response-structured-composition',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call-structured-composition',
          name: 'submitAgentPlan',
          arguments: JSON.stringify({ summary: '已阅读', response: '构图关系清楚。', nextAction: null, tools: [] })
        }]
      }
    })
    const planner = new ArkAgentPlanner({
      protocol: createConfiguredLlmProtocol(llmConfig('openai-responses').providers[0]),
      http: { postJson },
      assets: { resolveAsset: async () => { throw new Error('No attachments expected') } },
      timeoutMs: 2_000
    })

    await planner.plan(request('聊聊这个构图给人的感受'), new AbortController().signal)
    const body = postJson.mock.calls[0]?.[0].body as { instructions?: unknown }
    const instructions = String(body.instructions ?? '')
    expect(instructions).toContain('独立可编辑元素')
    expect(instructions).toContain('先添加子元素，再执行 element.group')
    expect(instructions).toContain('不得把最终位图描述成已经自动拆层')

    const failure = createAgentFailureEnvelope({
      error: new Error('仅替换失败操作'), fallbackCode: 'SCENE_REVISION_CONFLICT',
      attempt: 1, maxAttempts: 2, completedToolIndexes: [0], failedToolIndex: 1,
      unstartedToolIndexes: [2], remainingWallTimeMs: 20_000, remainingCostCny: null
    })
    await planner.plan(request('聊聊这个构图给人的感受'), new AbortController().signal, failure)
    const repairedBody = postJson.mock.calls[1]?.[0].body as { input?: Array<{ content?: unknown }> }
    const repairedInstructions = String(repairedBody.input?.[0]?.content ?? '')
    expect(repairedInstructions).toContain('对应的已提交操作，不得重放')
    expect(repairedInstructions).not.toContain('上一次计划未执行')
    expect(repairedInstructions).toContain('"completedToolIndexes":[0]')
    expect(repairedInstructions).toContain('"remainingWallTimeMs":20000')
    expect(repairedInstructions).toContain('"remainingCostCny":null')
  })

  it('validates one saved Chat Completions connection and never retries a failed POST', async () => {
    const successFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { parameters?: { properties?: { ok?: Record<string, unknown> } } } }>
        tool_choice?: unknown
        max_tokens?: number
      }
      expect(body.tools).toHaveLength(1)
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'verifyAiCanvasConnection' } })
      expect(body.max_tokens).toBe(4_096)
      expect(body.tools?.[0]?.function?.parameters?.properties?.ok).not.toHaveProperty('const')
      return new Response(JSON.stringify({
        id: 'chatcmpl-check',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'call-check',
              type: 'function',
              function: { name: 'verifyAiCanvasConnection', arguments: '{"ok":true}' }
            }]
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const authorization = { reserve: vi.fn(async () => undefined) }
    const validator = new ProviderConnectionValidator({
      config: { read: async () => llmConfig('openai-chat-completions', 'none') },
      secrets: { get: async () => 'fixture-key' },
      authorization,
      fetcher: successFetch
    })
    await expect(validator.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: true,
      requestsUsed: 1,
      generatedImages: 0,
      toolCallingVerified: true,
      endpoint: 'https://llm.example.test/v1/chat/completions'
    })
    expect(successFetch).toHaveBeenCalledTimes(1)
    expect(authorization.reserve).toHaveBeenCalledTimes(1)

    const failedFetch = vi.fn<typeof fetch>(async () => new Response('<html>bad gateway</html>', {
      status: 520,
      headers: { 'content-type': 'text/html' }
    }))
    const failed = new ProviderConnectionValidator({
      config: { read: async () => llmConfig('openai-responses') },
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      fetcher: failedFetch
    })
    await expect(failed.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: false,
      requestsUsed: 1,
      failure: { code: 'PROVIDER_UPSTREAM_ERROR', httpStatus: 520, contentType: 'text/html' }
    })
    expect(failedFetch).toHaveBeenCalledTimes(1)
  })

  it('validates the same selected streaming transport instead of silently falling back to buffered JSON', async () => {
    const config = llmConfig('openai-responses', 'none')
    config.providers[0] = {
      ...config.providers[0],
      transport: { ...config.providers[0].transport, mode: 'auto' },
      capabilities: { ...config.providers[0].capabilities, streaming: true }
    }
    const encoder = new TextEncoder()
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      expect(body.stream).toBe(true)
      const payload = [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-stream-check","name":"verifyAiCanvasConnection","arguments":"{\\"ok\\":true}"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp-stream-check","status":"completed"}}\n\n'
      ].join('')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload.slice(0, 61)))
          controller.enqueue(encoder.encode(payload.slice(61)))
          controller.close()
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const validator = new ProviderConnectionValidator({
      config: { read: async () => config },
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      fetcher
    })

    await expect(validator.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: true, requestsUsed: 1, toolCallingVerified: true
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('validates a thinking Responses connection with automatic tool selection and one request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        reasoning?: { effort?: string }
        tool_choice?: unknown
        max_output_tokens?: number
        tools?: unknown[]
      }
      expect(body.reasoning).toEqual({ effort: 'high' })
      expect(body.tool_choice).toBe('auto')
      expect(body.max_output_tokens).toBe(8_192)
      expect(body.tools).toHaveLength(1)
      return new Response(JSON.stringify({
        id: 'resp-thinking-check',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call-thinking-check',
          name: 'verifyAiCanvasConnection',
          arguments: '{"ok":true}'
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const config = llmConfig('openai-responses', 'high')
    config.providers[0] = { ...config.providers[0], maxOutputTokens: 8_192 }
    const validator = new ProviderConnectionValidator({
      config: { read: async () => config },
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      fetcher
    })

    await expect(validator.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: true,
      requestsUsed: 1,
      generatedImages: 0,
      toolCallingVerified: true
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('classifies a provider rejection of forced tool choice in thinking mode', async () => {
    const validator = new ProviderConnectionValidator({
      config: { read: async () => llmConfig('openai-responses', 'high') },
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message: 'Thinking mode does not support this tool_choice'
        }
      }), { status: 400, headers: { 'content-type': 'application/json' } }))
    })

    await expect(validator.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: false,
      requestsUsed: 1,
      failure: {
        code: 'PROVIDER_THINKING_TOOL_CHOICE_UNSUPPORTED',
        title: '思考模式不接受强制工具选择',
        httpStatus: 400
      }
    })
  })

  it.each([
    {
      name: 'completed response with visibly incomplete tool arguments',
      response: {
        id: 'resp-invalid-arguments',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'call-invalid', name: 'verifyAiCanvasConnection', arguments: '{"ok":' }]
      },
      code: 'PROVIDER_RESPONSE_TRUNCATED',
      title: '模型输出在工具参数完成前被截断'
    },
    {
      name: 'reasoning response truncated before tool arguments complete',
      response: {
        id: 'resp-truncated',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'function_call', call_id: 'call-truncated', name: 'verifyAiCanvasConnection', arguments: '{"ok":' }]
      },
      code: 'PROVIDER_RESPONSE_TRUNCATED',
      title: '模型输出在工具参数完成前被截断'
    }
  ])('counts the submitted request and classifies $name', async ({ response, code, title }) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown; max_output_tokens?: number }
      expect(body.tool_choice).toBe('auto')
      expect(body.max_output_tokens).toBe(4_096)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const validator = new ProviderConnectionValidator({
      config: { read: async () => llmConfig('openai-responses') },
      secrets: { get: async () => 'fixture-key' },
      authorization: { reserve: vi.fn(async () => undefined) },
      fetcher
    })

    await expect(validator.validate({ providerId: 'openai-compatible-llm', confirmed: true })).resolves.toMatchObject({
      ok: false,
      requestsUsed: 1,
      generatedImages: 0,
      failure: { code, title }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
