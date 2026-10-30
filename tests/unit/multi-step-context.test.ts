import { describe, expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { GENERIC_DIALECT } from '../../src/main/agent/llm/dialects'
import { ResponsesTurnProtocol } from '../../src/main/agent/llm/responses-turn'
import { checkpointText, estimateRequestTokens, estimateTextTokens } from '../../src/main/agent/multi-step/context-budget'
import { MultiStepPlannerAdapter, type MultiStepPlannerOptions } from '../../src/main/agent/multi-step/multi-step-planner'
import type { ModelTrace } from '../../src/main/agent/multi-step/trace'
import { turnModelUsage } from '../../src/shared/model-usage'
import type { PlannerInput } from '../../src/main/agent/planner-adapter'
import { agentRequestSchema } from '../../src/shared/agent'
import type { LlmPricing } from '../../src/shared/model-usage'
import type { AgentItem } from '../../src/shared/agent-harness'

type Item = Record<string, unknown>
const PROJECT = '00000000-0000-4000-8000-000000000001'
const NOW = '2026-10-18T00:00:00.000Z'

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

const REPLY = [{ type: 'message', content: [{ type: 'output_text', text: '好了。' }] }]

/** A model that keeps looking at the title, one inspect call per response. */
function inspecting(count: number): unknown[] {
  return [{ type: 'function_call', id: `fc_${count}`, call_id: `i${count}`, name: 'inspect', arguments: '{"targets":["E1"]}', status: 'completed' }]
}

function planner(requests: Item[], options: Partial<MultiStepPlannerOptions> = {}, pricing: LlmPricing | null = null, reply: (count: number) => unknown[] = () => REPLY): MultiStepPlannerAdapter {
  const scene = createScene({ id: uuid(2), projectId: PROJECT, now: NOW })
  return new MultiStepPlannerAdapter({
    scene: () => scene,
    generation: async () => null,
    model: async () => ({
      protocol: new ResponsesTurnProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'house-model', dialect: GENERIC_DIALECT, vision: false, streaming: false }),
      http: {
        postLlmJson: async (request) => {
          requests.push(request.body as Item)
          return {
            id: `r${requests.length}`, status: 'completed', output: reply(requests.length),
            usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 4_000 }, output_tokens: 1_000 }
          }
        },
        postEventStream: async () => { throw new Error('not used') }
      },
      transport: { mode: 'buffered', connectTimeoutMs: 5_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      label: 'Fixture',
      protocolId: 'openai-responses',
      endpoint: 'https://llm.example.test/v1/responses',
      pricing
    }),
    ...options
  })
}

function step(callId: string): ModelTrace['assistants'][number] {
  return {
    parts: [{ type: 'tool_call', call: { callId, name: 'inspect', argumentsText: '{"targets":["E1"]}', arguments: { targets: ['E1'] }, argumentsError: null } }],
    native: null
  }
}

function result(callId: string): ModelTrace['results'][number] {
  return { callId, name: 'inspect', isError: false, content: [{ type: 'text', text: `成功：查看了 ${callId}\n- 细节` }] }
}

function planItem(ordinal: number, trace: Partial<ModelTrace>): AgentItem {
  return {
    id: uuid(100 + ordinal), threadId: uuid(3), turnId: uuid(4), type: 'plan', status: 'completed', ordinal, payloadVersion: 1,
    payload: {
      plan: null,
      step: { kind: 'complete', trace: { version: 1, promptVersion: 'test', refs: {}, assistants: [], results: [], emitted: null, usage: [], brief: null, checkpoint: null, ...trace } }
    },
    createdAt: NOW,
    updatedAt: NOW
  }
}

function input(items: AgentItem[]): PlannerInput {
  return {
    turn: { modelTurnsUsed: 0, inputMessageId: 'message-1' } as unknown as PlannerInput['turn'],
    request: agentRequestSchema.parse({
      text: '把标题调整一下', projectId: PROJECT,
      sceneSummary: { revision: 0, canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' }, elementCount: 0, elements: [] },
      selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null
    }),
    contextManifest: null,
    items,
    stepIndex: items.length,
    activePlan: null,
    nextToolIndex: 0
  }
}

function inputItems(body: Item): Item[] {
  return body.input as Item[]
}

describe('multi-step context', () => {
  it('stores the brief on the first pass and sends that text again on later passes', async () => {
    const requests: Item[] = []
    const first = await planner(requests).next(input([]), new AbortController().signal)
    const brief = (first.step.trace as ModelTrace).brief
    expect(brief).toContain('当前画布')
    expect(JSON.stringify(inputItems(requests[0]!)[0])).toContain('当前画布')

    const later = await planner(requests).next(input([planItem(1, { brief: 'BRIEF-AT-START', assistants: [step('c1')], results: [result('c1')] })]), new AbortController().signal)
    const opening = JSON.stringify(inputItems(requests[1]!)[0])
    expect(opening).toContain('BRIEF-AT-START')
    expect(opening).not.toContain('当前画布')
    // Only the pass that wrote it stores it.
    expect((later.step.trace as ModelTrace).brief).toBeNull()
  })

  it('continues from a stored checkpoint without the steps it replaced', async () => {
    const requests: Item[] = []
    await planner(requests).next(input([
      planItem(1, { brief: 'BRIEF-AT-START', assistants: [step('c1'), step('c2')], results: [result('c1'), result('c2')] }),
      planItem(2, { checkpoint: { assistants: 2, text: 'CHECKPOINT-TEXT' }, assistants: [step('c3')], results: [result('c3')] })
    ]), new AbortController().signal)
    const sent = inputItems(requests[0]!)
    expect(JSON.stringify(sent[0])).toContain('CHECKPOINT-TEXT')
    expect(sent.slice(1).map((item) => [item.type, item.call_id])).toEqual([['function_call', 'c3'], ['function_call_output', 'c3']])
    expect(JSON.stringify(sent)).not.toMatch(/BRIEF-AT-START|"c1"|"c2"/)
  })

  it('writes a checkpoint once enough steps push the estimate over the limit', async () => {
    const steps = ['c1', 'c2', 'c3', 'c4']
    const requests: Item[] = []
    const items = [planItem(1, { brief: 'BRIEF-AT-START', assistants: steps.map(step), results: steps.map(result) })]
    const done = await planner(requests, { checkpointTokens: 1 }).next(input(items), new AbortController().signal)
    const sent = inputItems(requests[0]!)
    expect(sent).toHaveLength(1)
    const text = JSON.stringify(sent[0])
    expect(text).toContain('当前画布')
    expect(text).toContain('这一轮已经做了 4 步')
    expect(text).toContain('inspect({\\"targets\\":[\\"E1\\"]}) → 成功：查看了 c4')
    expect((done.step.trace as ModelTrace).checkpoint).toMatchObject({ assistants: 4 })

    // Fewer new steps than the minimum keep the transcript as it is.
    const short: Item[] = []
    await planner(short, { checkpointTokens: 1 }).next(input([planItem(1, { brief: 'BRIEF-AT-START', assistants: steps.slice(0, 3).map(step), results: steps.map(result) })]), new AbortController().signal)
    expect(inputItems(short[0]!)).toHaveLength(7)
  })

  it('estimates Chinese text per character and other text per few characters', () => {
    expect(estimateTextTokens('标题字号')).toBe(4)
    expect(estimateTextTokens('a'.repeat(35))).toBe(10)
    expect(estimateRequestTokens({ system: '', tools: [], messages: [{ role: 'user', parts: [{ type: 'image', image: { mimeType: 'image/png', base64: 'AA==' } }] }] })).toBeGreaterThanOrEqual(1_600)
  })

  it('lists only the latest calls when a turn made very many', () => {
    const many = Array.from({ length: 45 }, (_value, index) => `c${index + 1}`)
    const text = checkpointText({ brief: 'BRIEF', assistants: many.map(step), results: new Map(many.map((id) => [id, result(id)])) })
    expect(text).toContain('这一轮已经做了 45 步')
    expect(text).toContain('只列出最近 40 步')
    expect(text).not.toContain('查看了 c5\n')
    expect(text).toContain('查看了 c45')
  })

  it('records calls and an estimated cost per pass and sums them for the turn', async () => {
    const signal = new AbortController().signal
    const priced = (await planner([], {}, { inputPerMillionCny: 2, cachedInputPerMillionCny: 0.5, outputPerMillionCny: 8 }).next(input([]), signal)).step.trace as ModelTrace
    // (6,000 uncached × 2 + 4,000 cached × 0.5 + 1,000 output × 8) per million tokens.
    expect(priced).toMatchObject({ modelCalls: 1, costCny: 0.022 })
    const unpriced = (await planner([]).next(input([]), signal)).step.trace as ModelTrace
    expect(unpriced).toMatchObject({ modelCalls: 1, costCny: null })

    expect(turnModelUsage([planItem(1, priced), planItem(2, priced)])).toEqual({
      calls: 2, inputTokens: 20_000, cachedInputTokens: 8_000, outputTokens: 2_000, estimatedCostCny: 0.044
    })
    expect(turnModelUsage([planItem(1, priced), planItem(2, unpriced)])?.estimatedCostCny).toBeNull()
    // A pass that made no call, such as one resuming an approved step, changes nothing.
    expect(turnModelUsage([planItem(1, priced), planItem(2, {})])).toMatchObject({ calls: 1, estimatedCostCny: 0.022 })
    expect(turnModelUsage([])).toBeNull()
  })

  it('hands a long run of read-only calls back to the loop, with its calls and usage kept, so the guards are checked', async () => {
    const signal = new AbortController().signal
    const requests: Item[] = []
    const result = await planner(requests, {}, null, inspecting).next(input([]), signal)
    expect(result.step.kind).toBe('progress')
    expect(result.modelTurns).toBe(8)
    const trace = result.step.trace as ModelTrace
    expect(trace).toMatchObject({ modelCalls: 8 })
    expect(trace.usage).toHaveLength(8)
    expect(trace.assistants).toHaveLength(8)
    // The stored record is a valid trace, so the next pass carries on from it.
    expect(turnModelUsage([planItem(1, trace)])).toMatchObject({ calls: 8 })
  })

  it('stops a pass once its estimated spend reaches what the turn has left before its cost cap', async () => {
    const signal = new AbortController().signal
    const requests: Item[] = []
    // Each call is estimated at ¥0.022; the turn has ¥0.03 left.
    const result = await planner(requests, {}, { inputPerMillionCny: 2, cachedInputPerMillionCny: 0.5, outputPerMillionCny: 8 }, inspecting)
      .next({ ...input([]), costLeftCny: 0.03 }, signal)
    expect(result.step.kind).toBe('progress')
    expect(requests).toHaveLength(2)
    expect(result.step.trace).toMatchObject({ modelCalls: 2, costCny: 0.044 })
  })
})
