import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { AgentContextRepository, AgentHarnessRepository, PersistentAgentLoop } from '../../src/main/agent'
import { GENERIC_DIALECT } from '../../src/main/agent/llm/dialects'
import { ResponsesTurnProtocol } from '../../src/main/agent/llm/responses-turn'
import { MultiStepPlannerAdapter } from '../../src/main/agent/multi-step/multi-step-planner'
import { SceneLooker } from '../../src/main/agent/multi-step/scene-looker'
import { SCREENSHOT_QUESTION } from '../../src/main/agent/tools/look'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { agentRequestSchema } from '../../src/shared/agent'

type Item = Record<string, unknown>
const roots: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function ids(start: number): () => string {
  let value = start
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

async function fixture(startId: number) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-screenshot-review-'))
  roots.push(root)
  const next = ids(startId)
  const directory = join(root, 'review.aicanvas')
  const opened = await ProjectWorkspace.create(directory, 'Screenshot review', { idFactory: next })
  const projectId = opened.workspace.metadata.id
  const harness = new AgentHarnessRepository(join(directory, 'project.db'), { idFactory: next })
  const context = new AgentContextRepository(join(directory, 'project.db'), { idFactory: next })
  await context.setOutboundPolicy(projectId, { policy: 'review_each_image', expectedVersion: 1 })
  const requests: Item[] = []
  const scene = createScene({ id: next(), projectId, now: new Date().toISOString() })
  const planner = new MultiStepPlannerAdapter({
    scene: () => scene,
    generation: async () => null,
    looker: new SceneLooker(async () => null),
    model: async () => ({
      protocol: new ResponsesTurnProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'house-model', dialect: GENERIC_DIALECT, vision: true, streaming: false }),
      http: {
        postLlmJson: async (request) => {
          requests.push(request.body as Item)
          await request.observe?.({ phase: 'connecting', elapsedMs: 0, lastTransportActivityAt: null, lastSemanticProgressAt: null, receivedBytes: 0, recognizedEventCount: 0, providerResponseId: null, httpStatus: null, failureCode: null })
          const output = requests.length === 1
            ? [{ type: 'function_call', call_id: 'l1', name: 'look', arguments: '{}' }]
            : [{ type: 'message', content: [{ type: 'output_text', text: '看过了，画面还是空的。' }] }]
          return { id: `r${requests.length}`, status: 'completed', output }
        },
        postEventStream: async () => { throw new Error('not used') }
      },
      transport: { mode: 'buffered', connectTimeoutMs: 5_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      label: 'Fixture',
      protocolId: 'openai-responses',
      endpoint: 'https://llm.example.test/v1/responses'
    })
  })
  const loop = new PersistentAgentLoop({
    projectId,
    repository: harness,
    contextRepository: context,
    planner,
    executeTool: async () => { throw new Error('no tool should run') },
    loadRequest: async () => request(projectId),
    allowedTools: ['scene.get_summary', 'scene.get_elements', 'scene.apply_batch']
  })
  await loop.initialize()
  closers.push(async () => {
    await loop.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return { loop, harness, context, projectId, requests, next }
}

function request(projectId: string) {
  return agentRequestSchema.parse({
    text: '看看画面', projectId,
    sceneSummary: { revision: 0, canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' }, elementCount: 0, elements: [] },
    selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null
  })
}

function images(body: Item): number {
  return JSON.stringify(body.input).split('"input_image"').length - 1
}

async function answer(value: Awaited<ReturnType<typeof fixture>>, optionId: string) {
  const turn = await value.loop.start({ legacyRunId: value.next(), sourceMessageId: 'message-1', request: request(value.projectId) })
  await value.loop.waitForIdle()
  const decision = (await value.harness.listTurnItems(turn.id)).find((item) => item.type === 'decision' && item.status === 'waiting')
  expect((decision?.payload as { proposal: { title: string } }).proposal.title).toBe(SCREENSHOT_QUESTION)
  expect(value.requests).toHaveLength(1)
  await value.loop.resolveDecision(turn.id, decision!.id, optionId)
  await value.loop.waitForIdle()
  return (await value.loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)!
}

describe('screenshots under per-image review', () => {
  it('asks once before the first screenshot and sends it after approval', async () => {
    const value = await fixture(41_000)
    const turn = await answer(value, 'option-1')
    expect(turn.status).toBe('completed')
    expect(value.requests).toHaveLength(2)
    expect(images(value.requests[1]!)).toBe(1)
    expect(await value.context.listOutboundRecords(value.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ policy: 'review_each_image', status: 'sent', imageCount: 1 })
    ]))
  })

  it('describes the layout in words when the person declines', async () => {
    const value = await fixture(42_000)
    const turn = await answer(value, 'option-2')
    expect(turn.status).toBe('completed')
    expect(images(value.requests[1]!)).toBe(0)
    expect(JSON.stringify(value.requests[1]!.input)).toContain('用户这一轮不发送截图')
  })
})
