import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { agentPlanSchema, type ConversationSnapshot } from '../../src/shared/agent'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'
import { makeAllElementTypesScene, IDS } from '../fixtures/scene-fixtures'

const runtimes: GenerationRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function finished(runtime: GenerationRuntime, runId: string): Promise<ConversationSnapshot> {
  await expect.poll(async () => {
    const run = (await runtime.getConversation()).runs.find((candidate) => candidate.id === runId)
    if (run?.status === 'failed') throw new Error(`${run.errorCode}: ${run.errorMessage}`)
    return run?.status
  }, { timeout: 8000 }).toBe('completed')
  return runtime.getConversation()
}

it('keeps a small picture of the canvas before and after a turn that changed it, and none for a reply', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('OFFLINE_SNAPSHOT_TEST') }))
  const root = await mkdtemp(join(tmpdir(), 'turn-snapshots-'))
  const runtime = await GenerationRuntime.create(join(root, 'data')); runtimes.push(runtime)
  await runtime.createProject(join(root, 'work.aicanvas'), 'Snapshots')
  const shape = { ...makeAllElementTypesScene().elements.find((element) => element.id === IDS.shape)!, groupId: null, zIndex: 0 }
  const laid = await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: '色块', commands: [{ kind: 'element.add', element: shape }] } })
  expect(laid.ok).toBe(true)

  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(agentPlanSchema.parse({
    summary: '把色块挪到右下', response: '色块挪到了右下角。', nextAction: null,
    tools: [{ kind: 'scene_batch', summary: '挪动色块', commands: [
      { kind: 'element.update', elementId: IDS.shape, changes: { transform: { x: 0.6, y: 0.6, width: 0.3, height: 0.3, rotation: 0 } } }
    ] }]
  }))
  const moved = await runtime.startAgentRun(fixtureAgentRequest(runtime.getWorkspaceBootstrap().scene, '把色块挪到右下'), 'collaboration')
  const receipt = (await finished(runtime, moved.id)).messages.findLast((message) => message.runId === moved.id && message.role === 'assistant')?.receipt
  expect(receipt?.snapshots).toEqual({ before: expect.any(String), after: expect.any(String) })
  const [before, after] = await Promise.all([
    runtime.readAssetDataUrl(receipt!.snapshots!.before!, false),
    runtime.readAssetDataUrl(receipt!.snapshots!.after, false)
  ])
  expect(before).toMatch(/^data:image\/png;base64,/)
  expect(after).toMatch(/^data:image\/png;base64,/)
  expect(after).not.toBe(before)

  planner.mockResolvedValue(agentPlanSchema.parse({ summary: '回答', response: '这张图的主色是蓝色。', nextAction: null, tools: [] }))
  const asked = await runtime.startAgentRun(fixtureAgentRequest(runtime.getWorkspaceBootstrap().scene, '现在的主色是什么？'), 'collaboration')
  const reply = (await finished(runtime, asked.id)).messages.findLast((message) => message.runId === asked.id && message.role === 'assistant')
  expect(reply?.receipt?.snapshots).toBeUndefined()
}, 30_000)
