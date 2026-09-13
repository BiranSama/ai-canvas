import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { SceneService } from '../../src/main/scene/scene-service'
import { isTerminalAgentTurnStatus } from '../../src/shared/agent-harness'
import { sceneExecuteInputSchema } from '../../src/shared/scene-authority'
import type { AgentPlan, AgentRequest } from '../../src/shared/agent'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function request(runtime: GenerationRuntime): AgentRequest {
  const scene = runtime.getWorkspaceBootstrap().scene
  return { text: '在当前 4:5 画布依次调整风格，保留可编辑结构。', sceneSummary: {
    revision: scene.revision, canvas: scene.canvas, elementCount: scene.elements.length, elements: []
  }, selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }
}

async function terminal(runtime: GenerationRuntime) {
  await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns.every((turn) => isTerminalAgentTurnStatus(turn.status)), { timeout: 8_000 }).toBe(true)
  return runtime.getAgentHarnessSnapshot()
}

it.each([2, 3])('commits %i real Scene batches with receipt revisions and reversible persisted history', async (count) => {
  const root = await mkdtemp(join(tmpdir(), 'batches-'))
  roots.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  vi.stubGlobal('fetch', network)
  let runtime = await GenerationRuntime.create(root)
  const canvas = runtime.getWorkspaceBootstrap().scene.canvas
  const plan: AgentPlan = { summary: '顺序批次', response: '批次已写入。', nextAction: null, tools: Array.from({ length: count }, (_, index) => ({
    kind: 'scene_batch', summary: `批次${index + 1}`, commands: [{ kind: 'scene.set-canvas', canvas: { ...canvas, globalStyle: `style-${index + 1}` } }]
  })) }
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(plan)
  try {
    await runtime.startAgentRun(request(runtime), 'auto')
    const snapshot = await terminal(runtime)
    expect(snapshot.turns[0]?.status).toBe('completed')
    expect(runtime.getWorkspaceBootstrap().scene.canvas.globalStyle).toBe(`style-${count}`)
    expect(snapshot.items.filter((item) => item.type === 'tool_result').map((item) => (item.payload as { outcome: { sceneRevisionBefore: number; sceneRevisionAfter: number } }).outcome))
      .toEqual(Array.from({ length: count }, (_, index) => expect.objectContaining({ sceneRevisionBefore: index, sceneRevisionAfter: index + 1 })))
    expect(planner).toHaveBeenCalledTimes(1)
    const undo = await runtime.undoScene({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batchId: null })
    expect(undo.ok).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene.canvas.globalStyle).toBe(`style-${count - 1}`)
    await runtime.close()
    runtime = await GenerationRuntime.create(root)
    const redo = await runtime.redoScene({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batchId: null })
    expect(redo.ok).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene.canvas.globalStyle).toBe(`style-${count}`)
    expect(network).not.toHaveBeenCalled()
  } finally { await runtime.close() }
})

it.each([false, true])('rejects stale writes after a human change, mixed result placement=%s', async (mixedPlacement) => {
  const root = await mkdtemp(join(tmpdir(), 'batch-conflict-'))
  roots.push(root)
  vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_NETWORK_BLOCKED') })
  const runtime = await GenerationRuntime.create(root)
  const canvas = runtime.getWorkspaceBootstrap().scene.canvas
  let resultId: string | undefined
  if (mixedPlacement) {
    const job = await runtime.enqueue({ prompt: 'Offline placement fixture', negativePrompt: '', aspectWidth: 4, aspectHeight: 5,
      outputWidth: 320, outputHeight: 400, count: 1, providerId: 'mock', model: 'mock-balanced', references: [], parameters: {},
      sourceMessageId: null, parentResultId: null, referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' })
    await expect.poll(async () => (await runtime.listJobs()).find((item) => item.id === job.id)?.status).toBe('completed')
    resultId = (await runtime.listJobs()).find((item) => item.id === job.id)!.results[0]!.id
  }
  const originalExecute = SceneService.prototype.execute
  let insertedHumanChange = false
  vi.spyOn(SceneService.prototype, 'execute').mockImplementation(async function (this: SceneService, input) {
    const parsed = sceneExecuteInputSchema.parse(input)
    const result = await originalExecute.call(this, input)
    if (result.ok && parsed.batch.origin === 'agent' && !insertedHumanChange) {
      insertedHumanChange = true
      const human = await originalExecute.call(this, { expectedSceneRevision: result.receipt.state.scene.revision,
        batch: { id: randomUUID(), origin: 'user', summary: '真实人工修改', commands: [{ kind: 'scene.set-canvas', canvas: { ...canvas, globalStyle: 'human-kept' } }] } })
      expect(human.ok).toBe(true)
    }
    return result
  })
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan')
    .mockResolvedValueOnce({ summary: '两个步骤', response: '完成', nextAction: null, tools: [
      { kind: 'scene_batch', summary: '第一步', commands: [{ kind: 'scene.set-canvas', canvas: { ...canvas, globalStyle: 'first' } }] },
      ...(resultId === undefined ? [] : [{ kind: 'place_generation_result' as const, resultId }]),
      { kind: 'scene_batch', summary: '陈旧第二步', commands: [{ kind: 'scene.set-canvas', canvas: { ...canvas, globalStyle: 'must-not-overwrite-human' } }] }
    ] })
    .mockRejectedValue(Object.assign(new Error('Fixture stops after observing the required replan.'), { code: 'FIXTURE_REPLAN_STOP' }))
  try {
    await runtime.startAgentRun(request(runtime), 'auto')
    const snapshot = await terminal(runtime)
    expect(insertedHumanChange).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene.canvas.globalStyle).toBe('human-kept')
    expect(snapshot.items.some((item) => item.type === 'tool_result' && item.status === 'failed'
      && JSON.stringify(item.payload).includes('SCENE_REVISION_STALE'))).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene.revision).toBe(2)
    expect(runtime.getWorkspaceBootstrap().scene.elements).toHaveLength(0)
  } finally { await runtime.close() }
})
