import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVAL_ENV,
  MultiStepEvalEngine,
  agentEvalCaseSchema,
  loadEvalModelConfig,
  runAgentEval,
  type AgentEvalCase,
  type AgentEvalCaseInput
} from '../../src/main/agent/eval'
import { AGENT_EVAL_CASES } from '../agent-eval/cases'
import { AGENT_EVAL_SCENES } from '../agent-eval/scenes'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SECRET = 'sk-multi-step-fixture-0123456789'
const ENV = {
  [EVAL_ENV.baseUrl]: 'https://llm.eval-fixture.test/v1',
  [EVAL_ENV.model]: 'fixture-model',
  [EVAL_ENV.protocol]: 'openai-responses',
  [EVAL_ENV.apiKey]: SECRET,
  [EVAL_ENV.transport]: 'buffered'
}

type Item = Record<string, unknown>

function call(id: string, name: string, args: unknown): Item {
  return { id: `fc_${id}`, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' }
}

function response(output: Item[], id: string): Response {
  return new Response(JSON.stringify({ id, status: 'completed', output, usage: { input_tokens: 1_000, output_tokens: 100 } }), {
    headers: { 'content-type': 'application/json' }
  })
}

/** A model that lays out a poster in three steps, deciding each step from the results it has seen. */
function scriptedModel(requests: Item[]) {
  return vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://llm.eval-fixture.test/v1/responses')
    const body = JSON.parse(String(init?.body)) as Item
    requests.push(body)
    const outputs = (body.input as Item[]).filter((item) => item.type === 'function_call_output').length
    if (outputs === 0) {
      return response([
        { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-step-1' },
        call('c1', 'set_canvas', { ratio: '4:5', background: '#F1EFEA' }),
        call('c2', 'add_subject', { subject: '磨砂玻璃香水瓶', box: [25, 40, 50, 48] })
      ], 'resp-1')
    }
    if (outputs === 2) {
      return response([
        call('c3', 'add_text', { content: '晨雾', role: 'title' }),
        call('c4', 'inspect', { targets: ['E2'] })
      ], 'resp-2')
    }
    return response([
      { id: 'msg_3', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '做好了：4:5 画布，香水瓶在画面中下部，标题「晨雾」在上方留白处。' }] }
    ], 'resp-3')
  })
}

describe('multi-step agent engine', () => {
  it('builds a poster one small tool at a time and sends every result back to the model', async () => {
    const requests: Item[] = []
    const upstream = scriptedModel(requests)
    vi.stubGlobal('fetch', upstream)
    const outputDirectory = join(process.env.AI_CANVAS_TEST_BATCH_ROOT!, 'multi-step-new-layout')
    const output = await runAgentEval({
      cases: AGENT_EVAL_CASES,
      engine: new MultiStepEvalEngine(),
      scenes: AGENT_EVAL_SCENES,
      runs: 1,
      caseFilter: ['new-layout-01'],
      turnTimeoutMs: 60_000,
      mode: { kind: 'live', config: await loadEvalModelConfig(ENV, outputDirectory), record: false },
      outputDirectory
    })
    const run = output.report.cases[0]!.runs[0]!
    const observation = output.observations[0]!

    expect(upstream).toHaveBeenCalledTimes(3)
    expect(run.failureCodes).toEqual([])
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 3, toolSteps: 3 })
    expect(observation.turns.at(-1)!.replyText).toContain('标题「晨雾」')
    // The receipt reports the turn's text-model usage; the eval config sets no price, so there is no estimate.
    expect(observation.turns.at(-1)!.modelUsage).toEqual({ calls: 3, inputTokens: 3_000, cachedInputTokens: 0, outputTokens: 300, estimatedCostCny: null })

    const final = observation.scenes.final
    expect(final.canvas).toMatchObject({ aspectWidth: 4, aspectHeight: 5, backgroundColor: '#F1EFEA' })
    expect(final.elements.map((element) => element.type)).toEqual(['placeholder', 'text'])
    expect(final.elements[1]).toMatchObject({ content: '晨雾', semanticRole: 'title' })

    // Every request carries the small catalogue, never the plan schema, and no temperature.
    for (const request of requests) {
      expect((request.tools as Item[]).map((tool) => tool.name)).toContain('add_text')
      expect(JSON.stringify(request.tools)).not.toContain('submitAgentPlan')
      expect(request).not.toHaveProperty('temperature')
    }
    // The brief names the image service and its limits.
    expect(String((requests[0]!.input as Item[])[0]!.content)).toMatch(/生图服务：.+每次最多 \d 张/)
    const second = requests[1]!.input as Item[]
    // The canvas changed between steps, yet each request extends the previous one, so providers can cache it.
    expect(second[0]).toEqual((requests[0]!.input as Item[])[0])
    expect((requests[2]!.input as Item[]).slice(0, second.length)).toEqual(second)
    // The first step's output goes back unchanged, then both results in call order.
    expect(second.slice(1, 4)).toEqual([
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-step-1' },
      call('c1', 'set_canvas', { ratio: '4:5', background: '#F1EFEA' }),
      call('c2', 'add_subject', { subject: '磨砂玻璃香水瓶', box: [25, 40, 50, 48] })
    ])
    expect(second.slice(4).map((item) => [item.call_id, String(item.output).split('\n')[0]])).toEqual([
      ['c1', expect.stringMatching(/^成功：画布/)],
      ['c2', '成功：已添加主体占位「磨砂玻璃香水瓶」']
    ])
    const third = requests[2]!.input as Item[]
    const inspectResult = third.find((item) => item.type === 'function_call_output' && item.call_id === 'c4')
    expect(String(inspectResult?.output)).toContain('E2「标题·晨雾」文字')
    expect(String(third.find((item) => item.call_id === 'c3' && item.type === 'function_call_output')?.output)).toContain('新建 E2')
  }, 90_000)
})

function message(text: string): Item {
  return { id: `msg_${text.length}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
}

/** Runs one case on the multi-step engine against a model scripted by the number of results it has seen. */
async function runScripted(evalCase: AgentEvalCase | string, script: (results: number, input: Item[]) => Item[], label: string) {
  const requests: Item[] = []
  const upstream = vi.fn(async (_input: URL | string | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Item
    requests.push(body)
    const input = body.input as Item[]
    return response(script(input.filter((item) => item.type === 'function_call_output').length, input), `resp-${requests.length}`)
  })
  vi.stubGlobal('fetch', upstream)
  const outputDirectory = join(process.env.AI_CANVAS_TEST_BATCH_ROOT!, `multi-step-${label}`)
  const output = await runAgentEval({
    cases: typeof evalCase === 'string' ? AGENT_EVAL_CASES : [evalCase],
    engine: new MultiStepEvalEngine(),
    scenes: AGENT_EVAL_SCENES,
    runs: 1,
    caseFilter: typeof evalCase === 'string' ? [evalCase] : [],
    turnTimeoutMs: 60_000,
    mode: { kind: 'live', config: await loadEvalModelConfig(ENV, outputDirectory), record: false },
    outputDirectory
  })
  vi.unstubAllGlobals()
  return { requests, run: output.report.cases[0]!.runs[0]!, observation: output.observations[0]! }
}

function outputOf(request: Item, callId: string): string {
  return String((request.input as Item[]).find((item) => item.type === 'function_call_output' && item.call_id === callId)?.output)
}

function customCase(input: Partial<AgentEvalCaseInput> & Pick<AgentEvalCaseInput, 'id' | 'request'>): AgentEvalCase {
  return agentEvalCaseSchema.parse({
    category: 'safety',
    title: input.id,
    source: 'tests/integration/multi-step-agent.test.ts',
    scene: 'empty',
    limits: { maxToolSteps: 30, maxModelCalls: 20, maxSpendCny: 10 },
    assertions: [{ kind: 'paid_generation_requests', max: 0 }],
    ...input
  })
}

describe('multi-step engine decisions and corrections', () => {
  it('asks before a paid generation, waits for the job and tells the model which images it produced', async () => {
    const { requests, run, observation } = await runScripted('generate-place-01', (results) => results === 0
      ? [call('g1', 'generate', { scope: 'canvas', brief: '晨雾中的磨砂玻璃香水瓶，柔和晨光', count: 1 })]
      : [message('主视觉已经生成好了，你可以先看看效果。')], 'generate-approve')
    expect(run.failureCodes).toEqual([])
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 2 })
    expect(observation.turns.at(-1)!.decisions).toEqual([expect.objectContaining({ kind: 'generation_confirmation', approvesGeneration: true })])
    expect(outputOf(requests[1]!, 'g1')).toMatch(/生成完成，新成图：R\d+（\d+×\d+）/)
  }, 90_000)

  it('hands a declined generation back to the model instead of dropping the turn', async () => {
    const declined = customCase({
      id: 'multi-step-decline-01',
      scene: 'perfume-poster-placeholder',
      request: { text: '按现在的版式生成一张主视觉图' },
      decisions: { generation: 'decline' },
      assertions: [{ kind: 'paid_generation_requests', max: 0 }, { kind: 'generation_jobs', max: 0 }]
    })
    const { requests, run, observation } = await runScripted(declined, (results) => results === 0
      ? [call('g1', 'generate', { scope: 'canvas', brief: '晨雾主视觉', count: 1 })]
      : [message('好的，先不生成，版式保持不变。')], 'generate-decline')
    expect(run.failureCodes).toEqual([])
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 2 })
    expect(outputOf(requests[1]!, 'g1')).toContain('用户选择先不生成')
    expect(observation.turns.at(-1)!.replyText).toContain('先不生成')
  }, 90_000)

  it('stops for an ask_user question and gives the answer back as the call result', async () => {
    const asking = customCase({ id: 'multi-step-ask-01', request: { text: '做一张海报' } })
    const { requests, observation } = await runScripted(asking, (results) => results === 0
      ? [call('q1', 'ask_user', { question: '标题用中文还是英文？', options: ['中文', '英文'], recommended: 1 })]
      : results === 1
        ? [call('t1', 'add_text', { content: 'MORNING', role: 'title' })]
        : [message('按你选的英文标题做好了。')], 'ask')
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 3 })
    expect(observation.turns.at(-1)!.decisions).toEqual([expect.objectContaining({ kind: 'clarification', optionId: 'option-2' })])
    expect(outputOf(requests[1]!, 'q1')).toBe('成功：用户选择：英文')
    expect(observation.scenes.final.elements).toEqual([expect.objectContaining({ content: 'MORNING' })])
  }, 90_000)

  it('lets the model correct a rejected call within the same pass', async () => {
    const correcting = customCase({ id: 'multi-step-correct-01', request: { text: '加一个标题，再把它改成白色' } })
    const { requests, observation } = await runScripted(correcting, (results, input) => {
      if (results === 0) return [call('a1', 'add_text', { content: '晨雾', role: 'title' })]
      if (results === 1) return [call('u1', 'update', { targets: ['E9'], set: { color: '#FFFFFF' } })]
      if (results === 2) {
        expect(String(input.at(-1)?.output)).toContain('没有对象 E9')
        return [call('u2', 'update', { targets: ['E1'], set: { color: '#FFFFFF' } })]
      }
      return [message('标题已改成白色。')]
    }, 'correct')
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 4, toolSteps: 2 })
    expect(outputOf(requests[2]!, 'u1')).toMatch(/^未执行：没有对象 E9/)
    expect(observation.scenes.final.elements[0]).toMatchObject({ fill: '#FFFFFF' })
  }, 90_000)

  it('runs well past the old 8-step and 12-tool limits', async () => {
    const long = customCase({ id: 'multi-step-long-01', request: { text: '在画面上排一排 14 个色块' } })
    const { observation } = await runScripted(long, (results) => results < 14
      ? [0, 1].map((offset) => call(`s${results + offset}`, 'add_shape', { shape: 'rectangle', box: [2 + (results + offset) * 7, 45, 5, 10] }))
      : [message('14 个色块排好了。')], 'long')
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 8, toolSteps: 14 })
    expect(observation.scenes.final.elements).toHaveLength(14)
  }, 120_000)

  it('lets a long run of read-only calls finish instead of declaring the turn done after six', async () => {
    const looking = customCase({ id: 'multi-step-read-01', request: { text: '加个标题，再仔细检查几遍' } })
    const { observation } = await runScripted(looking, (results) => results === 0
      ? [call('t1', 'add_text', { content: '晨雾', role: 'title' })]
      : results < 9
        ? [call(`i${results}`, 'inspect', { targets: ['E1'] })]
        : [message('检查过了，标题位置合适。')], 'read-only')
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 10, toolSteps: 1 })
  }, 90_000)

  it('stops when the same call fails three times in a row, saying where it is stuck', async () => {
    const stuck = customCase({ id: 'multi-step-stuck-01', request: { text: '把标题改成白色' } })
    const { requests, observation } = await runScripted(stuck, () => [call(`u${Math.random()}`.replace('.', ''), 'update', { targets: ['E9'], set: { color: '#FFFFFF' } })], 'stuck')
    expect(requests).toHaveLength(3)
    // Nothing was changed, so the honest-completion check leaves the turn for the person to review.
    expect(observation.turns.at(-1)).toMatchObject({ status: 'needs_user_review', modelCalls: 3 })
    expect(observation.turns.at(-1)!.replyText).toMatch(/「update」用同样的参数连续 3 次都没成功/)
  }, 90_000)

  it('sends every screenshot of the turn again on later steps, so the transcript only grows', async () => {
    const looking = customCase({ id: 'multi-step-look-03', request: { text: '加个标题，多看几眼再定' } })
    // Looks between canvas changes: each change ends a pass, so earlier screenshots come back from the turn's store.
    const steps: Item[][] = [
      [call('l0', 'look', {})],
      [call('t1', 'add_text', { content: '晨雾', role: 'title' })],
      [call('l1', 'look', {})],
      [call('s1', 'add_shape', { shape: 'rectangle', box: [10, 80, 80, 6] })],
      [call('l2', 'look', {})],
      [message('看了三遍，标题和色条的位置都合适。')]
    ]
    const { requests } = await runScripted(looking, (results) => steps[results]!, 'look-three')
    const images = (request: Item): number => (request.input as Item[]).flatMap((item) => item.type === 'message' && Array.isArray(item.content)
      ? (item.content as Item[]).filter((part) => part.type === 'input_image')
      : []).length
    expect(requests.map(images)).toEqual([0, 1, 1, 2, 2, 3])
  }, 90_000)

  it('shows the model a rendered screenshot when it looks', async () => {
    const looking = customCase({ id: 'multi-step-look-01', request: { text: '加个标题，然后看看效果' } })
    const { requests, observation } = await runScripted(looking, (results) => results === 0
      ? [call('t1', 'add_text', { content: '晨雾', role: 'title' }), call('l1', 'look', {})]
      : [message('标题在上方，画面很干净。')], 'look')
    expect(observation.turns.at(-1)).toMatchObject({ status: 'completed', modelCalls: 2, toolSteps: 1 })
    expect(outputOf(requests[1]!, 'l1')).toContain('这是当前整张画面')
    // An unknown relay takes images only in user messages, so the screenshot follows the results.
    const shown = (requests[1]!.input as Item[]).flatMap((item) => item.type === 'message' && Array.isArray(item.content)
      ? (item.content as Item[]).filter((part) => part.type === 'input_image')
      : [])
    expect(shown).toHaveLength(1)
    const bytes = Buffer.from(String(shown[0]!.image_url).replace(/^data:image\/jpeg;base64,/, ''), 'base64')
    const metadata = await sharp(bytes).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1_024)
  }, 90_000)
})
