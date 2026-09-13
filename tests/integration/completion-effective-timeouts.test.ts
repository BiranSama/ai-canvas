import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { AgentHarnessRepository } from '../../src/main/agent/agent-harness-repository'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import { generationProfileRequestSchema, type GenerationJob } from '../../src/shared/generation'
import type { AgentPlan } from '../../src/shared/agent'
import { formatTimeLimit, generationTiming } from '../../src/shared/execution-timing'
import { projectAgentExecutionFlow } from '../../src/renderer/src/agent/agent-execution-flow'
import { SceneService } from '../../src/main/scene'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('') } }))
const runtimes: GenerationRuntime[] = []
afterEach(async () => { vi.useRealTimers(); for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function until(check: () => Promise<boolean>, label: string) {
  for (let index = 0; index < 250; index++) { if (await check()) return; await realDelay(4) }
  throw new Error(`Timed fixture did not settle: ${label}`)
}
async function fixture(limitMs = 10_000) {
  const root = await mkdtemp(join(tmpdir(), 'time-'))
  const runtime = await GenerationRuntime.create(root); runtimes.push(runtime)
  const create = AgentHarnessRepository.prototype.createGoal
  vi.spyOn(AgentHarnessRepository.prototype, 'createGoal').mockImplementation(function (this: AgentHarnessRepository, threadId, input) {
    return create.call(this, threadId, { ...input, budget: { ...input.budget, maxWallTimeMs: limitMs } })
  })
  const network = vi.fn(() => { throw new Error('OFFLINE_TIME_BOUNDARY') }); vi.stubGlobal('fetch', network)
  return { root, runtime, network }
}
function input(runtime: GenerationRuntime, text: string) {
  const { scene, projectId } = runtime.getWorkspaceBootstrap()
  return { projectId, text, sceneSummary: { revision: scene.revision, canvas: scene.canvas, elementCount: scene.elements.length, elements: [] },
    selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }
}
function scenePlan(runtime: GenerationRuntime): AgentPlan {
  return { summary: '需要审阅的修改', response: '调整画布风格', nextAction: null,
    tools: [{ kind: 'scene_batch', summary: '调整背景', commands: [{ kind: 'scene.set-canvas', canvas: { ...runtime.getWorkspaceBootstrap().scene.canvas, globalStyle: 'reviewed-style' } }] }] }
}
async function waitingDecision(runtime: GenerationRuntime) {
  await runtime.startAgentRun(input(runtime, '将画布背景调整为安静的灰蓝色，先不要生成图片'), 'review')
  await until(async () => (await runtime.getAgentHarnessSnapshot()).turns[0]?.status === 'waiting_decision', 'waiting_decision')
  return (await runtime.getAgentHarnessSnapshot()).turns[0]!
}

it('enforces the persisted Turn deadline while waiting for a decision and never executes a late approval', async () => {
  const h = await fixture()
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(scenePlan(h.runtime))
  const before = h.runtime.getWorkspaceBootstrap().scene
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const turn = await waitingDecision(h.runtime)
  expect(turn.timeLimitMs).toBe(10_000)
  await vi.advanceTimersByTimeAsync(9_999)
  expect((await h.runtime.getAgentHarnessSnapshot()).turns[0]?.status).toBe('waiting_decision')
  await vi.advanceTimersByTimeAsync(1)
  await until(async () => (await h.runtime.getAgentHarnessSnapshot()).turns[0]?.status === 'budget_limited', 'Turn deadline')
  const snapshot = await h.runtime.getAgentHarnessSnapshot()
  expect(snapshot.turns[0]).toMatchObject({ createdAt: turn.createdAt, timeLimitMs: 10_000, errorCode: 'BUDGET_WALL_TIME' })
  await expect(h.runtime.confirmAgentRun(turn.inputMessageId!)).rejects.toThrow()
  expect(h.runtime.getWorkspaceBootstrap().scene).toEqual(before)
  expect(projectAgentExecutionFlow(snapshot, turn.id)?.headline).toBe('本轮时限已到')
  expect(h.network).not.toHaveBeenCalled()
})

it('restores only the remaining decision time after restart, including when a new runtime has other defaults', async () => {
  const h = await fixture()
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(scenePlan(h.runtime))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const turn = await waitingDecision(h.runtime)
  vi.useRealTimers(); await h.runtime.close()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(Date.parse(turn.createdAt) + 8_000)
  const reopened = await GenerationRuntime.create(h.root); runtimes.push(reopened)
  expect((await reopened.getAgentHarnessSnapshot()).turns[0]).toMatchObject({ timeLimitMs: 10_000, createdAt: turn.createdAt, status: 'waiting_decision' })
  await vi.advanceTimersByTimeAsync(1_999)
  expect((await reopened.getAgentHarnessSnapshot()).turns[0]?.status).toBe('waiting_decision')
  await vi.advanceTimersByTimeAsync(1)
  await until(async () => (await reopened.getAgentHarnessSnapshot()).turns[0]?.status === 'budget_limited', 'restored deadline')
  expect(h.network).not.toHaveBeenCalled()
})

it('stops the Agent at its deadline while the already submitted Job retains its independent limit and observable result', async () => {
  const h = await fixture()
  const path = join(h.root, 'deferred-result.png')
  await sharp({ create: { width: 128, height: 128, channels: 4, background: '#c6d0db' } }).png().toFile(path)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(MockImageProvider.prototype, 'generate').mockImplementation(async (_request, context) => {
    await context.onStage('submitting')
    await context.onStage('generating')
    await Promise.race([gate, new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))])
    return [{ filePath: path, mimeType: 'image/png' }]
  })
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '生成一张', response: '开始本地图片任务', nextAction: null, tools: [{ kind: 'generation', request: {
    prompt: 'Synthetic deferred image', negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 128, outputHeight: 128,
    count: 1, providerId: 'mock', model: 'mock-balanced', references: [], parameters: {}, sourceMessageId: null, parentResultId: null,
    referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' } }] })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await h.runtime.startAgentRun(input(h.runtime, '现在生成一张本地图片'), 'auto')
  await until(async () => (await h.runtime.getAgentHarnessSnapshot()).turns[0]?.status === 'waiting_job', 'waiting_job')
  const job = (await h.runtime.listJobs())[0]!
  expect(job.effectiveTimeoutMs).toBe(120_000)
  await until(async () => (await h.runtime.listJobs())[0]?.status === 'generating', 'submitted Job')
  await vi.advanceTimersByTimeAsync(10_000)
  await until(async () => (await h.runtime.getAgentHarnessSnapshot()).turns[0]?.status === 'budget_limited', 'Agent stopped')
  expect((await h.runtime.listJobs())[0]?.status).toBe('generating')
  release()
  await until(async () => (await h.runtime.listJobs())[0]?.status === 'completed', 'independent Job result')
  expect((await h.runtime.getAgentHarnessSnapshot()).turns[0]?.errorCode).toBe('BUDGET_WALL_TIME')
  expect((await h.runtime.listJobs())[0]?.results).toHaveLength(1)
  expect(h.runtime.getWorkspaceBootstrap().scene.elements).toHaveLength(0)
  expect(planner).toHaveBeenCalledTimes(1)
  expect(h.network).not.toHaveBeenCalled()
})

it('propagates 300 seconds through production construction, excludes queue wait and times out an uncertain POST without replay', async () => {
  const h = await fixture()
  await h.runtime.setProviderConfig({ id: 'image-provider', kind: 'image', label: 'Synthetic time provider', baseUrl: 'https://time.example.test/v1',
    defaultModel: 'time-model', protocol: 'openai-images', timeoutMs: 300_000, concurrency: 1,
    capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } })
  await h.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-time-key' })
  await h.runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 8, maxImagesPerJob: 1, maxCostCnyPerJob: 2 })
  const network = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })); vi.stubGlobal('fetch', network)
  const request = () => generationProfileRequestSchema.parse({ profileId: 'configured-draft', confirmed: true, operation: 'generate',
    draft: { prompt: 'Synthetic long job', negativePrompt: '', aspect: { width: 1, height: 1 }, quantity: 1, profileId: 'configured-draft',
      referenceResultIds: [], sourceSceneRevision: null, expandedSections: [] }, outputWidth: 128, outputHeight: 128 })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const first = await h.runtime.enqueueProfile(request())
  await until(async () => network.mock.calls.length === 1, 'first POST')
  const queued = await h.runtime.enqueueProfile(request())
  expect(queued.startedAt).toBeNull()
  expect(first.effectiveTimeoutMs).toBe(300_000)
  expect(generationTiming(queued).remainingMs).toBe(300_000)
  await vi.advanceTimersByTimeAsync(299_999)
  expect((await h.runtime.listJobs()).find((job) => job.id === first.id)?.status).toBe('generating')
  expect((await h.runtime.listJobs()).find((job) => job.id === queued.id)?.startedAt).toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  await until(async () => (await h.runtime.listJobs()).find((job) => job.id === first.id)?.status === 'timed_out', '300 second boundary')
  await until(async () => network.mock.calls.length === 2, 'second Job starts after queue wait')
  const current = (await h.runtime.listJobs()).find((job) => job.id === queued.id)!
  expect(generationTiming(current).remainingMs).toBe(300_000)
  const timedOut = (await h.runtime.listJobs()).find((job) => job.id === first.id)!
  expect(timedOut.cost?.actual.status).toBe('unknown')
  await expect(h.runtime.retry(first.id)).rejects.toMatchObject({ code: 'NO_REPOST' })
  expect(network).toHaveBeenCalledTimes(2)
  await h.runtime.cancel(current.id)
  expect(formatTimeLimit(current.effectiveTimeoutMs!)).toBe('5 分钟')
  expect(generationTiming({ ...timedOut, effectiveTimeoutMs: null } as GenerationJob).remainingMs).toBeNull()
})

it('does not apply an Agent scene batch that was still queued when its execution signal expired', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const save = vi.fn(async () => gate)
  const scene = createNightVeilScene()
  const service = new SceneService(scene, { save })
  const first = service.execute({ expectedSceneRevision: 0, batch: { id: '31000000-0000-4000-8000-000000008001', origin: 'user', summary: 'User write before deadline',
    commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: .8 } }] } })
  await until(async () => save.mock.calls.length === 1, 'first scene persistence')
  const controller = new AbortController()
  const second = service.execute({ expectedSceneRevision: 1, batch: { id: '31000000-0000-4000-8000-000000008002', origin: 'agent', summary: 'Expired queued Agent write',
    commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.bottle, changes: { opacity: .1 } }] } }, controller.signal)
  const rejected = expect(second).rejects.toThrow('Turn deadline expired')
  controller.abort(new Error('Turn deadline expired')); release()
  await first; await rejected
  expect(save).toHaveBeenCalledTimes(1)
  expect(service.state().scene.revision).toBe(1)
  expect(service.state().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.bottle)?.opacity)
    .toBe(scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.bottle)?.opacity)
})
