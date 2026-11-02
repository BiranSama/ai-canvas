import { expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { GENERIC_DIALECT } from '../../src/main/agent/llm/dialects'
import { ResponsesTurnProtocol } from '../../src/main/agent/llm/responses-turn'
import { MultiStepPlannerAdapter, type MultiStepModel } from '../../src/main/agent/multi-step/multi-step-planner'
import type { ModelTrace } from '../../src/main/agent/multi-step/trace'
import type { PlannerInput } from '../../src/main/agent/planner-adapter'
import { ArkHttpError } from '../../src/main/security/ark-http-client'
import { agentRequestSchema } from '../../src/shared/agent'

type Item = Record<string, unknown>
const PROJECT = '00000000-0000-4000-8000-000000000001'
const NOW = '2026-10-18T00:00:00.000Z'
const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const reply = (text: string): unknown[] => [{ type: 'message', content: [{ type: 'output_text', text }] }]
const usage = { input_tokens: 1_000, output_tokens: 100 }

function model(label: string, answer: (body: Item, count: number) => unknown, extra: Partial<MultiStepModel> & { readonly vision?: MultiStepModel | null; readonly sees?: boolean } = {}): MultiStepModel & { readonly requests: Item[] } {
  const requests: Item[] = []
  const { sees, ...rest } = extra
  return {
    requests,
    protocol: new ResponsesTurnProtocol({ baseUrl: 'https://llm.example.test/v1', model: label, dialect: GENERIC_DIALECT, vision: sees ?? false, streaming: false }),
    http: {
      postLlmJson: async (request) => {
        requests.push(request.body as Item)
        return answer(request.body as Item, requests.length)
      },
      postEventStream: async () => { throw new Error('not used') }
    },
    transport: { mode: 'buffered', connectTimeoutMs: 5_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
    timeoutMs: 30_000,
    maxOutputTokens: 8_192,
    label,
    protocolId: 'openai-responses',
    endpoint: 'https://llm.example.test/v1/responses',
    ...rest
  }
}

function input(): PlannerInput {
  return {
    turn: { id: uuid(4), threadId: uuid(3), modelTurnsUsed: 0, inputMessageId: 'message-1' } as unknown as PlannerInput['turn'],
    request: agentRequestSchema.parse({
      text: '看看画面有什么问题', projectId: PROJECT,
      sceneSummary: { revision: 0, canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' }, elementCount: 0, elements: [] },
      selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null
    }),
    contextManifest: null,
    items: [],
    stepIndex: 0,
    activePlan: null,
    nextToolIndex: 0
  }
}

function planner(main: MultiStepModel, looker = false): MultiStepPlannerAdapter {
  const scene = createScene({ id: uuid(2), projectId: PROJECT, now: NOW })
  return new MultiStepPlannerAdapter({
    scene: () => scene,
    generation: async () => null,
    model: async () => main,
    ...(looker ? { looker: { look: async () => ({ mimeType: 'image/png' as const, base64: 'iVBORw0KGgo=' }) } } : {})
  })
}

it('sends a request the main model could not take to the backup, and says so on the receipt', async () => {
  const backup = model('backup-model', () => ({ id: 'b1', status: 'completed', output: reply('好了，标题已经检查过。'), usage }), { pricing: { inputPerMillionCny: 10, cachedInputPerMillionCny: null, outputPerMillionCny: 10 }, providerId: 'text-model-backup' })
  const main = model('main-model', () => { throw new ArkHttpError('PROVIDER_RATE_LIMITED', '请求太频繁', 429, 'application/json') }, { backup, pricing: { inputPerMillionCny: 1, cachedInputPerMillionCny: null, outputPerMillionCny: 1 } })
  const result = await planner(main).next(input(), new AbortController().signal)
  expect(main.requests).toHaveLength(1)
  expect(backup.requests).toHaveLength(1)
  expect(backup.requests[0]!.model).toBe('backup-model')
  expect(result.step).toMatchObject({ kind: 'complete', assessment: { status: 'completed_with_notes', summary: '好了，标题已经检查过。' } })
  const notes = (result.step as { assessment: { notes: string[] } }).assessment.notes
  expect(notes.join('')).toContain('备用模型（backup-model）')
  // Priced at the backup's rates: 1,000 in and 100 out at ¥10 per million each.
  expect((result.step.trace as ModelTrace).costCny).toBeCloseTo(0.011, 6)
})

it('does not hide a key or request problem behind the backup', async () => {
  const backup = model('backup-model', () => ({ id: 'b1', status: 'completed', output: reply('不该到这里'), usage }))
  const main = model('main-model', () => { throw new ArkHttpError('PROVIDER_AUTH_FAILED', 'Key 无效', 401, 'application/json') }, { backup })
  await expect(planner(main).next(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' })
  expect(backup.requests).toHaveLength(0)
})

it('lets a model that cannot see look through the vision model, and counts that call', async () => {
  const vision = model('vision-model', (body) => {
    expect(JSON.stringify(body.input)).toContain('data:image/png;base64,')
    return { id: 'v1', status: 'completed', output: reply('标题在左上角，和人物有一点重叠。'), usage }
  }, { sees: true, providerId: 'text-model-vision' })
  const main = model('main-model', (body, count) => count === 1
    ? { id: 'm1', status: 'completed', output: [{ type: 'function_call', id: 'fc_1', call_id: 'look1', name: 'look', arguments: '{}', status: 'completed' }], usage }
    : (() => {
        expect(JSON.stringify(body.input)).toContain('看图模型看到的是：标题在左上角，和人物有一点重叠。')
        expect(JSON.stringify(body.input)).not.toContain('data:image/png')
        return { id: 'm2', status: 'completed', output: reply('标题和人物重叠了，我建议挪一下。'), usage }
      })(), { vision })
  const result = await planner(main, true).next(input(), new AbortController().signal)
  expect(vision.requests).toHaveLength(1)
  expect(main.requests).toHaveLength(2)
  expect(result.step).toMatchObject({ kind: 'complete', assessment: { summary: '标题和人物重叠了，我建议挪一下。' } })
  expect((result.step.trace as ModelTrace).modelCalls).toBe(3)
})
