import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentContextRepository,
  AgentHarnessRepository,
  buildCreativePlan,
  PersistentAgentLoop,
  type PlannerAdapter
} from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { AgentRequest, AgentToolOutcome, AgentToolPlan } from '../../src/shared/agent'
import type { TaskRelation } from '../../src/shared/agent-harness'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function idFactory(): () => string {
  let value = 31_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(text: string): AgentRequest {
  return {
    text,
    sceneSummary: {
      revision: 0,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    ephemeralAnnotation: null,
    autoGenerate: false,
    activeGenerationJobId: null
  }
}

const temporaryCanvasOnlyTool = {
  kind: 'scene_batch',
  summary: '临时语义构图候选',
  commands: [{
    kind: 'scene.set-canvas',
    canvas: {
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 1024,
      outputHeight: 1280,
      backgroundColor: '#F5F7FA',
      transparent: false,
      globalStyle: 'temporary candidate'
    }
  }]
} satisfies AgentToolPlan

async function createHarness(options: {
  readonly planner?: PlannerAdapter
  readonly executeTool?: (tool: AgentToolPlan, toolIndex: number, signal: AbortSignal) => Promise<AgentToolOutcome>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-task-semantics-'))
  roots.push(root)
  const ids = idFactory()
  const opened = await ProjectWorkspace.create(join(root, 'semantics.aicanvas'), 'Task semantics', { idFactory: ids })
  const databasePath = join(opened.workspace.directory, 'project.db')
  const repository = new AgentHarnessRepository(databasePath, {
    idFactory: ids,
    now: () => '2026-08-30T13:00:00.000+08:00'
  })
  const contextRepository = new AgentContextRepository(databasePath, {
    idFactory: ids,
    now: () => '2026-08-30T13:00:00.000+08:00'
  })
  const requests = new Map<string, AgentRequest>()
  const observedRecent = new Map<string, readonly string[]>()
  const observedBriefIds = new Map<string, string | null>()
  const planner: PlannerAdapter = options.planner ?? {
    next: async (input) => {
      const recent = input.contextManifest?.entries.find((entry) => entry.sourceId === 'recent-conversation')?.content as {
        readonly messages?: ReadonlyArray<{ readonly payload?: { readonly text?: string } }>
      } | undefined
      observedRecent.set(input.request.text, recent?.messages?.map((message) => message.payload?.text ?? '') ?? [])
      observedBriefIds.set(input.request.text, input.request.sceneSummary.creativeBrief?.id ?? null)
      if (input.turn.taskRelation === 'temporary_try' && !input.items.some((item) => item.type === 'tool_call')) {
        const creativeContext = buildCreativePlan(input.request, ids, '2026-08-30T13:00:00.000+08:00')
        return {
          step: {
            kind: 'tool',
            call: {
              ...temporaryCanvasOnlyTool,
              commands: [
                ...temporaryCanvasOnlyTool.commands,
                { kind: 'scene.set-creative-context', creativeContext }
              ]
            },
            toolIndex: 0,
            plan: null
          },
          modelTurns: 0
        }
      }
      return {
        step: {
          kind: 'complete',
          assessment: { status: 'completed', summary: `完成：${input.request.text}`, notes: [], nextAction: null }
        },
        modelTurns: 0
      }
    }
  }
  const loop = new PersistentAgentLoop({
    projectId: opened.workspace.metadata.id,
    repository,
    contextRepository,
    planner,
    now: () => '2026-08-30T13:00:01.000+08:00',
    loadRequest: async (runId) => {
      const stored = requests.get(runId)
      if (stored === undefined) throw new Error(`Missing request ${runId}`)
      return stored
    },
    executeTool: async (tool, context) => options.executeTool?.(tool, context.toolIndex, context.signal) ?? ({
      toolIndex: context.toolIndex,
      ok: true,
      batchId: ids(),
      jobId: null,
      affectedElementIds: [],
      message: tool.kind === 'scene_batch' ? tool.summary : 'done'
    })
  })
  await loop.initialize()
  closers.push(async () => {
    await loop.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return {
    loop,
    databasePath,
    requests,
    observedRecent,
    observedBriefIds,
    start: async (index: number, relation: TaskRelation, text: string) => {
      const runId = `semantic-run-${index}`
      const value = request(text)
      requests.set(runId, value)
      const turn = await loop.start({
        legacyRunId: runId,
        sourceMessageId: `${runId}-message`,
        request: value,
        taskRelation: relation,
        dispatchMode: 'apply_now'
      })
      await loop.waitForIdle()
      return turn
    }
  }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Product 1.0 task semantics lifecycle', () => {
  it('runs a 20-turn mixed relation script without leaking old task instructions into a new task', async () => {
    const value = await createHarness()
    const relations: readonly TaskRelation[] = [
      'new_task', 'continue_current', 'supplement_current', 'revise_current', 'temporary_try',
      'new_task', 'continue_current', 'supplement_current', 'revise_current', 'temporary_try',
      'new_task', 'continue_current', 'supplement_current', 'revise_current', 'temporary_try',
      'new_task', 'continue_current', 'supplement_current', 'revise_current', 'temporary_try'
    ]
    for (const [index, relation] of relations.entries()) {
      const turn = await value.start(index + 1, relation, `${relation} · round ${index + 1}`)
      if (relation === 'temporary_try') await value.loop.resolveTemporaryTry(turn.id, 'reject')
    }

    const snapshot = await value.loop.snapshot()
    expect(snapshot.turns).toHaveLength(20)
    expect(snapshot.turns.filter((turn) => turn.taskRelation === 'temporary_try')).toHaveLength(4)
    expect(snapshot.turns.filter((turn) => turn.temporaryState === 'rejected')).toHaveLength(4)
    const formalTaskIds = new Set(snapshot.turns
      .filter((turn) => turn.taskRelation !== 'temporary_try')
      .map((turn) => turn.taskId))
    expect(formalTaskIds.size).toBe(4)

    const secondTaskFirstRequest = value.observedRecent.get('new_task · round 6') ?? []
    expect(secondTaskFirstRequest).toContain('new_task · round 6')
    expect(secondTaskFirstRequest.some((text) => text.includes('round 1'))).toBe(false)
    expect(secondTaskFirstRequest.some((text) => text.includes('round 5'))).toBe(false)
  })

  it('keeps the current Brief for continuation but removes it from a new task planner context', async () => {
    const value = await createHarness()
    const ids = idFactory()
    const baseRequest = request('创建一张 4:5 安静的植物封面，主体是叶片，先不要生成图片')
    const context = buildCreativePlan(baseRequest, ids, '2026-08-30T13:00:00.000+08:00')
    const withBrief = (text: string): AgentRequest => ({
      ...request(text),
      sceneSummary: {
        ...request(text).sceneSummary,
        creativeBrief: context.brief,
        creativeContext: context
      }
    })
    const continueRequest = withBrief('继续完善当前植物封面')
    value.requests.set('semantic-brief-continue', continueRequest)
    await value.loop.start({
      legacyRunId: 'semantic-brief-continue',
      sourceMessageId: 'semantic-brief-continue-message',
      request: continueRequest,
      taskRelation: 'continue_current',
      dispatchMode: 'apply_now'
    })
    await value.loop.waitForIdle()
    const newRequest = withBrief('这是一个全新的建筑海报任务')
    value.requests.set('semantic-brief-new', newRequest)
    await value.loop.start({
      legacyRunId: 'semantic-brief-new',
      sourceMessageId: 'semantic-brief-new-message',
      request: newRequest,
      taskRelation: 'new_task',
      dispatchMode: 'apply_now'
    })
    await value.loop.waitForIdle()

    expect(value.observedBriefIds.get(continueRequest.text)).toBe(context.brief.id)
    expect(value.observedBriefIds.get(newRequest.text)).toBeNull()
  })

  it('keeps temporary Scene writes and memory out of formal state until an explicit resolution', async () => {
    let writes = 0
    const value = await createHarness({
      executeTool: async (_tool, toolIndex) => {
        writes += 1
        return { toolIndex, ok: true, batchId: `00000000-0000-4000-8000-${String(40_000 + writes).padStart(12, '0')}`, jobId: null, affectedElementIds: [], message: 'committed' }
      }
    })
    const rejected = await value.start(1, 'temporary_try', '临时试一个冷蓝方向')
    expect(writes).toBe(0)
    expect((await value.loop.snapshot()).items.some((item) => item.turnId === rejected.id && item.type === 'scene_change')).toBe(false)
    await value.loop.resolveTemporaryTry(rejected.id, 'reject')
    expect(writes).toBe(0)

    const accepted = await value.start(2, 'temporary_try', '临时试一个暖金方向')
    expect(writes).toBe(0)
    await value.loop.resolveTemporaryTry(accepted.id, 'accept')
    const snapshot = await value.loop.snapshot()
    expect(writes).toBe(1)
    expect(snapshot.turns.find((turn) => turn.id === accepted.id)?.temporaryState).toBe('accepted')
    expect(snapshot.items.some((item) => item.turnId === accepted.id && item.type === 'scene_change'
      && (item.payload as { readonly acceptedTemporaryTry?: boolean }).acceptedTemporaryTry === true)).toBe(true)
  })

  it('keeps an unformalized temporary candidate isolated instead of accepting it without a new Brief', async () => {
    let writes = 0
    const planner: PlannerAdapter = {
      next: async (input) => input.items.some((item) => item.type === 'tool_call')
        ? {
            step: { kind: 'complete', assessment: { status: 'completed', summary: '候选完成', notes: [], nextAction: null } },
            modelTurns: 0
          }
        : { step: { kind: 'tool', call: temporaryCanvasOnlyTool, toolIndex: 0, plan: null }, modelTurns: 0 }
    }
    const value = await createHarness({
      planner,
      executeTool: async (_tool, toolIndex) => {
        writes += 1
        return { toolIndex, ok: true, batchId: '00000000-0000-4000-8000-000000040099', jobId: null, affectedElementIds: [], message: 'committed' }
      }
    })
    const candidate = await value.start(1, 'temporary_try', '只形成局部草图，还没有正式简报')

    await expect(value.loop.resolveTemporaryTry(candidate.id, 'accept'))
      .rejects.toThrow('必须先形成可检查的新创作简报')
    expect(writes).toBe(0)
    expect((await value.loop.snapshot()).turns.find((turn) => turn.id === candidate.id)?.temporaryState).toBe('pending')
  })

  it('persists queued relation, dispatch and order across a repository restart', async () => {
    const value = await createHarness()
    const snapshot = await value.loop.snapshot()
    const firstTaskId = '00000000-0000-4000-8000-000000050001'
    const secondTaskId = '00000000-0000-4000-8000-000000050002'
    const repository = new AgentHarnessRepository(value.databasePath)
    await repository.enqueue(snapshot.thread.id, {
      messageId: 'queued-continue',
      mode: 'queue_next',
      taskId: firstTaskId,
      taskRelation: 'continue_current',
      dispatchMode: 'queue_after_current',
      baseTaskId: null
    })
    await repository.enqueue(snapshot.thread.id, {
      messageId: 'queued-new',
      mode: 'queue_next',
      taskId: secondTaskId,
      taskRelation: 'new_task',
      dispatchMode: 'queue_after_current',
      baseTaskId: null
    })
    await repository.close()
    const reopened = new AgentHarnessRepository(value.databasePath)
    expect(await reopened.listQueue(snapshot.thread.id)).toEqual([
      expect.objectContaining({ position: 0, taskId: firstTaskId, taskRelation: 'continue_current', dispatchMode: 'queue_after_current' }),
      expect.objectContaining({ position: 1, taskId: secondTaskId, taskRelation: 'new_task', dispatchMode: 'queue_after_current' })
    ])
    await reopened.close()
  })

  it('interrupts as a control action without adding a fake user task', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = new Promise<void>((resolve) => { started = resolve })
    const planner: PlannerAdapter = {
      next: async (input) => input.nextToolIndex === 0
        ? { step: { kind: 'tool', call: temporaryCanvasOnlyTool, toolIndex: 0, plan: null }, modelTurns: 0 }
        : { step: { kind: 'complete', assessment: { status: 'completed', summary: 'done', notes: [], nextAction: null } }, modelTurns: 0 }
    }
    const value = await createHarness({
      planner,
      executeTool: async (_tool, toolIndex) => {
        started()
        await gate
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'late' }
      }
    })
    const runId = 'semantic-interrupt'
    const initial = request('建立一个可中断构图')
    value.requests.set(runId, initial)
    await value.loop.start({
      legacyRunId: runId,
      sourceMessageId: `${runId}-message`,
      request: initial,
      taskRelation: 'new_task',
      dispatchMode: 'apply_now'
    })
    await running
    await value.loop.input({
      taskRelation: null,
      dispatchMode: 'interrupt_current',
      request: request('这段控制文本不应保存成创作任务')
    }, async () => { throw new Error('Interrupt must not persist a queued run.') })
    release()
    await value.loop.waitForIdle()
    const snapshot = await value.loop.snapshot()
    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.items.filter((item) => item.type === 'user_message')).toHaveLength(1)
    expect(snapshot.items.some((item) => JSON.stringify(item.payload).includes('这段控制文本'))).toBe(false)
  })
})
