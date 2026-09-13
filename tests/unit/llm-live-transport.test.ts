import { describe, expect, it, vi } from 'vitest'
import { ResponsesLlmProtocol } from '../../src/main/agent/ark-responses-protocol'
import { OpenAiCompatibleLlmProtocol } from '../../src/main/agent/llm-provider'
import {
  MAX_SSE_FRAME_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  SseDecoder
} from '../../src/main/agent/llm-stream'
import { ArkHttpClient, type ArkLlmTransportPhase } from '../../src/main/security/ark-http-client'
import { createConfiguredLlmProtocol } from '../../src/main/agent/llm-protocol-factory'
import { DEFAULT_PROVIDER_CONFIG } from '../../src/shared/provider-settings'

function chunks(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
}

describe('Main-only live LLM transport', () => {
  it('captures the Responses ID at creation rather than waiting for completion', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    expect(protocol.createStreamAccumulator().accept({ event: null, id: null, commentOnly: false,
      data: JSON.stringify({ type: 'response.created', response: { id: 'resp-early' } })
    })).toEqual([{ kind: 'transport', responseId: 'resp-early', semantic: false }])
  })

  it('rejects oversized buffered arguments and nonterminal responses', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    expect(() => protocol.parseResponse({ id: 'pending', status: 'in_progress', output: [] }))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_STREAM_INCOMPLETE' }))
    expect(() => protocol.parseResponse({ id: 'huge', status: 'completed', output: [
      { type: 'function_call', call_id: 'call', name: 'submitAgentPlan', arguments: ' '.repeat(MAX_TOOL_ARGUMENT_BYTES + 1) }
    ] })).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TOO_LARGE' }))
  })

  it('delivers live progress within 100ms without persisting every fragment and cleans timers', async () => {
    vi.useFakeTimers()
    try {
      const observations: Array<{ phase: string; checkpoint?: boolean; receivedBytes: number }> = []
      let push!: (value: string) => void
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) { push = (value) => controller.enqueue(new TextEncoder().encode(value)) }, cancel
      })
      const client = new ArkHttpClient({
        secrets: { get: async () => 'fixture-key' }, authorization: { reserve: async () => undefined },
        allowedBaseUrls: ['https://llm.example.test/v1'],
        fetcher: vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      })
      const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
      const pending = client.postEventStream({ url: 'https://llm.example.test/v1/responses', body: { stream: true },
        secretId: 'openai-compatible-llm', expectedImages: 0, costCeilingCny: 0, signal: new AbortController().signal,
        timeoutMs: 10_000, connectTimeoutMs: 2_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000,
        observe: (event) => { observations.push(event) }
      }, protocol.createStreamAccumulator())
      await vi.advanceTimersByTimeAsync(1)
      push('data: {"type":"response.output_text.delta","delta":"one"}\n\n')
      await vi.advanceTimersByTimeAsync(20)
      push('data: {"type":"response.output_text.delta","delta":"two"}\n\n')
      await vi.advanceTimersByTimeAsync(20)
      push('data: {"type":"response.output_text.delta","delta":"three"}\n\n')
      await vi.advanceTimersByTimeAsync(100)
      const live = observations.filter((event) => event.phase === 'receiving')
      expect(live).toHaveLength(2)
      expect(live.map((event) => event.checkpoint)).toEqual([true, false])
      expect(live[1]!.receivedBytes).toBeGreaterThan(live[0]!.receivedBytes)
      push('data: {"type":"response.completed","response":{"id":"resp-live","status":"completed"}}\n\n')
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ text: 'onetwothree' })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('uses the saved streaming capability for all configured protocols', () => {
    const config = structuredClone(DEFAULT_PROVIDER_CONFIG.providers[0])
    if (config.kind !== 'llm') throw new Error('LLM fixture expected')
    for (const protocol of ['openai-responses', 'ark-responses', 'openai-chat-completions'] as const) {
      expect(createConfiguredLlmProtocol({ ...config, protocol, capabilities: { ...config.capabilities, streaming: false } }).capabilities.streaming).toBe(false)
      expect(createConfiguredLlmProtocol({ ...config, protocol, capabilities: { ...config.capabilities, streaming: true } }).capabilities.streaming).toBe(true)
    }
  })

  it('does not create phantom tools from completed reasoning and message items', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    for (const payload of [
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ text: 'private reasoning' }] } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', content: [{ type: 'output_text', text: 'visible' }] } },
      { type: 'response.completed', response: { id: 'resp-message', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'visible' }] }] } }
    ]) accumulator.accept({ event: null, id: null, data: JSON.stringify(payload), commentOnly: false })
    expect(accumulator.finalize()).toMatchObject({ text: 'visible', toolCalls: [] })
    expect(JSON.stringify(accumulator.finalize())).not.toContain('private reasoning')
  })

  it('accepts usage-only Chat chunks and unknown valid events without semantic progress', () => {
    const protocol = new OpenAiCompatibleLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const accept = (payload: unknown) => accumulator.accept({ event: null, id: null, data: JSON.stringify(payload), commentOnly: false })
    accept({ id: 'chat-usage', choices: [{ index: 0, delta: { content: 'ok', reasoning_content: 'private' }, finish_reason: 'stop' }] })
    expect(accept({ id: 'chat-usage', choices: [], usage: { completion_tokens: 20 } }).every((entry) => !entry.semantic)).toBe(true)
    expect(accept({ type: 'vendor.keepalive', payload: 'private' }).every((entry) => !entry.semantic)).toBe(true)
    accumulator.accept({ event: null, id: null, data: '[DONE]', commentOnly: false })
    expect(accumulator.finalize()).toMatchObject({ text: 'ok', toolCalls: [] })
    expect(JSON.stringify(accumulator.finalize())).not.toContain('private')
  })

  it('rejects content-filtered buffered output before any tool can be executed', () => {
    const responses = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const chat = new OpenAiCompatibleLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    expect(() => responses.parseResponse({ id: 'resp-filtered', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_OUTPUT_FILTERED' }))
    expect(() => chat.parseResponse({ id: 'chat-filtered', choices: [{ finish_reason: 'content_filter', message: { content: null } }] }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_OUTPUT_FILTERED' }))
  })

  it('decodes arbitrary boundaries, CRLF, multiple frames, multiline data and comments', () => {
    const decoder = new SseDecoder()
    const output = [
      ...decoder.push(new TextEncoder().encode(':keep-alive\r')),
      ...decoder.push(new TextEncoder().encode('\n\r\ndata: {"one":\r\ndata: 1}\n\ndata: [DO')),
      ...decoder.push(new TextEncoder().encode('NE]\n\n')),
      ...decoder.finish()
    ]
    expect(output).toEqual([
      { event: null, id: null, data: '', commentOnly: true },
      { event: null, id: null, data: '{"one":\n1}', commentOnly: false },
      { event: null, id: null, data: '[DONE]', commentOnly: false }
    ])
  })

  it('accumulates Responses tools only after response.completed and drops reasoning text', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const decoder = new SseDecoder()
    const frames = decoder.push(new TextEncoder().encode([
      'data: {"type":"response.reasoning_text.delta","response_id":"resp-1","delta":"private"}',
      'data: {"type":"response.output_item.added","response_id":"resp-1","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"submitAgentPlan","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","response_id":"resp-1","output_index":0,"delta":"{\\"summary\\":\\"ok\\",\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}',
      ''
    ].join('\n\n')))
    for (const frame of frames) accumulator.accept(frame)
    expect(accumulator.finalize()).toEqual({
      id: 'resp-1', text: '', finishReason: 'completed',
      toolCalls: [{ id: 'call-1', name: 'submitAgentPlan', arguments: { summary: 'ok', response: 'ok', nextAction: null, tools: [] } }]
    })
    expect(JSON.stringify(accumulator.finalize())).not.toContain('private')
  })

  it('recognizes completed Responses arguments without duplicating the final snapshot', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const frames = new SseDecoder().push(new TextEncoder().encode([
      'data: {"type":"response.output_item.added","response_id":"resp-done","output_index":0,"item":{"type":"function_call","call_id":"call-done","name":"submitAgentPlan","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","response_id":"resp-done","output_index":0,"delta":"{\\"summary\\":\\"ok\\","}',
      'data: {"type":"response.function_call_arguments.done","response_id":"resp-done","output_index":0,"arguments":"{\\"summary\\":\\"ok\\",\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}',
      'data: {"type":"response.completed","response":{"id":"resp-done","status":"completed"}}',
      ''
    ].join('\n\n')))
    const kinds = frames.flatMap((frame) => accumulator.accept(frame).map((event) => event.kind))
    expect(kinds).toContain('tool_arguments_complete')
    expect(accumulator.finalize().toolCalls[0]?.arguments).toMatchObject({ summary: 'ok', tools: [] })
  })

  it('maps an explicit Responses content-filter terminal without exposing partial output', () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const frames = new SseDecoder().push(new TextEncoder().encode(
      'data: {"type":"response.incomplete","response":{"id":"resp-filtered","incomplete_details":{"reason":"content_filter"}}}\n\n'
    ))
    expect(() => accumulator.accept(frames[0]!)).toThrowError(expect.objectContaining({ code: 'MODEL_OUTPUT_FILTERED' }))
  })

  it('accumulates indexed Chat tool deltas and requires [DONE]', () => {
    const protocol = new OpenAiCompatibleLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const decoder = new SseDecoder()
    const stream = [
      'data: {"id":"chat-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"submitAgentPlan","arguments":"{\\"summary\\":\\"ok\\","}}]}}]}',
      'data: {"id":"chat-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      ''
    ].join('\n\n')
    for (const frame of decoder.push(new TextEncoder().encode(stream))) accumulator.accept(frame)
    expect(accumulator.finalize().toolCalls[0]).toMatchObject({ id: 'call-1', name: 'submitAgentPlan' })

    const incomplete = protocol.createStreamAccumulator()
    for (const frame of new SseDecoder().push(new TextEncoder().encode('data: {"id":"chat-2","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'))) incomplete.accept(frame)
    expect(() => incomplete.finalize()).toThrowError(expect.objectContaining({ code: 'PROVIDER_STREAM_INCOMPLETE' }))
  })

  it('keeps Chat tool indexes isolated per choice and maps length termination to truncation', () => {
    const protocol = new OpenAiCompatibleLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const accumulator = protocol.createStreamAccumulator()
    const stream = [
      'data: {"id":"chat-many","choices":[{"index":1,"delta":{"tool_calls":[{"index":0,"id":"other","function":{"name":"otherTool","arguments":"{}"}}]}},{"index":0,"delta":{"tool_calls":[{"index":0,"id":"wanted","function":{"name":"submitAgentPlan","arguments":"{\\"summary\\":\\"ok\\",\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      ''
    ].join('\n\n')
    for (const frame of new SseDecoder().push(new TextEncoder().encode(stream))) accumulator.accept(frame)
    expect(accumulator.finalize().toolCalls).toEqual([
      expect.objectContaining({ id: 'wanted', name: 'submitAgentPlan' })
    ])

    const truncated = protocol.createStreamAccumulator()
    const truncatedStream = 'data: {"id":"chat-short","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    for (const frame of new SseDecoder().push(new TextEncoder().encode(truncatedStream))) truncated.accept(frame)
    expect(() => truncated.finalize()).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TRUNCATED' }))
  })

  it('rejects malformed frames and enforces frame and tool-argument limits before execution', () => {
    const malformed = new SseDecoder().push(new TextEncoder().encode('data: {not-json}\n\n'))
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    expect(() => protocol.createStreamAccumulator().accept(malformed[0]!))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_STREAM_MALFORMED' }))
    expect(() => new SseDecoder().push(new TextEncoder().encode(`data: ${'x'.repeat(MAX_SSE_FRAME_BYTES + 1)}`)))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TOO_LARGE' }))

    const oversizedArguments = protocol.createStreamAccumulator()
    const added = new SseDecoder().push(new TextEncoder().encode(
      'data: {"type":"response.output_item.added","response_id":"resp-large","output_index":0,"item":{"type":"function_call","call_id":"call-large","name":"submitAgentPlan","arguments":""}}\n\n'
    ))
    oversizedArguments.accept(added[0]!)
    expect(() => oversizedArguments.accept({
      event: null,
      id: null,
      data: JSON.stringify({
        type: 'response.function_call_arguments.delta', response_id: 'resp-large', output_index: 0,
        delta: 'x'.repeat(MAX_TOOL_ARGUMENT_BYTES + 1)
      }),
      commentOnly: false
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TOO_LARGE' }))
  })

  it('streams through fake fetch with observable real milestones and one request', async () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const phases: ArkLlmTransportPhase[] = []
    const fetcher = vi.fn<typeof fetch>(async () => new Response(chunks([
      'data: {"type":"response.output_item.added","response_id":"resp-1","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"submitAgentPlan","arguments":"{\\"summary\\":\\"ok\\",\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n'
    ]), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'safe-request-id' } }))
    const reserve = vi.fn(async () => undefined)
    const client = new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' }, authorization: { reserve },
      allowedBaseUrls: ['https://llm.example.test/v1'], fetcher
    })
    const result = await client.postEventStream({
      url: 'https://llm.example.test/v1/responses', body: { stream: true }, secretId: 'openai-compatible-llm',
      providerId: 'openai-compatible-llm', providerLabel: 'Fixture', authorizationScopeId: 'scope',
      expectedImages: 0, costCeilingCny: 0.01, signal: new AbortController().signal,
      timeoutMs: 5_000, connectTimeoutMs: 2_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000,
      observe: (event) => { phases.push(event.phase) }
    }, protocol.createStreamAccumulator())
    expect(result.toolCalls).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(phases).toEqual(expect.arrayContaining(['reserved', 'connecting', 'headers', 'first_event', 'receiving', 'completed']))
  })

  it('finishes on the protocol terminal event even when the server leaves the socket open', async () => {
    const protocol = new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_item.added","response_id":"resp-open","output_index":0,"item":{"type":"function_call","call_id":"call-open","name":"submitAgentPlan","arguments":"{\\"summary\\":\\"ok\\",\\"response\\":\\"ok\\",\\"nextAction\\":null,\\"tools\\":[]}"}}',
          'data: {"type":"response.completed","response":{"id":"resp-open","status":"completed"}}',
          ''
        ].join('\n\n')))
      },
      cancel() { cancelled = true }
    })
    const client = new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' }, authorization: { reserve: async () => undefined },
      allowedBaseUrls: ['https://llm.example.test/v1'],
      fetcher: vi.fn<typeof fetch>(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    })
    await expect(client.postEventStream({
      url: 'https://llm.example.test/v1/responses', body: { stream: true }, secretId: 'openai-compatible-llm',
      expectedImages: 0, costCeilingCny: 0, signal: new AbortController().signal,
      timeoutMs: 5_000, connectTimeoutMs: 2_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000
    }, protocol.createStreamAccumulator())).resolves.toMatchObject({ id: 'resp-open' })
    expect(cancelled).toBe(true)
  })

  it('classifies a connection deadline without submitting a replacement POST', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const client = new ArkHttpClient({
        secrets: { get: async () => 'fixture-key' }, authorization: { reserve: async () => undefined },
        allowedBaseUrls: ['https://llm.example.test/v1'], fetcher
      })
      const pending = client.postLlmJson({
        url: 'https://llm.example.test/v1/responses', body: {}, secretId: 'openai-compatible-llm',
        expectedImages: 0, costCeilingCny: 0, signal: new AbortController().signal,
        timeoutMs: 5_000, connectTimeoutMs: 1_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000
      })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CONNECT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_001)
      await rejected
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps first-event, idle, total and user cancellation distinct', async () => {
    vi.useFakeTimers()
    const makeClient = (fetcher: typeof fetch): ArkHttpClient => new ArkHttpClient({
      secrets: { get: async () => 'fixture-key' }, authorization: { reserve: async () => undefined },
      allowedBaseUrls: ['https://llm.example.test/v1'], fetcher
    })
    const request = (signal: AbortSignal) => ({
      url: 'https://llm.example.test/v1/responses', body: {}, secretId: 'openai-compatible-llm' as const,
      expectedImages: 0, costCeilingCny: 0, signal,
      timeoutMs: 5_000, connectTimeoutMs: 5_000, firstEventTimeoutMs: 1_000, idleTimeoutMs: 1_000
    })
    try {
      const noFirstBody = new ReadableStream<Uint8Array>({ start() { /* intentionally open */ } })
      const firstClient = makeClient(vi.fn<typeof fetch>(async () => new Response(noFirstBody, { status: 200, headers: { 'content-type': 'application/json' } })))
      const firstPending = firstClient.postLlmJson(request(new AbortController().signal))
      const firstRejected = expect(firstPending).rejects.toMatchObject({ code: 'PROVIDER_FIRST_EVENT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_001)
      await firstRejected

      const idleBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } })
      const idleClient = makeClient(vi.fn<typeof fetch>(async () => new Response(idleBody, { status: 200, headers: { 'content-type': 'application/json' } })))
      const idlePending = idleClient.postLlmJson(request(new AbortController().signal))
      const idleRejected = expect(idlePending).rejects.toMatchObject({ code: 'PROVIDER_IDLE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_001)
      await idleRejected

      const neverFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const totalClient = makeClient(neverFetch)
      const totalPending = totalClient.postLlmJson({ ...request(new AbortController().signal), timeoutMs: 1_000 })
      const totalRejected = expect(totalPending).rejects.toMatchObject({ code: 'PROVIDER_TOTAL_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_001)
      await totalRejected

      const cancelController = new AbortController()
      const cancelClient = makeClient(neverFetch)
      const cancelPending = cancelClient.postLlmJson(request(cancelController.signal))
      const cancelRejected = expect(cancelPending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' })
      await Promise.resolve()
      cancelController.abort()
      await cancelRejected
      const budgetController = new AbortController()
      const budgetPending = makeClient(neverFetch).postLlmJson(request(budgetController.signal))
      const budgetRejected = expect(budgetPending).rejects.toMatchObject({ code: 'BUDGET_WALL_TIME' })
      await vi.advanceTimersByTimeAsync(1)
      budgetController.abort(Object.assign(new Error('Harness deadline'), { code: 'BUDGET_WALL_TIME' }))
      await budgetRejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stalled Provider error body without retrying the POST', async () => {
    vi.useFakeTimers()
    try {
      const stalledErrorBody = new ReadableStream<Uint8Array>({
        start() { /* headers arrive, but the Provider never sends its error body */ }
      })
      const fetcher = vi.fn<typeof fetch>(async () => new Response(stalledErrorBody, {
        status: 429,
        headers: { 'content-type': 'application/json' }
      }))
      const client = new ArkHttpClient({
        secrets: { get: async () => 'fixture-key' },
        authorization: { reserve: async () => undefined },
        allowedBaseUrls: ['https://llm.example.test/v1'],
        fetcher
      })
      const pending = client.postLlmJson({
        url: 'https://llm.example.test/v1/responses', body: {}, secretId: 'openai-compatible-llm',
        expectedImages: 0, costCeilingCny: 0, signal: new AbortController().signal,
        timeoutMs: 5_000, connectTimeoutMs: 2_000, firstEventTimeoutMs: 1_000, idleTimeoutMs: 1_000
      })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_FIRST_EVENT_TIMEOUT', status: 429 })
      await vi.advanceTimersByTimeAsync(1_001)
      await rejected
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
