import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene, type SceneElement } from '../../src/domain'
import { ActivityLedgerRepository, AgentHarnessRepository, AgentRuntime, ConversationRepository, DeterministicMockPlanner, type AgentPlanner } from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { AgentPlan, AgentRequest, AgentRunStatus, SceneSummary } from '../../src/shared/agent'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'

const roots: string[] = []

function idFactory(): () => string {
  let value = 2_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function summarize(scene: Scene): SceneSummary {
  return {
    revision: scene.revision,
    canvas: {
      aspectWidth: scene.canvas.aspectWidth,
      aspectHeight: scene.canvas.aspectHeight,
      outputWidth: scene.canvas.outputWidth,
      outputHeight: scene.canvas.outputHeight,
      globalStyle: scene.canvas.globalStyle
    },
    elementCount: scene.elements.length,
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      groupId: element.groupId,
      locked: element.locked,
      visible: element.visible,
      transform: element.transform
    }))
  }
}

function request(scene: Scene, text: string, selectedElements: readonly SceneElement[] = [], autoGenerate = false): AgentRequest {
  return {
    text,
    sceneSummary: summarize(scene),
    selectedIds: selectedElements.map((element) => element.id),
    selectedElements: [...selectedElements],
    attachments: selectedElements.map((element) => ({ kind: 'selection', id: element.id, name: element.name })),
    autoGenerate,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

async function waitForStatus(runtime: AgentRuntime, runId: string, statuses: readonly AgentRunStatus[]): Promise<AgentRunStatus> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const run = (await runtime.snapshot()).runs.find((candidate) => candidate.id === runId)
    if (run !== undefined && statuses.includes(run.status)) return run.status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Agent run ${runId} did not reach ${statuses.join(', ')}.`)
}

interface ExecutedTool {
  readonly tool: AgentPlan['tools'][number]
  readonly sourceMessageId: string
}

// Production runs every Agent turn through the persistent Main loop; the
// harness applies scene batches through the same CommandBus contract and
// records every other tool instead of calling a provider.
async function waitForTool(executed: readonly ExecutedTool[]): Promise<void> {
  const started = Date.now()
  while (executed.length === 0) {
    if (Date.now() - started > 5_000) throw new Error('No Agent tool reached the executor.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function harness(options: { readonly planner?: AgentPlanner; readonly projectDirectory?: string; readonly ids?: () => string; readonly budgetScale?: number } = {}) {
  const root = options.projectDirectory === undefined ? await mkdtemp(join(tmpdir(), 'ai-canvas-agent-')) : null
  if (root !== null) roots.push(root)
  const ids = options.ids ?? idFactory()
  const projectDirectory = options.projectDirectory ?? join(root!, 'agent.aicanvas')
  const opened = options.projectDirectory === undefined
    ? await ProjectWorkspace.create(projectDirectory, 'Agent project', { idFactory: ids })
    : await ProjectWorkspace.open(projectDirectory, { idFactory: ids })
  const databasePath = join(projectDirectory, 'project.db')
  const bus = new CommandBus(opened.scene)
  const executed: ExecutedTool[] = []
  const runtime = new AgentRuntime({
    projectId: opened.workspace.metadata.id,
    repository: new ConversationRepository(databasePath, { idFactory: ids }),
    activityLedger: new ActivityLedgerRepository(databasePath, { idFactory: ids }),
    harnessRepository: new AgentHarnessRepository(databasePath, { idFactory: ids }),
    planner: options.planner ?? new DeterministicMockPlanner({ delayMs: 1, idFactory: ids }),
    ...(options.budgetScale === undefined ? {} : { budgetScale: () => options.budgetScale! }),
    executePersistentTool: async (tool, context) => {
      executed.push({ tool, sourceMessageId: context.sourceMessageId })
      if (tool.kind !== 'scene_batch') {
        return { toolIndex: context.toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'recorded' }
      }
      const before = new Map(bus.getScene().elements.map((element) => [element.id, JSON.stringify(element)]))
      const result = bus.execute({ id: ids(), origin: 'agent', summary: tool.summary, commands: tool.commands })
      if (!result.ok) {
        return { toolIndex: context.toolIndex, ok: false, batchId: null, jobId: null, affectedElementIds: [], message: result.error.message }
      }
      await opened.workspace.saveScene(result.scene, 'autosave', result.batch)
      return {
        toolIndex: context.toolIndex,
        ok: true,
        batchId: result.batch.id,
        jobId: null,
        affectedElementIds: result.scene.elements.filter((element) => before.get(element.id) !== JSON.stringify(element)).map((element) => element.id),
        message: 'ok'
      }
    }
  })
  await runtime.initialize()
  return { root, ids, projectDirectory, opened, runtime, bus, executed }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})


async function closeHarness(value: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await value.runtime.close()
  await value.opened.workspace.close(true)
}

describe('agent runtime and shared CommandBus boundary', () => {
  it('creates the AC-01 layout as one undoable batch without calling generation and persists the conversation', async () => {
    const value = await harness()
    const started = await value.runtime.start(request(
      value.bus.getScene(),
      '做一张 4:5 的香水海报，标题是 NIGHT VEIL，瓶子中央偏下，标题顶部，柔和蓝光在瓶子后方。先不要生成图片。'
    ))
    await waitForStatus(value.runtime, started.id, ['completed'])

    expect(value.executed.map((entry) => entry.tool.kind)).toEqual(['scene_batch'])
    const scene = value.bus.getScene()
    expect(scene.canvas).toMatchObject({ aspectWidth: 4, aspectHeight: 5 })
    expect(scene.elements.find((element) => element.type === 'text')).toMatchObject({
      content: 'NIGHT VEIL',
      transform: { y: 0.07 }
    })
    expect(scene.creativeContext).toMatchObject({
      brief: { theme: 'product', generationIntent: 'none' },
      plan: { canvas: { aspectWidth: 4, aspectHeight: 5 } }
    })
    expect(scene.elements.find((element) => element.type === 'placeholder')).toMatchObject({
      name: '瓶子',
      transform: { y: 0.43 }
    })

    const snapshot = await value.runtime.snapshot()
    const receipt = snapshot.messages.at(-1)
    expect(snapshot.messages[0]).toMatchObject({ role: 'user' })
    expect(receipt).toMatchObject({ role: 'assistant', kind: 'receipt', receipt: { undoable: true } })
    expect(snapshot.runs[0]).toMatchObject({ status: 'completed', autoGenerate: false })
    const toolActivity = snapshot.activities.find((activity) => activity.kind === 'tool')
    expect(toolActivity).toMatchObject({ state: 'completed', operationBatchId: receipt?.receipt?.batchId })
    expect(toolActivity?.affectedIds).toEqual(expect.arrayContaining(scene.elements.map((element) => element.id)))
    expect(value.bus.undo()).not.toBeNull()
    expect(value.bus.getScene().elements).toHaveLength(0)
    await closeHarness(value)

    const reopened = await ProjectWorkspace.open(value.projectDirectory, { idFactory: value.ids })
    const repository = new ConversationRepository(join(value.projectDirectory, 'project.db'), { idFactory: value.ids })
    expect(reopened.scene.elements.find((element) => element.type === 'text')).toMatchObject({ content: 'NIGHT VEIL' })
    const persisted = await repository.getSnapshot(reopened.workspace.metadata.id)
    expect(persisted.messages[0]).toMatchObject({ role: 'user' })
    expect(persisted.messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'receipt' })
    await repository.close()
    await reopened.workspace.close(true)
  })

  it('gives a run as many tool steps as the owner\'s multiple of the turn allowance allows', async () => {
    const value = await harness({ budgetScale: 4 })
    const started = await value.runtime.start(request(value.bus.getScene(), '做一张 4:5 的香水海报，标题是 NIGHT VEIL。先不要生成图片。'))
    expect(started.maxSteps).toBe(32)
    await waitForStatus(value.runtime, started.id, ['completed'])
    await closeHarness(value)
  })

  it('uses the current selection as the default scope and leaves unrelated elements unchanged', async () => {
    const value = await harness()
    const first = await value.runtime.start(request(value.bus.getScene(), '做一张 4:5 香水海报，标题 NIGHT VEIL。先不要生成图片。'))
    await waitForStatus(value.runtime, first.id, ['completed'])
    const title = value.bus.getScene().elements.find((element) => element.type === 'text')
    const bottle = value.bus.getScene().elements.find((element) => element.type === 'placeholder')
    if (title?.type !== 'text' || bottle === undefined) throw new Error('Fixture elements missing.')

    const beforeBottle = { ...bottle.transform }
    const second = await value.runtime.start(request(value.bus.getScene(), '更厚一点，并向左移动', [title]))
    await waitForStatus(value.runtime, second.id, ['completed'])
    expect(value.bus.getScene().elements.find((element) => element.id === title.id)).toMatchObject({
      transform: { x: title.transform.x - 0.08 },
      styleDescription: expect.stringContaining('更厚重')
    })
    expect(value.bus.getScene().elements.find((element) => element.id === bottle.id)?.transform).toEqual(beforeBottle)

    const third = await value.runtime.start(request(value.bus.getScene(), '把选中的香水瓶置顶', [bottle]))
    await waitForStatus(value.runtime, third.id, ['completed'])
    const reorder = value.executed.at(-1)?.tool
    if (reorder?.kind !== 'scene_batch') throw new Error('Expected reorder batch.')
    expect(reorder.commands).toEqual([{
      kind: 'element.reorder',
      elementId: bottle.id,
      toIndex: value.bus.getScene().elements.length - 1
    }])
    expect(value.bus.getScene().elements.at(-1)?.id).toBe(bottle.id)
    await closeHarness(value)
  })

  it('pauses an inferred generation tool for confirmation and resumes only after approval', async () => {
    const generationPlanner: AgentPlanner = {
      plan: async (): Promise<AgentPlan> => ({
        summary: '生成当前作品',
        response: '生成任务已创建。',
        nextAction: null,
        tools: [{
          kind: 'generation',
          request: {
            prompt: '冷静的香水广告',
            negativePrompt: '',
            aspectWidth: 4,
            aspectHeight: 5,
            outputWidth: 1024,
            outputHeight: 1280,
            count: 1,
            providerId: 'mock',
            model: 'mock-balanced',
            references: [],
            parameters: {},
            sourceMessageId: null,
            parentResultId: null,
            referenceMode: 'hybrid',
            variationInstruction: '',
            preserveConstraints: ''
          }
        }]
      })
    }
    const value = await harness({ planner: generationPlanner })
    const started = await value.runtime.start(request(value.opened.scene, '让它更有成品质感'))
    await waitForStatus(value.runtime, started.id, ['awaiting_confirmation'])
    expect(value.executed).toHaveLength(0)
    const waiting = await value.runtime.snapshot()
    expect(waiting.activities.find((activity) => activity.kind === 'decision')).toMatchObject({
      state: 'waiting',
      decision: {
        kind: 'generation_confirmation',
        status: 'waiting',
        defaultOptionId: 'generate',
        options: [expect.objectContaining({ id: 'generate' }), expect.objectContaining({ id: 'keep_canvas' })]
      }
    })

    await value.runtime.confirm(started.id)
    await waitForStatus(value.runtime, started.id, ['completed'])
    expect(value.executed.map((entry) => entry.tool.kind)).toEqual(['generation'])
    await closeHarness(value)
  })

  it('persists an aspect-ratio decision and executes no tool until the user chooses', async () => {
    const value = await harness()
    const started = await value.runtime.start(request(
      value.opened.scene,
      '创建一张雨夜唱片封面，标题是 AFTER RAIN，黑胶唱片放在右下方。先不要生成图片。'
    ))
    await waitForStatus(value.runtime, started.id, ['awaiting_confirmation'])
    expect(value.executed).toHaveLength(0)
    const before = await value.runtime.snapshot()
    expect(before.activities.find((activity) => activity.kind === 'decision')).toMatchObject({
      state: 'waiting',
      decision: { kind: 'aspect_ratio', status: 'waiting', defaultOptionId: '4:5' }
    })
    await closeHarness(value)

    const resumed = await harness({ projectDirectory: value.projectDirectory, ids: value.ids })
    await expect(resumed.runtime.snapshot()).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: started.id, status: 'awaiting_confirmation' })],
      activities: expect.arrayContaining([expect.objectContaining({ kind: 'decision', state: 'waiting' })])
    })
    expect(resumed.executed).toHaveLength(0)
    await resumed.runtime.confirm(started.id, '1:1')
    await waitForStatus(resumed.runtime, started.id, ['completed'])
    const sceneTool = resumed.executed[0]?.tool
    if (sceneTool?.kind !== 'scene_batch') throw new Error('Expected scene batch after decision.')
    expect(sceneTool.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scene.set-canvas', canvas: expect.objectContaining({ aspectWidth: 1, aspectHeight: 1 }) })
    ]))
    expect(resumed.bus.getScene().canvas).toMatchObject({ aspectWidth: 1, aspectHeight: 1 })
    await closeHarness(resumed)
  })

  it('routes an explicit request on a populated scene through canvas reference generation', async () => {
    const value = await harness()
    const fixture = createNightVeilScene()
    const populated = sceneSchema.parse({ ...fixture, projectId: value.opened.workspace.metadata.id })
    const started = await value.runtime.start(request(populated, '现在生成图片'))
    await waitForTool(value.executed)
    expect(value.executed[0]).toEqual({
      tool: expect.objectContaining({ kind: 'canvas_generation', originalRequirement: '现在生成图片' }),
      sourceMessageId: expect.any(String)
    })
    await value.runtime.cancel(started.id)
    await closeHarness(value)
  })

  it('routes an explicit selected mask edit through the non-destructive canvas edit tool', async () => {
    const value = await harness()
    const fixture = createNightVeilScene()
    const target: SceneElement = {
      id: '30000000-0000-4000-8000-000000000081',
      version: ELEMENT_SCHEMA_VERSION,
      type: 'image',
      name: '可编辑图片',
      description: '',
      transform: { x: .2, y: .2, width: .6, height: .6, rotation: 0 },
      zIndex: 0,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'content',
      referencePolicy: 'include',
      assetId: '30000000-0000-4000-8000-000000000082',
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'fill',
      referenceRole: 'general'
    }
    const mask: SceneElement = {
      ...target,
      id: '30000000-0000-4000-8000-000000000083',
      type: 'mask',
      name: '修改区',
      zIndex: 1,
      semanticRole: 'edit-mask',
      referencePolicy: 'exclude',
      mode: 'edit',
      targetElementId: target.id,
      paths: [{
        id: '30000000-0000-4000-8000-000000000084',
        points: [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }],
        closed: true
      }],
      feather: .08
    }
    const scene = sceneSchema.parse({ ...fixture, projectId: value.opened.workspace.metadata.id, elements: [target, mask], relations: [] })
    const started = await value.runtime.start(request(scene, '把蒙版标记的局部改成柔和蓝色玻璃', [mask]))
    await waitForTool(value.executed)
    expect(value.executed[0]?.tool).toEqual(expect.objectContaining({
      kind: 'canvas_edit',
      targetElementId: target.id,
      prompt: '把蒙版标记的局部改成柔和蓝色玻璃'
    }))
    await value.runtime.cancel(started.id)
    await closeHarness(value)
  })

  it('routes a one-turn preview annotation to canvas edit without requiring a persistent mask element', async () => {
    const value = await harness()
    const fixture = createNightVeilScene()
    const target: SceneElement = {
      id: '31000000-0000-4000-8000-000000000081',
      version: ELEMENT_SCHEMA_VERSION,
      type: 'image',
      name: '对话预览原图',
      description: '',
      transform: { x: 0.12, y: 0.1, width: 0.76, height: 0.8, rotation: 0 },
      zIndex: 0,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'content',
      referencePolicy: 'include',
      assetId: '31000000-0000-4000-8000-000000000082',
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'cover',
      referenceRole: 'general'
    }
    const scene = sceneSchema.parse({ ...fixture, projectId: value.opened.workspace.metadata.id, elements: [target], relations: [] })
    const ephemeralAnnotation = {
      id: '31000000-0000-4000-8000-000000000083',
      mode: 'generate' as const,
      targetElementId: target.id,
      points: [{ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.24 }, { x: 0.62, y: 0.72 }, { x: 0.25, y: 0.64 }],
      closed: true,
      width: 0.015
    }
    const annotatedRequest = { ...request(scene, '把这里局部改成柔和蓝色玻璃花朵', [target]), ephemeralAnnotation }
    const started = await value.runtime.start(annotatedRequest)
    await waitForTool(value.executed)

    expect(scene.elements).toHaveLength(1)
    expect(scene.elements.some((element) => element.type === 'mask')).toBe(false)
    expect(value.executed[0]?.tool).toEqual(expect.objectContaining({
      kind: 'canvas_edit',
      targetElementId: target.id,
      prompt: annotatedRequest.text,
      ephemeralAnnotation
    }))
    await value.runtime.cancel(started.id)
    await closeHarness(value)
  })

  it.each([
    ['as soon as the request is sent', async () => undefined],
    ['while the planner is working', async (runtime: AgentRuntime, runId: string) => { await waitForStatus(runtime, runId, ['planning']) }]
  ] as const)('stops the turn when cancelled %s without a plan or scene mutation', async (_moment, beforeCancel) => {
    const value = await harness({ planner: new DeterministicMockPlanner({ delayMs: 200 }) })
    const before = value.bus.getScene()
    const started = await value.runtime.start(request(before, '做一张 4:5 香水海报'))
    await beforeCancel(value.runtime, started.id)
    await value.runtime.cancel(started.id)
    await waitForStatus(value.runtime, started.id, ['interrupted'])
    // Give a planner that ignored the stop time to finish and try to write.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const snapshot = await value.runtime.snapshot()
    expect(snapshot.runs[0]).toMatchObject({ status: 'interrupted', errorCode: 'USER_INTERRUPTED' })
    expect((await value.runtime.harnessSnapshot()).turns[0]).toMatchObject({ status: 'interrupted' })
    expect((await value.runtime.harnessSnapshot()).items.map((item) => item.type)).not.toContain('plan')
    expect(value.executed).toHaveLength(0)
    expect(value.bus.getScene()).toEqual(before)
    await closeHarness(value)
  })

  it('contains an invalid tool batch atomically and records a readable failure', async () => {
    const invalidPlanner: AgentPlanner = {
      plan: async (): Promise<AgentPlan> => ({
        summary: '无效修改测试',
        response: '不应成功',
        nextAction: null,
        tools: [{
          kind: 'scene_batch',
          summary: '修改不存在元素',
          commands: [{ kind: 'element.update', elementId: '00000000-0000-4000-8000-999999999999', changes: { opacity: 0.5 } }]
        }]
      })
    }
    const value = await harness({ planner: invalidPlanner })
    const before = value.bus.getScene()
    const started = await value.runtime.start(request(before, '执行无效修改'))
    await waitForStatus(value.runtime, started.id, ['failed', 'completed'])
    expect(value.executed.length).toBeGreaterThan(0)
    expect(value.bus.getScene()).toEqual(before)
    const snapshot = await value.runtime.snapshot()
    expect(snapshot.runs[0]?.status).toBe('failed')
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(JSON.stringify(snapshot.messages.slice(1))).not.toContain('element.update')
    expect(snapshot.runs[0]?.errorMessage ?? '').not.toContain('element.update')
    expect(JSON.stringify(snapshot.activities)).not.toContain('element.update')
    await closeHarness(value)
  })
})
