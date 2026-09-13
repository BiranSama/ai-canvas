import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { GenerationQueue } from '../../src/main/generation/generation-queue'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { isTerminalAgentTurnStatus } from '../../src/shared/agent-harness'
import { PersistentAgentLoop } from '../../src/main/agent/persistent-agent-loop'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import type { AgentPlan } from '../../src/shared/agent'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

it.each(['active-without-id', 'completed-awaiting-observer'] as const)(
  'reconciles a real Main crash snapshot: %s', async (phase) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'crash-source-'))
    const restoredRoot = await mkdtemp(join(tmpdir(), 'crash-restored-'))
    roots.push(sourceRoot, restoredRoot)
    const network = vi.fn(() => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
    vi.stubGlobal('fetch', network)
    const makeTool = (prompt: string): AgentPlan['tools'][number] => ({ kind: 'generation', request: {
      prompt, negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 128, outputHeight: 128,
      count: 1, providerId: 'mock', model: 'mock-balanced', references: [], parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 },
      sourceMessageId: null, parentResultId: null, referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
    } })
    vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '恢复原计划', response: '已完成两次本地生成', nextAction: null,
      tools: [makeTool('Original A'), makeTool('Following B')] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let captured = false
    const generate = MockImageProvider.prototype.generate
    const providerSpy = vi.spyOn(MockImageProvider.prototype, 'generate').mockImplementation(async function (this: MockImageProvider, request, context) {
      if (phase === 'active-without-id' && request.prompt === 'Original A') {
        await context.onStage('generating')
        captured = true
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return generate.call(this, request, context)
    })
    const observe = PersistentAgentLoop.prototype.observeGenerationJob
    const observerSpy = vi.spyOn(PersistentAgentLoop.prototype, 'observeGenerationJob').mockImplementation(async function (this: PersistentAgentLoop, job) {
      if (phase === 'completed-awaiting-observer' && job.status === 'completed' && job.request.prompt === 'Original A' && !captured) {
        captured = true
        await gate
      }
      return observe.call(this, job)
    })
    const runtime = await GenerationRuntime.create(sourceRoot)
    let restored: GenerationRuntime | undefined
    try {
      const scene = runtime.getWorkspaceBootstrap().scene
      await runtime.startAgentRun({ text: '连续生成两张本地图片', sceneSummary: { revision: scene.revision, canvas: scene.canvas,
        elementCount: 0, elements: [] }, selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null,
        autoGenerate: false, activeGenerationJobId: null }, 'auto')
      await expect.poll(() => captured).toBe(true)
      await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns[0]?.status).toBe('waiting_job')
      const original = (await runtime.listJobs())[0]!
      expect(original.status).toBe(phase === 'active-without-id' ? 'generating' : 'completed')
      const sourceDirectory = join(sourceRoot, 'projects', 'Untitled.aicanvas')
      const restoredDirectory = join(restoredRoot, 'projects', 'Untitled.aicanvas')
      await mkdir(restoredDirectory, { recursive: true })
      const snapshot = new Database(join(sourceDirectory, 'project.db'))
      await snapshot.backup(join(restoredDirectory, 'project.db'))
      snapshot.close()
      await cp(join(sourceDirectory, 'assets'), join(restoredDirectory, 'assets'), { recursive: true })
      // The restart reads the exact database snapshot, not manually edited rows.
      release()
      await runtime.close()
      providerSpy.mockRestore()
      observerSpy.mockRestore()
      const restartedGenerate = vi.spyOn(MockImageProvider.prototype, 'generate')
      restored = await GenerationRuntime.create(restoredRoot)
      const resumedRuntime = restored
      await expect.poll(async () => (await resumedRuntime.getAgentHarnessSnapshot()).turns[0]?.status, { timeout: 4_000 })
        .toBe(phase === 'active-without-id' ? 'failed' : 'completed')
      const jobs = await resumedRuntime.listJobs()
      if (phase === 'active-without-id') {
        expect(jobs).toHaveLength(1)
        expect(jobs[0]).toMatchObject({ id: original.id, status: 'interrupted', error: { code: 'APP_INTERRUPTED' } })
        expect(restartedGenerate).not.toHaveBeenCalled()
      } else {
        expect(jobs).toHaveLength(2)
        expect(jobs.every((job) => job.status === 'completed' && job.results.length === 1)).toBe(true)
        expect(restartedGenerate).toHaveBeenCalledTimes(1)
        expect(restartedGenerate.mock.calls[0]?.[0].prompt).toBe('Following B')
      }
      expect(network).not.toHaveBeenCalled()
    } finally { release(); await runtime.close(); await restored?.close() }
  }
)

it.each(['mock-balanced', 'mock-failure'])('handles a real %s Job that finishes before its Agent wait can be installed', async (model) => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-race-'))
  roots.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  vi.stubGlobal('fetch', network)
  const runtime = await GenerationRuntime.create(root)
  const originalPrepare = GenerationQueue.prototype.prepare
  let waitForQueue: (() => Promise<void>) | undefined
  const activate = GenerationQueue.prototype.activate
  vi.spyOn(GenerationQueue.prototype, 'prepare').mockImplementation(async function (this: GenerationQueue, ...args) {
    waitForQueue = this.waitForIdle.bind(this)
    const job = await originalPrepare.apply(this, args)
    // Deliberately cross the normally protected barrier, using the real Queue
    // and local provider, so the loop must handle an already-observed terminal.
    await activate.call(this, job.id)
    await this.waitForIdle()
    return job
  })
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '终态竞态', response: '已观察结果', nextAction: null, tools: [{
    kind: 'generation', request: { prompt: 'Actual local provider race', negativePrompt: '', aspectWidth: 1, aspectHeight: 1,
      outputWidth: 128, outputHeight: 128, count: 1, providerId: 'mock', model, references: [],
      parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 }, sourceMessageId: null, parentResultId: null,
      referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' }
  }] })
  try {
    const scene = runtime.getWorkspaceBootstrap().scene
    await runtime.startAgentRun({ text: '直接生成一张本地图片', sceneSummary: { revision: scene.revision, canvas: scene.canvas,
      elementCount: 0, elements: [] }, selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null,
      autoGenerate: false, activeGenerationJobId: null }, 'auto')
    await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns.every((turn) => isTerminalAgentTurnStatus(turn.status)),
      { timeout: 3_000 }).toBe(true)
    const terminal = await runtime.getAgentHarnessSnapshot()
    expect(terminal.turns[0], JSON.stringify({ turns: terminal.turns, jobs: await runtime.listJobs() }))
      .toMatchObject({ status: model === 'mock-failure' ? 'failed' : 'completed' })
    await waitForQueue?.()
    const jobs = await runtime.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.results).toHaveLength(model === 'mock-failure' ? 0 : 1)
    const harness = await runtime.getAgentHarnessSnapshot()
    expect(harness.turns.every((turn) => isTerminalAgentTurnStatus(turn.status))).toBe(true)
    expect(harness.items.filter((item) => item.type === 'generation_subscription' && item.status === 'waiting')).toHaveLength(0)
    expect(network).not.toHaveBeenCalled()
  } finally { await runtime.close() }
})
