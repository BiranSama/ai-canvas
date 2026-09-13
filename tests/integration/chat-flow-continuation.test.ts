import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { agentPlanSchema } from '../../src/shared/agent'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'
import { makeAllElementTypesScene, IDS } from '../fixtures/scene-fixtures'

const runtimes: GenerationRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('waits for generation and replaces a grouped placeholder in the same turn without losing identity or undo', async () => {
  const network = vi.fn(() => { throw Error('OFFLINE_CHAT_TEST') }); vi.stubGlobal('fetch', network)
  const root = await mkdtemp(join(tmpdir(), 'chat-flow-'))
  const runtime = await GenerationRuntime.create(join(root, 'data')); runtimes.push(runtime)
  await runtime.createProject(join(root, 'work.aicanvas'), 'Chat flow')
  const fixture = makeAllElementTypesScene()
  const placeholder = { ...fixture.elements.find(e => e.id === IDS.placeholder)!, groupId: null, zIndex: 0 }
  const text = { ...fixture.elements.find(e => e.id === IDS.text)!, groupId: null, zIndex: 1 }
  const group = { ...placeholder, type: 'group' as const, id: IDS.group, name: '主体组', childIds: [IDS.placeholder], zIndex: 2 }
  const created = await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: '准备布局', commands: [
      { kind: 'element.add', element: placeholder }, { kind: 'element.add', element: text },
      { kind: 'element.group', group, elementIds: [IDS.placeholder] }
    ] } })
  expect(created.ok).toBe(true)
  const before = runtime.getWorkspaceBootstrap().scene
  const plan = agentPlanSchema.parse({ summary: '生成并填入主体', response: '生成结果已放入主体', nextAction: null, tools: [
    { kind: 'generation', request: { prompt: '香水瓶', providerId: 'mock', model: 'mock-balanced', count: 1, outputWidth: 256, outputHeight: 320, aspectWidth: 4, aspectHeight: 5 } },
    { kind: 'place_generation_result', resultId: 'generated:0', targetElementId: IDS.placeholder }
  ] })
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(plan)
  await runtime.startAgentRun(fixtureAgentRequest(before, '生成一张香水图并替换占位'), 'auto')
  await expect.poll(async () => {
    const turn = (await runtime.getAgentHarnessSnapshot()).turns[0]
    if (turn?.status === 'failed') throw Error(`${turn.errorCode}: ${turn.errorMessage}`)
    return runtime.getWorkspaceBootstrap().scene.elements.find(e => e.id === IDS.placeholder)?.type
  }, { timeout: 8000 }).toBe('image')
  const after = runtime.getWorkspaceBootstrap().scene
  expect(planner).toHaveBeenCalledTimes(1)
  expect((await runtime.listJobs())).toHaveLength(1)
  expect(after.elements.find(e => e.id === IDS.placeholder)).toMatchObject({ id: IDS.placeholder, type: 'image', transform: before.elements.find(e => e.id === IDS.placeholder)!.transform, groupId: IDS.group })
  expect(after.elements.find(e => e.id === IDS.group)).toEqual(before.elements.find(e => e.id === IDS.group))
  expect(after.elements.find(e => e.id === IDS.text)).toEqual(before.elements.find(e => e.id === IDS.text))
  const undo = await runtime.undoScene({ expectedSceneRevision: after.revision, batchId: null })
  expect(undo.ok).toBe(true)
  expect(runtime.getWorkspaceBootstrap().scene.elements).toEqual(before.elements)
  const redo = await runtime.redoScene({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batchId: null })
  expect(redo.ok).toBe(true)
  expect(runtime.getWorkspaceBootstrap().scene.elements).toEqual(after.elements)
  const result = (await runtime.listJobs())[0]!.results[0]!
  const beforeRepeat = runtime.getWorkspaceBootstrap().scene
  planner.mockResolvedValue(agentPlanSchema.parse({ summary: '再次使用当前结果', response: '当前结果保持不变', nextAction: null,
    tools: [{ kind: 'place_generation_result', resultId: result.id, targetElementId: IDS.placeholder }] }))
  const repeated = await runtime.startAgentRun(fixtureAgentRequest(beforeRepeat, '使用当前结果，不要再次生图'), 'auto')
  await expect.poll(async () => (await runtime.getConversation()).runs.find(run => run.id === repeated.id)?.status, { timeout: 5000 }).toBe('completed')
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(beforeRepeat)
  const repeatedHarness = await runtime.getAgentHarnessSnapshot()
  const repeatedTurn = repeatedHarness.turns.find(turn => turn.inputMessageId === repeated.id)!
  expect(repeatedHarness.items.find(item => item.turnId === repeatedTurn.id && item.type === 'tool_result')?.payload).toMatchObject({
    outcome: { ok: true, batchId: null, affectedElementIds: [] }
  })
  expect(await runtime.listJobs()).toHaveLength(1)
  const escaped = await runtime.startAgentRun({ ...fixtureAgentRequest(beforeRepeat, '调整所选对象'), selectedIds: [IDS.text], selectedElements: [text] }, 'auto')
  await expect.poll(async () => (await runtime.getConversation()).runs.find(run => run.id === escaped.id)?.status, { timeout: 5000 }).toBe('failed')
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(beforeRepeat)
  await expect(runtime.placeGenerationResult({ resultId: result.id, placementId: randomUUID(), origin: 'agent' }, before.revision, undefined, IDS.placeholder)).rejects.toMatchObject({ code: 'SCENE_REVISION_STALE' })
  await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batch: {
    id: randomUUID(), origin: 'user', summary: '锁定目标', commands: [{ kind: 'element.update', elementId: IDS.placeholder, changes: { locked: true } }]
  } })
  await expect(runtime.placeGenerationResult({ resultId: result.id, placementId: randomUUID(), origin: 'agent' }, runtime.getWorkspaceBootstrap().scene.revision, undefined, IDS.placeholder)).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' })
  await expect(runtime.placeGenerationResult({ resultId: result.id, placementId: randomUUID(), origin: 'agent' }, runtime.getWorkspaceBootstrap().scene.revision, undefined, IDS.text)).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' })
  expect(network).not.toHaveBeenCalled()
})
