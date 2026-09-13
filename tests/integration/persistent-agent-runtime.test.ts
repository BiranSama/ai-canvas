import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ActivityLedgerRepository,
  AgentHarnessRepository,
  AgentRuntime,
  ConversationRepository,
  ScriptedPlannerAdapter,
  type AgentPlanner
} from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { AgentPlan, AgentRequest, AgentRunStatus } from '../../src/shared/agent'

const roots: string[] = []

function ids(): () => string {
  let value = 15_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(projectRevision = 0): AgentRequest {
  return {
    text: '建立 1:1 本地构图，不调用真实 API',
    sceneSummary: {
      revision: projectRevision,
      canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024, globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null,
    autoGenerate: false, activeGenerationJobId: null
  }
}

async function waitFor(runtime: AgentRuntime, runId: string, status: AgentRunStatus): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    if ((await runtime.snapshot()).runs.find((run) => run.id === runId)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Run ${runId} did not reach ${status}.`)
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S4 compatibility projection', () => {
  it('records a local refinement appended after the original plan without losing the completed step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-refinement-projection-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'refinement.aicanvas'), 'Refinement', { idFactory: nextId })
    const databasePath = join(opened.workspace.directory, 'project.db')
    const first: AgentPlan['tools'][number] = { kind: 'scene_batch', summary: '改写主题', commands: [{ kind: 'scene.set-canvas', canvas: { ...opened.scene.canvas, globalStyle: '唐宋八大家' } }] }
    const refinement: AgentPlan['tools'][number] = { ...first, summary: '本地设计精修（仅此一次）' }
    const plan: AgentPlan = { summary: '更新作品', response: '更新完成', nextAction: null, tools: [first] }
    const executed: number[] = []
    const runtime = new AgentRuntime({
      projectId: opened.workspace.metadata.id,
      repository: new ConversationRepository(databasePath, { idFactory: nextId }),
      activityLedger: new ActivityLedgerRepository(databasePath, { idFactory: nextId }),
      harnessRepository: new AgentHarnessRepository(databasePath, { idFactory: nextId }),
      planner: { plan: async () => plan },
      plannerAdapter: new ScriptedPlannerAdapter([
        { kind: 'tool', call: first, toolIndex: 0, plan },
        { kind: 'tool', call: refinement, toolIndex: 1, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '更新完成', notes: [], nextAction: null } }
      ]),
      executePersistentTool: async (_tool, context) => {
        executed.push(context.toolIndex)
        return { toolIndex: context.toolIndex, ok: true, batchId: nextId(), jobId: null, affectedElementIds: [], message: `步骤 ${context.toolIndex} 已保存` }
      }
    })
    try {
      await runtime.initialize()
      const run = await runtime.start(request(opened.scene.revision))
      await waitFor(runtime, run.id, 'completed')
      const snapshot = await runtime.snapshot()
      expect(executed).toEqual([0, 1])
      expect(snapshot.runs.find(r => r.id === run.id)).toMatchObject({ status: 'completed', stepCount: 2 })
      const activities = snapshot.activities.filter(a => a.runId === run.id && a.kind === 'tool')
      expect(activities).toHaveLength(2)
      expect(activities.every(a => a.state === 'completed' && a.operationBatchId !== null)).toBe(true)
      expect(activities[0]!.events.filter(e => e.eventType === 'tool.completed')).toHaveLength(1)
      expect((await runtime.harnessSnapshot()).turns[0]).toMatchObject({ status: 'completed', toolCallsUsed: 2 })
    } finally { await runtime.close(); await opened.workspace.close(true) }
  })

  it('drives the legacy Conversation projection from the persistent Main loop without renderer claiming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-runtime-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'runtime.aicanvas'), 'Runtime project', { idFactory: nextId })
    const databasePath = join(opened.workspace.directory, 'project.db')
    const planner: AgentPlanner = {
      plan: async () => ({
        summary: '建立本地构图',
        response: '本地构图已完成。',
        nextAction: null,
        tools: [{
          kind: 'scene_batch',
          summary: '设置画布风格',
          commands: [{ kind: 'scene.set-canvas', canvas: { ...opened.scene.canvas, globalStyle: 'local-only' } }]
        }]
      })
    }
    const runtime = new AgentRuntime({
      projectId: opened.workspace.metadata.id,
      repository: new ConversationRepository(databasePath, { idFactory: nextId }),
      activityLedger: new ActivityLedgerRepository(databasePath, { idFactory: nextId }),
      harnessRepository: new AgentHarnessRepository(databasePath, { idFactory: nextId }),
      planner,
      executePersistentTool: async (_tool, context) => ({
        toolIndex: context.toolIndex,
        ok: true,
        batchId: nextId(),
        jobId: null,
        affectedElementIds: [],
        message: 'Main host completed the local tool.'
      })
    })
    await runtime.initialize()
    const run = await runtime.start(request(opened.scene.revision))
    await waitFor(runtime, run.id, 'completed')

    const conversation = await runtime.snapshot()
    expect(conversation.messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'receipt', content: '本地构图已完成。' })
    expect(await runtime.claimPlan(run.id)).toBeNull()
    const harness = await runtime.harnessSnapshot()
    expect(harness.turns[0]).toMatchObject({ inputMessageId: run.id, status: 'completed', toolCallsUsed: 1 })
    expect((await runtime.replayHarnessEvents(0)).map((event) => event.type)).toEqual(expect.arrayContaining([
      'turn.started', 'item.started', 'item.completed', 'turn.assessed'
    ]))
    await runtime.close()
    await opened.workspace.close(true)
  })

  it('reuses the compatibility Tool activity ordinal when a recoverable failure triggers re-planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-runtime-replan-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'runtime-replan.aicanvas'), 'Runtime replan project', { idFactory: nextId })
    const databasePath = join(opened.workspace.directory, 'project.db')
    let executions = 0
    const planner: AgentPlanner = {
      plan: async () => ({
        summary: '建立可恢复构图',
        response: '可恢复构图已完成。',
        nextAction: null,
        tools: [{
          kind: 'scene_batch',
          summary: '设置画布风格',
          commands: [{ kind: 'scene.set-canvas', canvas: { ...opened.scene.canvas, globalStyle: 'replanned-local-only' } }]
        }]
      })
    }
    const runtime = new AgentRuntime({
      projectId: opened.workspace.metadata.id,
      repository: new ConversationRepository(databasePath, { idFactory: nextId }),
      activityLedger: new ActivityLedgerRepository(databasePath, { idFactory: nextId }),
      harnessRepository: new AgentHarnessRepository(databasePath, { idFactory: nextId }),
      planner,
      refreshPersistentRequest: async (value) => ({
        ...value,
        sceneSummary: { ...value.sceneSummary, revision: value.sceneSummary.revision + 1 }
      }),
      executePersistentTool: async (_tool, context) => {
        executions += 1
        if (executions === 1) {
          const error = new Error('Synthetic stale scene revision.') as Error & { code: string; recoverable: boolean }
          error.code = 'SCENE_REVISION_STALE'
          error.recoverable = true
          throw error
        }
        return {
          toolIndex: context.toolIndex,
          ok: true,
          batchId: nextId(),
          jobId: null,
          affectedElementIds: [],
          message: 'Main host completed the refreshed local tool.'
        }
      }
    })
    await runtime.initialize()
    const run = await runtime.start(request(opened.scene.revision))
    await waitFor(runtime, run.id, 'completed')

    const [conversation, harness] = await Promise.all([runtime.snapshot(), runtime.harnessSnapshot()])
    const toolActivities = conversation.activities.filter((activity) => activity.runId === run.id && activity.kind === 'tool')
    expect(executions).toBe(2)
    expect(toolActivities).toHaveLength(1)
    expect(toolActivities[0]).toMatchObject({
      state: 'completed',
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: 'tool.replanned', state: 'queued' }),
        expect.objectContaining({ eventType: 'tool.completed', state: 'completed' })
      ])
    })
    expect(harness.turns[0]).toMatchObject({ status: 'completed', recoveryAttemptsUsed: 1 })
    await runtime.close()
    await opened.workspace.close(true)
  })

  it('projects sequential decisions for one persistent run without violating run uniqueness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-runtime-decisions-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'runtime-decisions.aicanvas'), 'Runtime decisions project', { idFactory: nextId })
    const databasePath = join(opened.workspace.directory, 'project.db')
    const planner: AgentPlanner = {
      plan: async () => ({
        summary: '分两步更新本地画布',
        response: '两步本地修改已完成。',
        nextAction: null,
        tools: [
          {
            kind: 'scene_batch',
            summary: '先设置画布风格',
            commands: [{ kind: 'scene.set-canvas', canvas: { ...opened.scene.canvas, globalStyle: 'reviewed-local-only' } }]
          },
          {
            kind: 'scene_batch',
            summary: '再细化画布风格',
            commands: [{ kind: 'scene.set-canvas', canvas: { ...opened.scene.canvas, globalStyle: 'reviewed-local-only refined' } }]
          }
        ]
      })
    }
    const runtime = new AgentRuntime({
      projectId: opened.workspace.metadata.id,
      repository: new ConversationRepository(databasePath, { idFactory: nextId }),
      activityLedger: new ActivityLedgerRepository(databasePath, { idFactory: nextId }),
      harnessRepository: new AgentHarnessRepository(databasePath, { idFactory: nextId }),
      planner,
      executePersistentTool: async (_tool, context) => ({
        toolIndex: context.toolIndex,
        ok: true,
        batchId: nextId(),
        jobId: null,
        affectedElementIds: [],
        message: `Main host completed local tool ${context.toolIndex}.`
      })
    })
    await runtime.initialize()
    const run = await runtime.start(request(opened.scene.revision), 'review')
    await waitFor(runtime, run.id, 'awaiting_confirmation')

    await runtime.confirm(run.id, 'apply_once')
    await waitFor(runtime, run.id, 'awaiting_confirmation')
    const secondWait = await runtime.snapshot()
    const decisionActivities = secondWait.activities.filter((activity) => activity.runId === run.id && activity.kind === 'decision')
    expect(decisionActivities).toHaveLength(2)
    expect(decisionActivities.filter((activity) => activity.state === 'waiting')).toHaveLength(1)
    expect(decisionActivities.find((activity) => activity.state === 'waiting')?.decision).toMatchObject({
      status: 'waiting',
      defaultOptionId: 'stop'
    })

    await runtime.confirm(run.id, 'apply_once')
    await waitFor(runtime, run.id, 'completed')
    expect((await runtime.snapshot()).runs[0]).toMatchObject({ status: 'completed', errorCode: null })
    await runtime.close()
    await opened.workspace.close(true)
  })
})
