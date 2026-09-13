import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import { DEFAULT_AUTO_BUDGET, isTerminalAgentTurnStatus, type AgentRunBudget } from '../../src/shared/agent-harness'
import type { AgentPlan } from '../../src/shared/agent'
import { AgentHarnessRepository } from '../../src/main/agent/agent-harness-repository'
import { GenerationWorkflowRepository, GenerationWorkflowCoordinator, GenerationJobRepository } from '../../src/main/generation'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { openDatabase } from '../../src/main/storage/database'
import { GenerationQueue } from '../../src/main/generation/generation-queue'
import { ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import sharp from 'sharp'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (closers.length > 0) await closers.pop()?.()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function generate(prompt: string, count = 1): AgentPlan['tools'][number] {
  return { kind: 'generation', request: { prompt, negativePrompt: '', aspectWidth: 1, aspectHeight: 1,
    outputWidth: 128, outputHeight: 128, count, providerId: 'mock', model: 'mock-balanced', references: [],
    parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 }, sourceMessageId: null, parentResultId: null,
    referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' } }
}

it.each(['auto', 'collaboration'] as const)('uses the real %s Turn ledger across a recoverable stale Scene and a second generation plan', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'turn-budget-'))
  roots.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  vi.stubGlobal('fetch', network)
  const runtime = await GenerationRuntime.create(root)
  const scene = runtime.getWorkspaceBootstrap().scene
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan')
    .mockResolvedValueOnce({ summary: '计划一', response: '先生成再调整', nextAction: null, tools: [generate('G1'),
      { kind: 'scene_batch', summary: '按旧构图修改', commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: 'stale' } }] },
      generate('G-unstarted')] })
    .mockResolvedValue({ summary: '计划二', response: '继续两个变化', nextAction: null, tools: [generate('G2'), generate('G3')] })
  const actualGenerate = MockImageProvider.prototype.generate
  const submissions: string[] = []
  vi.spyOn(MockImageProvider.prototype, 'generate').mockImplementation(async function (this: MockImageProvider, request, context) {
    submissions.push(request.prompt)
    if (request.prompt === 'G1') {
      const mutation = await runtime.executeSceneCommands({ expectedSceneRevision: scene.revision,
        batch: { id: randomUUID(), origin: 'user', summary: '在生成中人工修改', commands: [
          { kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: 'human-kept' } }
        ] } })
      expect(mutation.ok).toBe(true)
    }
    return actualGenerate.call(this, request, context)
  })
  try {
    await runtime.startAgentRun({ text: '根据当前 4:5 作品直接生成两次本地变化', sceneSummary: { revision: scene.revision,
      canvas: scene.canvas, elementCount: 0, elements: [] }, selectedIds: [], selectedElements: [], attachments: [],
      ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }, mode)
    await expect.poll(async () => {
      const state = await runtime.getAgentHarnessSnapshot()
      return state.turns.map((turn) => isTerminalAgentTurnStatus(turn.status) ? 'terminal' : {
        status: turn.status, last: state.items.slice(-2).map((item) => ({ type: item.type, payload: item.payload }))
      })
    }, { timeout: 8_000 }).toEqual(['terminal'])
    const snapshot = await runtime.getAgentHarnessSnapshot()
    console.info(JSON.stringify({ submissions, turns: snapshot.turns.map((turn) => ({ status: turn.status, error: turn.errorCode, message: turn.errorMessage })),
      jobs: (await runtime.listJobs()).map((job) => ({ prompt: job.request.prompt, status: job.status, error: job.error })),
      failed: snapshot.items.filter((item) => item.type === 'tool_result' && item.status === 'failed').map((item) => item.payload) }))
    expect(planner).toHaveBeenCalledTimes(2)
    expect(planner.mock.calls[1]?.[0].generationBudget).toMatchObject({ jobsUsed: 1, imagesReserved: 1, jobsRemaining: 1 })
    expect(snapshot.items.some((item) => item.type === 'tool_result' && JSON.stringify(item.payload).includes('SCENE_REVISION_STALE'))).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene.canvas.globalStyle).toBe('human-kept')
    expect(submissions).toEqual(['G1', 'G2'])
    const jobs = await runtime.listJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.status === 'completed' && job.results.length === 1)).toBe(true)
    expect(snapshot.turns[0]?.status).toBe('budget_limited')
    expect(network).not.toHaveBeenCalled()
  } finally { await runtime.close() }
}, 20_000)

it('a user-triggered retry has one manual reservation while the failed Agent Turn and its consumed budget remain unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turn-manual-retry-'))
  roots.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  vi.stubGlobal('fetch', network)
  const runtime = await GenerationRuntime.create(root)
  const tool = generate('Explicit retry keeps the original request')
  if (tool.kind !== 'generation') throw new Error('Invalid fixture')
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '生成', response: '等待图片', nextAction: null,
    tools: [{ ...tool, request: { ...tool.request, model: 'mock-failure' } }] })
  try {
    const scene = runtime.getWorkspaceBootstrap().scene
    await runtime.startAgentRun({ text: '生成一张本地图片', sceneSummary: { revision: scene.revision, canvas: scene.canvas, elementCount: 0, elements: [] },
      selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }, 'auto')
    await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns[0]?.status).toBe('failed')
    const before = await runtime.getAgentHarnessSnapshot()
    const original = (await runtime.listJobs())[0]!
    expect(original.status).toBe('failed')
    const workflow = new GenerationWorkflowRepository(join(root, 'projects', 'Untitled.aicanvas', 'project.db'))
    try {
      const usage = workflow.getTurnUsage(before.turns[0]!.id)
      const retried = await runtime.retry(original.id, { model: 'mock-balanced' })
      await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === retried.id)?.status).toBe('completed')
      const intent = await workflow.getIntent(String(retried.request.parameters.workflowIntentId))
      expect(intent).toMatchObject({ turnId: null, threadId: null, toolCallItemId: null, jobId: retried.id,
        spec: { idempotencyKey: `retry:${original.id}:attempt:${retried.attempt}`, limits: { maxJobs: 1, maxImages: 1 } } })
      expect(workflow.getTurnUsage(before.turns[0]!.id)).toEqual(usage)
      expect((await runtime.getAgentHarnessSnapshot()).turns).toEqual(before.turns)
      expect((await runtime.retry(original.id, { model: 'mock-balanced' })).id).toBe(retried.id)
      expect(await runtime.listJobs()).toHaveLength(2)
      expect(network).not.toHaveBeenCalled()
    } finally { await workflow.close() }
  } finally { await runtime.close() }
})

async function ledgerFixture(overrides: Partial<AgentRunBudget> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'turn-ledger-'))
  roots.push(root)
  const opened = await ProjectWorkspace.create(join(root, 'ledger.aicanvas'), 'Synthetic budget')
  const path = join(opened.workspace.directory, 'project.db')
  const harness = new AgentHarnessRepository(path)
  const workflows = new GenerationWorkflowRepository(path)
  const jobs = new GenerationJobRepository(path)
  await jobs.listJobs(opened.workspace.metadata.id)
  closers.push(async () => { await jobs.close(); await workflows.close(); await harness.close(); await opened.workspace.close(true) })
  const thread = await harness.ensureThread(opened.workspace.metadata.id)
  const budget = { ...DEFAULT_AUTO_BUDGET, ...overrides }
  const goal = await harness.createGoal(thread.id, { objective: 'Offline turn budget', completionDefinition: ['Stay within the recorded grant'], mode: 'auto',
    scope: { canvas: true, elementIds: [], assetIds: [], providerIds: ['mock'] }, budget, permissionProfileId: null, prohibitions: [] })
  const turn = await harness.startTurn(thread.id, { goalId: goal.id, inputMessageId: null, sceneRevisionAtStart: 0 })
  const scope = { projectId: opened.workspace.metadata.id, threadId: thread.id, turnId: turn.id }
  workflows.captureTurnBudget(scope, budget, null)
  const creates: string[] = []
  const coordinator = new GenerationWorkflowCoordinator({ repository: workflows, queue: {
    enqueue: async (request) => {
      creates.push(String(request.parameters.workflowIntentId))
      return jobs.createJob({ projectId: scope.projectId, request })
    }, listJobs: () => jobs.listJobs(scope.projectId), cancel: (id) => jobs.requestCancel(id)
  } })
  const input = async (count = 1, cost = 0) => {
    const tool = generate('Offline ledger', count)
    if (tool.kind !== 'generation') throw new Error('Invalid fixture')
    const call = await harness.appendItem(turn.id, { type: 'tool_call', status: 'started', payloadVersion: 1, payload: { tool } })
    return { ...scope, toolCallItemId: call.id, request: tool.request, idempotencyKey: `tool:${call.id}`,
      capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: true,
        maxImages: 4, supportedRatios: ['custom' as const], supportedFormats: ['png' as const] },
      profileId: 'local-sketch', tier: 'local-sketch' as const, operation: 'text' as const, sourceSceneRevision: 0,
      limits: { maxJobs: 1, maxImages: 4, maxCostCny: cost, maxWallTimeMs: 120_000, noImprovementLimit: 1 }, estimatedCostCny: cost }
  }
  return { path, harness, workflows, jobs, coordinator, scope, budget, creates, input }
}

it('atomically reserves at most two unique Jobs under concurrent creation and idempotent replay', async () => {
  const value = await ledgerFixture()
  const inputs = await Promise.all([value.input(), value.input(), value.input()])
  const results = await Promise.allSettled(inputs.map((input) => value.coordinator.create(input)))
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'BUDGET_GENERATION_JOBS' } })
  expect(value.creates).toHaveLength(2)
  expect(value.workflows.getTurnUsage(value.scope.turnId)).toMatchObject({ jobs: 2, images: 2 })
  const replay = await value.coordinator.create(inputs[0]!)
  expect(replay.reused).toBe(true)
  expect(value.creates).toHaveLength(2)
  expect((await value.workflows.getReservation(replay.intent.id)).turnId).toBe(value.scope.turnId)
})

it('pauses a legacy Agent queued Job without a verifiable grant before calling its provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-turn-'))
  roots.push(root)
  vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  const runtime = await GenerationRuntime.create(root)
  const activate = vi.spyOn(GenerationQueue.prototype, 'activate').mockResolvedValue()
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '等待原任务', response: '已保存', nextAction: null, tools: [generate('Legacy job')] })
  const scene = runtime.getWorkspaceBootstrap().scene
  await runtime.startAgentRun({ text: '直接生成本地图片', sceneSummary: { revision: scene.revision, canvas: scene.canvas, elementCount: 0, elements: [] },
    selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }, 'auto')
  await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns[0]?.status).toBe('waiting_job')
  const job = (await runtime.listJobs())[0]!
  await runtime.close()
  activate.mockRestore()
  const connection = openDatabase(join(root, 'projects', 'Untitled.aicanvas', 'project.db'))
  connection.sqlite.prepare('DELETE FROM agent_generation_limits').run()
  connection.sqlite.close()
  const provider = vi.spyOn(MockImageProvider.prototype, 'generate')
  const reopened = await GenerationRuntime.create(root)
  try {
    await expect.poll(async () => (await reopened.listJobs())[0]?.status).toBe('interrupted')
    expect((await reopened.listJobs())[0]).toMatchObject({ id: job.id, error: { code: 'TURN_BUDGET_UNVERIFIED' } })
    expect(provider).not.toHaveBeenCalled()
  } finally { await reopened.close() }
})

it.each([false, true])('shares a real Main Turn allowance across text, canvas and edit tools; edit first=%s', async (editFirst) => {
  const root = await mkdtemp(join(tmpdir(), 'mixed-turn-'))
  roots.push(root)
  vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  const runtime = await GenerationRuntime.create(root)
  try {
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#9EAEB9' } }).png().toBuffer()
    const asset = await runtime.importAsset({ name: 'synthetic.png', mimeType: 'image/png', bytes: new Uint8Array(bytes) })
    const imageId = randomUUID()
    const image = { id: imageId, version: ELEMENT_SCHEMA_VERSION, type: 'image' as const, name: 'Synthetic subject', description: '',
      transform: { x: .2, y: .2, width: .6, height: .6, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal' as const,
      visible: true, locked: false, groupId: null, semanticRole: 'content' as const, referencePolicy: 'include' as const,
      assetId: asset.id, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'contain' as const, referenceRole: 'general' as const }
    const mask = { ...image, id: randomUUID(), type: 'mask' as const, name: 'Edit region', zIndex: 1,
      semanticRole: 'edit-mask' as const, referencePolicy: 'exclude' as const, mode: 'edit' as const,
      targetElementId: imageId, paths: [{ id: randomUUID(), points: [{ x: .15, y: .15 }, { x: .85, y: .15 }, { x: .85, y: .85 }, { x: .15, y: .85 }], closed: true }], feather: .02 }
    const mutation = await runtime.executeSceneCommands({ expectedSceneRevision: 0, batch: { id: randomUUID(), origin: 'user', summary: 'Import synthetic subject', commands: [
      { kind: 'element.add', element: image }, { kind: 'element.add', element: mask }
    ] } })
    expect(mutation.ok).toBe(true)
    const scene = runtime.getWorkspaceBootstrap().scene
    const canvas: AgentPlan['tools'][number] = { kind: 'canvas_generation', originalRequirement: '保持当前作品', count: 1,
      providerId: 'mock', model: 'mock-balanced', referenceMode: 'hybrid', sourceMessageId: null }
    const edit: AgentPlan['tools'][number] = { kind: 'canvas_edit', targetElementId: imageId, prompt: '更柔和的光线', count: 1,
      providerId: 'mock', model: 'mock-balanced', sourceMessageId: null, ephemeralAnnotation: null }
    vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '跨入口生成', response: '已保留作品', nextAction: null,
      tools: editFirst ? [edit, canvas, generate('Blocked text')] : [generate('First text'), canvas, edit] })
    await runtime.startAgentRun({ text: '直接生成当前 4:5 作品的本地变化并修改图片', sceneSummary: { revision: scene.revision, canvas: scene.canvas, elementCount: 1, elements: [] },
      selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }, 'auto')
    await expect.poll(async () => {
      const turn = (await runtime.getAgentHarnessSnapshot()).turns[0]
      return turn?.status === 'failed' ? { status: turn.status, code: turn.errorCode, error: turn.errorMessage } : turn?.status
    }, { timeout: 8_000 }).toBe('budget_limited')
    const jobs = await runtime.listJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.status === 'completed' && job.results.length === 1)).toBe(true)
    const workflow = new GenerationWorkflowRepository(join(root, 'projects', 'Untitled.aicanvas', 'project.db'))
    try {
      const turn = (await runtime.getAgentHarnessSnapshot()).turns[0]!
      expect(workflow.getTurnUsage(turn.id)).toMatchObject({ jobs: 2, images: 2 })
      for (const job of jobs) expect((await workflow.getReservation(String(job.request.parameters.workflowIntentId))).turnId).toBe(turn.id)
    } finally { await workflow.close() }
  } finally { await runtime.close() }
}, 20_000)

it('counts requested images independently of per-request allowance and keeps usage on cancellation and duplicate terminal events', async () => {
  const value = await ledgerFixture({ maxGenerationJobs: 5, maxGeneratedImages: 3 })
  const first = await value.coordinator.create(await value.input(2))
  const cancelled = await value.jobs.transition(first.job.id, { status: 'cancelled', stage: 'cancelled', completedAt: new Date().toISOString() })
  await value.workflows.observeJob(cancelled)
  await value.workflows.observeJob(cancelled)
  expect(value.workflows.getTurnUsage(value.scope.turnId)).toMatchObject({ jobs: 1, images: 2 })
  await expect(value.coordinator.create(await value.input(2))).rejects.toMatchObject({ code: 'BUDGET_GENERATED_IMAGES' })
  await value.coordinator.create(await value.input(1))
  expect(value.workflows.getTurnUsage(value.scope.turnId)).toMatchObject({ jobs: 2, images: 3 })
  expect(value.creates).toHaveLength(2)
})

it('retains a persisted grant, usage, cost reservations and unknown submission across a new repository connection', async () => {
  const value = await ledgerFixture({ maxGenerationJobs: 4, maxCostCny: 3 })
  const input = await value.input(1, 2)
  const unknown = new GenerationWorkflowCoordinator({ repository: value.workflows, queue: {
    enqueue: async () => { throw new Error('Fake POST outcome unknown') }, listJobs: async () => [], cancel: (id) => value.jobs.requestCancel(id)
  } })
  await expect(unknown.create(input)).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' })
  const reopened = new GenerationWorkflowRepository(value.path)
  try {
    expect(reopened.getTurnUsage(value.scope.turnId)).toMatchObject({ jobs: 1, images: 1, reservedCostCny: 2 })
    expect(reopened.captureTurnBudget(value.scope, { ...value.budget, maxGenerationJobs: 99 }, null)).toEqual(value.budget)
    await expect(unknown.create(input)).rejects.toMatchObject({ code: 'NO_REPOST' })
    await expect(value.coordinator.create(await value.input(1, 2))).rejects.toMatchObject({ code: 'BUDGET_GENERATION_COST' })
    expect(value.creates).toHaveLength(0)
  } finally { await reopened.close() }
})
