import { describe, expect, it, vi } from 'vitest'
import { parseModelToolArguments } from '../../src/main/agent/tool-arguments'
import { ResponsesLlmProtocol } from '../../src/main/agent/ark-responses-protocol'
import { OpenAiCompatibleLlmProtocol } from '../../src/main/agent/llm-provider'
import { createAgentFailureEnvelope } from '../../src/main/agent/agent-failure'
import { ArkAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import type { AgentRequest } from '../../src/shared/agent'

describe('precise, content-free tool argument repair feedback', () => {
  it.each([
    ['{"text":"{ private-content",}', 'invalid'],
    ['{"text":"}","tools":[', 'incomplete'],
    ['{"text":"unterminated', 'incomplete'],
    ['{"tools":[]}{"second":', 'invalid'],
    ['{"tools":[}', 'invalid'],
    ['{"tools":oops', 'invalid'],
    ['{"tools":', 'incomplete'],
    ['[{}]', 'invalid']
  ])('classifies %s as %s without guessing repairs', (input, failure) => {
    expect(() => parseModelToolArguments(input)).toThrowError(expect.objectContaining({ failure }))
  })

  it.each(['responses', 'chat'])('preserves safe syntax feedback through %s and into the next planner request', async (mode) => {
    const protocol = mode === 'responses'
      ? new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
      : new OpenAiCompatibleLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' })
    const invalid = '{"text":"private-content",}'
    let caught: unknown
    try {
      protocol.parseResponse(mode === 'responses'
        ? { id: 'bad', status: 'completed', output: [{ type: 'function_call', call_id: 'call', name: 'submitAgentPlan', arguments: invalid }] }
        : { id: 'bad', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call', type: 'function', function: { name: 'submitAgentPlan', arguments: invalid } }] } }] })
    } catch (error) { caught = error }
    const failure = createAgentFailureEnvelope({ error: caught, fallbackCode: 'UNKNOWN', attempt: 1, maxAttempts: 2 })
    expect(failure.code).toBe('MODEL_ARGUMENTS_INVALID')
    expect(failure.schemaIssues).toEqual([expect.objectContaining({ issueCode: 'JSON_INVALID', path: 'arguments' })])
    expect(JSON.stringify(failure)).not.toContain('private-content')
    const postJson = vi.fn(async () => ({ id: 'valid', status: 'completed', output: [{ type: 'function_call', call_id: 'call', name: 'submitAgentPlan', arguments: JSON.stringify({ summary: '理解', response: '好的', nextAction: null, tools: [] }) }] }))
    const planner = new ArkAgentPlanner({ protocol: new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture' }), http: { postJson }, assets: { resolveAsset: async () => { throw Error('unused') } }, timeoutMs: 2000, transport: { mode: 'buffered', connectTimeoutMs: 2000, firstEventTimeoutMs: 2000, idleTimeoutMs: 2000 } })
    const request = { text: '聊聊构图', selectedIds: [], selectedElements: [], attachments: [], autoGenerate: false, ephemeralAnnotation: null, activeGenerationJobId: null, sceneSummary: { revision: 0, canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' }, elementCount: 0, elements: [] } } satisfies AgentRequest
    await planner.plan(request, new AbortController().signal, failure)
    expect(postJson).toHaveBeenCalledOnce()
    expect(JSON.stringify(postJson.mock.calls)).toContain('JSON_INVALID')
    expect(JSON.stringify(postJson.mock.calls)).toContain('禁止注释、尾逗号')
    expect(JSON.stringify(postJson.mock.calls)).not.toContain('private-content')
    postJson.mockResolvedValueOnce({ id: 'unsupported', status: 'completed', output: [{ type: 'function_call', call_id: 'call', name: 'submitAgentPlan', arguments: JSON.stringify({ summary: '布局', response: '布局', nextAction: null, tools: [{ kind: 'scene.set-creative-context' }] }) }] })
    await expect(planner.plan(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'MODEL_TOOL_UNSUPPORTED',
      schemaIssues: [{ issueCode: 'UNSUPPORTED_TOOL_KIND', path: 'tools.0.kind', expected: expect.stringContaining('scene_batch.commands') }]
    })
  })
})
