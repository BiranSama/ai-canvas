import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene, type SceneElement } from '../../src/domain'
import { ActivityLedgerRepository, AgentRuntime, ConversationRepository, DeterministicMockPlanner, type AgentPlanner } from '../../src/main/agent'
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
  while (Date.now() - started < 2_000) {
    const run = (await runtime.snapshot()).runs.find((candidate) => candidate.id === runId)
    if (run !== undefined && statuses.includes(run.status)) return run.status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Agent run ${runId} did not reach ${statuses.join(', ')}.`)
}

async function harness(options: { readonly planner?: AgentPlanner; readonly timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-agent-'))
  roots.push(root)
  const ids = idFactory()
  const projectDirectory = join(root, 'agent.aicanvas')
  const opened = await ProjectWorkspace.create(projectDirectory, 'Agent project', { idFactory: ids })
  const repository = new ConversationRepository(join(projectDirectory, 'project.db'), { idFactory: ids })
  const activityLedger = new ActivityLedgerRepository(join(projectDirectory, 'project.db'), { idFactory: ids })
  const runtime = new AgentRuntime({
    projectId: opened.workspace.metadata.id,
    repository,
    planner: options.planner ?? new DeterministicMockPlanner({ delayMs: 1, idFactory: ids }),
    timeoutMs: options.timeoutMs ?? 1_000,
    activityLedger
  })
  await runtime.initialize()
  return { root, ids, projectDirectory, opened, runtime }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('agent runtime and shared CommandBus boundary', () => {
  it('creates the AC-01 layout as one undoable batch without calling generation and persists the conversation', async () => {
    const value = await harness()
    const bus = new CommandBus(value.opened.scene)
    const started = await value.runtime.start(request(
      bus.getScene(),
      '做一张 4:5 的香水海报，标题是 NIGHT VEIL，瓶子中央偏下，标题顶部，柔和蓝光在瓶子后方。先不要生成图片。'
    ))
    await waitForStatus(value.runtime, started.id, ['awaiting_execution'])
    const plan = await value.runtime.claimPlan(started.id)
    expect(plan?.tools).toHaveLength(1)
    expect(plan?.tools[0]?.kind).toBe('scene_batch')
    const sceneTool = plan?.tools[0]
    if (sceneTool?.kind !== 'scene_batch') throw new Error('Expected a scene batch.')

    const executed = bus.execute({ id: value.ids(), origin: 'agent', summary: sceneTool.summary, commands: sceneTool.commands })
    expect(executed.ok).toBe(true)
    if (!executed.ok) throw new Error(executed.error.message)
    await value.opened.workspace.saveScene(executed.scene, 'autosave', executed.batch)
    await value.runtime.complete({
      runId: started.id,
      outcomes: [{
        toolIndex: 0,
        ok: true,
        batchId: executed.batch.id,
        jobId: null,
        affectedElementIds: executed.scene.elements.map((element) => element.id),
        message: '布局已创建'
      }]
    })

    expect(executed.scene.canvas).toMatchObject({ aspectWidth: 4, aspectHeight: 5 })
    expect(executed.scene.elements.find((element) => element.type === 'text')).toMatchObject({
      content: 'NIGHT VEIL',
      transform: { y: 0.07 }
    })
    expect(executed.scene.creativeContext).toMatchObject({
      brief: { theme: 'product', generationIntent: 'none' },
      plan: { canvas: { aspectWidth: 4, aspectHeight: 5 } }
    })
    expect(executed.scene.elements.find((element) => element.type === 'placeholder')).toMatchObject({
      name: '瓶子',
      transform: { y: 0.43 }
    })
    expect(bus.undo()).not.toBeNull()
    expect(bus.getScene().elements).toHaveLength(0)

    const snapshot = await value.runtime.snapshot()
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[1]).toMatchObject({ kind: 'receipt', receipt: { undoable: true, batchId: executed.batch.id } })
    expect(snapshot.runs[0]).toMatchObject({ status: 'completed', stepCount: 1, autoGenerate: false })
    expect(snapshot.activities.map((activity) => ({ kind: activity.kind, state: activity.state }))).toEqual([
      { kind: 'plan', state: 'completed' },
      { kind: 'tool', state: 'completed' },
      { kind: 'receipt', state: 'completed' }
    ])
    expect(snapshot.activities[1]).toMatchObject({
      operationBatchId: executed.batch.id,
      affectedIds: executed.scene.elements.map((element) => element.id),
      events: [
        expect.objectContaining({ eventType: 'tool.queued' }),
        expect.objectContaining({ eventType: 'tool.completed' })
      ]
    })
    await value.runtime.close()
    await value.opened.workspace.close(true)

    const reopened = await ProjectWorkspace.open(value.projectDirectory, { idFactory: value.ids })
    const repository = new ConversationRepository(join(value.projectDirectory, 'project.db'), { idFactory: value.ids })
    expect(reopened.scene.elements.find((element) => element.type === 'text')).toMatchObject({ content: 'NIGHT VEIL' })
    await expect(repository.getSnapshot(reopened.workspace.metadata.id)).resolves.toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant', kind: 'receipt' }]
    })
    await repository.close()
    await reopened.workspace.close(true)
  })

  it('uses the current selection as the default scope and leaves unrelated elements unchanged', async () => {
    const value = await harness()
    const bus = new CommandBus(value.opened.scene)
    const first = await value.runtime.start(request(bus.getScene(), '做一张 4:5 香水海报，标题 NIGHT VEIL。先不要生成图片。'))
    await waitForStatus(value.runtime, first.id, ['awaiting_execution'])
    const firstPlan = await value.runtime.claimPlan(first.id)
    const layout = firstPlan?.tools[0]
    if (layout?.kind !== 'scene_batch') throw new Error('Expected layout plan.')
    const layoutResult = bus.execute({ id: value.ids(), origin: 'agent', summary: layout.summary, commands: layout.commands })
    if (!layoutResult.ok) throw new Error(layoutResult.error.message)
    await value.runtime.complete({ runId: first.id, outcomes: [{ toolIndex: 0, ok: true, batchId: layoutResult.batch.id, jobId: null, affectedElementIds: layoutResult.scene.elements.map((element) => element.id), message: 'ok' }] })
    const title = bus.getScene().elements.find((element) => element.type === 'text')
    const bottle = bus.getScene().elements.find((element) => element.type === 'placeholder')
    if (title?.type !== 'text' || bottle === undefined) throw new Error('Fixture elements missing.')

    const second = await value.runtime.start(request(bus.getScene(), '更厚一点，并向左移动', [title]))
    await waitForStatus(value.runtime, second.id, ['awaiting_execution'])
    const secondPlan = await value.runtime.claimPlan(second.id)
    const adjustment = secondPlan?.tools[0]
    if (adjustment?.kind !== 'scene_batch') throw new Error('Expected selected update.')
    const beforeBottle = { ...bottle.transform }
    const result = bus.execute({ id: value.ids(), origin: 'agent', summary: adjustment.summary, commands: adjustment.commands })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.scene.elements.find((element) => element.id === title.id)).toMatchObject({
      transform: { x: title.transform.x - 0.08 },
      styleDescription: expect.stringContaining('更厚重')
    })
    expect(result.scene.elements.find((element) => element.id === bottle.id)?.transform).toEqual(beforeBottle)
    await value.runtime.complete({ runId: second.id, outcomes: [{ toolIndex: 0, ok: true, batchId: result.batch.id, jobId: null, affectedElementIds: [title.id], message: 'ok' }] })

    const third = await value.runtime.start(request(bus.getScene(), '把选中的香水瓶置顶', [bottle]))
    await waitForStatus(value.runtime, third.id, ['awaiting_execution'])
    const thirdPlan = await value.runtime.claimPlan(third.id)
    const reorder = thirdPlan?.tools[0]
    if (reorder?.kind !== 'scene_batch') throw new Error('Expected reorder batch.')
    expect(reorder.commands).toEqual([{
      kind: 'element.reorder',
      elementId: bottle.id,
      toIndex: bus.getScene().elements.length - 1
    }])
    const reordered = bus.execute({ id: value.ids(), origin: 'agent', summary: reorder.summary, commands: reorder.commands })
    if (!reordered.ok) throw new Error(reordered.error.message)
    expect(reordered.scene.elements.at(-1)?.id).toBe(bottle.id)
    await value.runtime.complete({ runId: third.id, outcomes: [{ toolIndex: 0, ok: true, batchId: reordered.batch.id, jobId: null, affectedElementIds: [bottle.id], message: 'ok' }] })
    await value.runtime.close()
    await value.opened.workspace.close(true)
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
    await expect(value.runtime.claimPlan(started.id)).resolves.toBeNull()
    const waiting = await value.runtime.snapshot()
    expect(waiting.activities.find((activity) => activity.kind === 'decision')).toMatchObject({
      state: 'waiting',
      decision: {
        status: 'waiting',
        defaultOptionId: 'generate',
        options: [expect.objectContaining({ id: 'generate' }), expect.objectContaining({ id: 'keep_canvas' })]
      }
    })
    expect(waiting.activities.find((activity) => activity.kind === 'tool')).toMatchObject({ state: 'queued' })
    await expect(value.runtime.confirm(started.id)).resolves.toMatchObject({ status: 'awaiting_execution' })
    const plan = await value.runtime.claimPlan(started.id)
    expect(plan?.tools[0]?.kind).toBe('generation')
    await value.runtime.reportToolStarted(started.id, 0)
    await expect(value.runtime.complete({
      runId: started.id,
      outcomes: [{ toolIndex: 0, ok: true, batchId: null, jobId: 'mock-job', affectedElementIds: [], message: 'queued' }]
    })).resolves.toMatchObject({ status: 'completed' })
    await value.runtime.close()
    await value.opened.workspace.close(true)
  })

  it('persists an aspect-ratio decision and executes no tool until the user chooses', async () => {
    const value = await harness()
    const started = await value.runtime.start(request(
      value.opened.scene,
      '创建一张雨夜唱片封面，标题是 AFTER RAIN，黑胶唱片放在右下方。先不要生成图片。'
    ))
    await waitForStatus(value.runtime, started.id, ['awaiting_confirmation'])
    expect(value.opened.scene.elements).toHaveLength(0)
    await expect(value.runtime.claimPlan(started.id)).resolves.toBeNull()
    const before = await value.runtime.snapshot()
    expect(before.activities.find((activity) => activity.kind === 'decision')).toMatchObject({
      state: 'waiting',
      decision: { kind: 'aspect_ratio', status: 'waiting', defaultOptionId: '4:5' }
    })

    await value.runtime.close()
    await value.opened.workspace.close(true)
    const reopened = await ProjectWorkspace.open(value.projectDirectory, { idFactory: value.ids })
    const repository = new ConversationRepository(join(value.projectDirectory, 'project.db'), { idFactory: value.ids })
    const activityLedger = new ActivityLedgerRepository(join(value.projectDirectory, 'project.db'), { idFactory: value.ids })
    const resumed = new AgentRuntime({
      projectId: reopened.workspace.metadata.id,
      repository,
      activityLedger,
      planner: new DeterministicMockPlanner({ delayMs: 1, idFactory: value.ids })
    })
    await resumed.initialize()
    await expect(resumed.snapshot()).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: started.id, status: 'awaiting_confirmation' })],
      activities: expect.arrayContaining([expect.objectContaining({ kind: 'decision', state: 'waiting', recoverable: true })])
    })
    await expect(resumed.confirm(started.id, '3:2')).resolves.toMatchObject({ status: 'awaiting_execution' })
    const plan = await resumed.claimPlan(started.id)
    const sceneTool = plan?.tools[0]
    if (sceneTool?.kind !== 'scene_batch') throw new Error('Expected scene batch after decision.')
    expect(sceneTool.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scene.set-canvas', canvas: expect.objectContaining({ aspectWidth: 3, aspectHeight: 2 }) })
    ]))
    await resumed.cancel(started.id)
    await resumed.close()
    await reopened.workspace.close(true)
  })

  it('routes an explicit request on a populated scene through canvas reference generation', async () => {
    const value = await harness()
    const fixture = createNightVeilScene()
    const populated = sceneSchema.parse({ ...fixture, projectId: value.opened.workspace.metadata.id })
    const started = await value.runtime.start(request(populated, '现在生成图片'))
    await waitForStatus(value.runtime, started.id, ['awaiting_execution'])
    const plan = await value.runtime.claimPlan(started.id)
    expect(plan?.tools).toEqual([expect.objectContaining({
      kind: 'canvas_generation',
      originalRequirement: '现在生成图片',
      sourceMessageId: expect.any(String)
    })])
    await value.runtime.cancel(started.id)
    await value.runtime.close()
    await value.opened.workspace.close(true)
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
    await waitForStatus(value.runtime, started.id, ['awaiting_execution'])
    const plan = await value.runtime.claimPlan(started.id)
    expect(plan?.tools).toEqual([expect.objectContaining({
      kind: 'canvas_edit',
      targetElementId: target.id,
      prompt: '把蒙版标记的局部改成柔和蓝色玻璃',
      sourceMessageId: expect.any(String)
    })])
    await value.runtime.cancel(started.id)
    await value.runtime.close()
    await value.opened.workspace.close(true)
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
    await waitForStatus(value.runtime, started.id, ['awaiting_execution'])
    const plan = await value.runtime.claimPlan(started.id)

    expect(scene.elements).toHaveLength(1)
    expect(scene.elements.some((element) => element.type === 'mask')).toBe(false)
    expect(plan?.tools).toEqual([expect.objectContaining({
      kind: 'canvas_edit',
      targetElementId: target.id,
      prompt: annotatedRequest.text,
      ephemeralAnnotation
    })])
    await value.runtime.cancel(started.id)
    await value.runtime.close()
    await value.opened.workspace.close(true)
  })

  it('stops planning on cancellation and timeout without producing a plan or scene mutation', async () => {
    const cancelledValue = await harness({ planner: new DeterministicMockPlanner({ delayMs: 200 }) })
    const cancelled = await cancelledValue.runtime.start(request(cancelledValue.opened.scene, '做一张 4:5 香水海报'))
    await cancelledValue.runtime.cancel(cancelled.id)
    await expect(cancelledValue.runtime.snapshot()).resolves.toMatchObject({ runs: [expect.objectContaining({ status: 'cancelled' })] })
    await cancelledValue.runtime.close()
    await cancelledValue.opened.workspace.close(true)

    const timedValue = await harness({ planner: new DeterministicMockPlanner({ delayMs: 200 }), timeoutMs: 10 })
    const timed = await timedValue.runtime.start(request(timedValue.opened.scene, '做一张 4:5 香水海报'))
    await waitForStatus(timedValue.runtime, timed.id, ['timed_out'])
    await expect(timedValue.runtime.snapshot()).resolves.toMatchObject({
      runs: [expect.objectContaining({ status: 'timed_out', errorCode: 'AGENT_TIMEOUT' })]
    })
    await timedValue.runtime.close()
    await timedValue.opened.workspace.close(true)
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
    const bus = new CommandBus(value.opened.scene)
    const before = bus.getScene()
    const started = await value.runtime.start(request(before, '执行无效修改'))
    await waitForStatus(value.runtime, started.id, ['awaiting_execution'])
    const plan = await value.runtime.claimPlan(started.id)
    const tool = plan?.tools[0]
    if (tool?.kind !== 'scene_batch') throw new Error('Expected invalid scene batch.')
    const result = bus.execute({ id: value.ids(), origin: 'agent', summary: tool.summary, commands: tool.commands })
    expect(result.ok).toBe(false)
    expect(bus.getScene()).toEqual(before)
    const completed = await value.runtime.complete({
      runId: started.id,
      outcomes: [{ toolIndex: 0, ok: false, batchId: null, jobId: null, affectedElementIds: [], message: result.ok ? '' : result.error.message }]
    })
    expect(completed.status).toBe('failed')
    await expect(value.runtime.snapshot()).resolves.toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant', kind: 'error', content: expect.not.stringContaining('element.update') }]
    })
    const safeFailure = await value.runtime.snapshot()
    expect(safeFailure.messages[1]?.receipt?.items[0]?.impact).toBe('画布修改未提交，没有产生部分变更')
    expect(safeFailure.runs[0]?.errorMessage).not.toContain('element.update')
    expect(JSON.stringify(safeFailure.activities)).not.toContain('element.update')
    await value.runtime.close()
    await value.opened.workspace.close(true)
  })
})
