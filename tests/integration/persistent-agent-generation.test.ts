import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentHarnessRepository,
  PersistentAgentLoop,
  ScriptedPlannerAdapter
} from '../../src/main/agent'
import {
  GenerationJobRepository,
  GenerationWorkflowCoordinator,
  GenerationWorkflowRepository,
  type GenerationWorkflowQueuePort
} from '../../src/main/generation'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { openDatabase } from '../../src/main/storage/database'
import type { AgentPlan, AgentRequest, AgentToolPlan } from '../../src/shared/agent'
import type { GenerationRequest, ProviderCapabilities } from '../../src/shared/generation'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function ids(): () => string {
  let value = 91_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

const capabilities: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: true,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png']
}

function agentRequest(): AgentRequest {
  return {
    text: '直接生成一张本地 Mock 图片',
    sceneSummary: {
      revision: 2,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 320, outputHeight: 400, globalStyle: '' },
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

function generationRequest(): GenerationRequest {
  return {
    prompt: 'Durable AH1 waiting Job',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 320,
    outputHeight: 400,
    count: 1,
    providerId: 'mock',
    model: 'mock-slow',
    references: [],
    parameters: {
      generationProfileId: 'local-sketch',
      generationProfileTier: 'local-sketch',
      actualCostCny: 0
    },
    sourceMessageId: 'message-generation',
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: ''
  }
}

const generationTool: AgentToolPlan = { kind: 'generation', request: generationRequest() }
const plan: AgentPlan = {
  summary: '创建并观察本地生成任务',
  response: '本地生成任务已经观察完成。',
  nextAction: null,
  tools: [generationTool]
}

function planner() {
  return new ScriptedPlannerAdapter([
    { kind: 'tool', call: generationTool, toolIndex: 0, plan },
    { kind: 'complete', assessment: { status: 'completed', summary: plan.response, notes: [], nextAction: null } }
  ])
}

async function fixture(createPlanner = planner) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-agent-generation-'))
  roots.push(root)
  const nextId = ids()
  const opened = await ProjectWorkspace.create(join(root, 'agent-generation.aicanvas'), 'Agent generation', { idFactory: nextId })
  const databasePath = join(opened.workspace.directory, 'project.db')
  const jobs = new GenerationJobRepository(databasePath, { idFactory: nextId })
  let postCount = 0
  const createLoop = async () => {
    const workflows = new GenerationWorkflowRepository(databasePath, { idFactory: nextId })
    const queue: GenerationWorkflowQueuePort = {
      enqueue: async (request) => {
        postCount += 1
        return jobs.createJob({ projectId: opened.workspace.metadata.id, request })
      },
      listJobs: () => jobs.listJobs(opened.workspace.metadata.id),
      cancel: (jobId) => jobs.requestCancel(jobId)
    }
    const coordinator = new GenerationWorkflowCoordinator({ repository: workflows, queue, idFactory: nextId })
    const loop = new PersistentAgentLoop({
      projectId: opened.workspace.metadata.id,
      repository: new AgentHarnessRepository(databasePath, { idFactory: nextId }),
      generationWorkflowRepository: workflows,
      loadGenerationJob: (jobId) => jobs.getJob(jobId),
      planner: createPlanner(),
      loadRequest: async () => agentRequest(),
      executeTool: async (_tool, context) => {
        const created = await coordinator.create({
          projectId: opened.workspace.metadata.id,
          threadId: context.threadId,
          turnId: context.turnId,
          toolCallItemId: context.toolCallItemId,
          sourceMessageId: context.sourceMessageId,
          request: generationRequest(),
          capabilities,
          profileId: 'local-sketch',
          tier: 'local-sketch',
          operation: 'text',
          sourceSceneRevision: 2,
          promptPackage: { version: 1, originalRequirement: generationRequest().prompt },
          idempotencyKey: `turn:${context.turnId}:item:${context.toolCallItemId}:generation.create:v1`,
          limits: { maxJobs: 1, maxImages: 1, maxCostCny: 0, maxWallTimeMs: 120_000, noImprovementLimit: 1 },
          estimatedCostCny: 0
        })
        return {
          toolIndex: context.toolIndex,
          ok: true,
          batchId: null,
          jobId: created.job.id,
          affectedElementIds: [],
          message: '本地任务已创建。'
        }
      }
    })
    await loop.initialize()
    return { loop, workflows }
  }
  closers.push(async () => {
    await jobs.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return { opened, jobs, databasePath, createLoop, postCount: () => postCount }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S7 persistent Agent generation subscription', () => {
  it.each([false, true])('does not let an earlier terminal wake the next Job, finalization fault=%s', async (finalizationFault) => {
    const twoJobs = { ...plan, tools: [generationTool, generationTool] }
    const value = await fixture(() => new ScriptedPlannerAdapter([
      { kind: 'tool', call: generationTool, toolIndex: 0, plan: twoJobs },
      { kind: 'tool', call: generationTool, toolIndex: 1, plan: null },
      { kind: 'complete', assessment: { status: 'completed', summary: 'Both jobs completed', notes: [], nextAction: null } }
    ]))
    const active = await value.createLoop()
    try {
      await active.loop.start({ legacyRunId: 'two-job-events', sourceMessageId: 'two-job-events', request: agentRequest(), mode: 'auto' })
      await active.loop.waitForIdle()
      const firstId = (await value.jobs.listJobs(value.opened.workspace.metadata.id))[0]!.id
      await value.jobs.transition(firstId, { status: 'preparing', stage: 'validating', startedAt: new Date().toISOString() })
      const firstEnded = await value.jobs.transition(firstId, { status: 'completed', stage: 'completed', completedAt: new Date().toISOString() })
      await active.loop.observeGenerationJob(firstEnded)
      await active.loop.waitForIdle()
      const secondId = (await value.jobs.listJobs(value.opened.workspace.metadata.id)).find((job) => job.id !== firstId)!.id
      expect((await active.loop.snapshot()).turns[0]?.status).toBe('waiting_job')
      await active.loop.observeGenerationJob(firstEnded)
      await active.loop.waitForIdle()
      expect((await active.loop.snapshot()).turns[0]?.status).toBe('waiting_job')
      expect((await active.workflows.listWaitingSubscriptions()).map((item) => item.jobId)).toEqual([secondId])
      await value.jobs.transition(secondId, { status: 'preparing', stage: 'validating', startedAt: new Date().toISOString() })
      const secondEnded = await value.jobs.transition(secondId, { status: 'failed', stage: 'failed', completedAt: new Date().toISOString() })
      if (finalizationFault) {
        const fault = openDatabase(value.databasePath)
        fault.sqlite.exec(`CREATE TRIGGER second_terminal_failure BEFORE UPDATE ON agent_turns_v2
          WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'SECOND_TERMINAL_FAILURE'); END;`)
        await expect(active.loop.observeGenerationJob(secondEnded)).rejects.toThrow('SECOND_TERMINAL_FAILURE')
        expect((await active.loop.snapshot()).turns[0]?.status).toBe('waiting_job')
        fault.sqlite.exec('DROP TRIGGER second_terminal_failure')
        fault.sqlite.close()
        await active.loop.observeGenerationJob(firstEnded)
        await active.loop.waitForIdle()
        expect((await active.loop.snapshot()).turns[0]?.status).toBe('waiting_job')
        expect(value.postCount()).toBe(2)
      }
      await active.loop.observeGenerationJob(secondEnded)
      await active.loop.waitForIdle()
      expect((await active.loop.snapshot()).turns[0]?.status).toBe('failed')
      expect((await active.loop.replay(0)).filter((event) => event.type === 'job.observed')).toHaveLength(2)
      expect(value.postCount()).toBe(2)
    } finally { await active.loop.close() }
  })

  it.each(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const)(
    'reconciles %s once across consumed events, restart and stale notifications', async (status) => {
      const value = await fixture()
      const first = await value.createLoop()
      const turn = await first.loop.start({ legacyRunId: `terminal-${status}`, sourceMessageId: 'terminal', request: agentRequest(), mode: 'auto' })
      await first.loop.waitForIdle()
      const waiting = (await first.loop.snapshot()).items.find((item) => item.type === 'generation_subscription')!
      const jobId = (waiting.payload as { jobId: string }).jobId
      const stale = await value.jobs.getJob(jobId)
      await value.jobs.transition(jobId, { status: 'preparing', stage: 'validating', startedAt: new Date().toISOString() })
      const ended = await value.jobs.transition(jobId, { status, stage: status, completedAt: new Date().toISOString(),
        ...(status === 'completed' ? {} : { error: { code: `TEST_${status.toUpperCase()}`, message: 'Offline terminal fixture', stage: status } }) })
      // Reproduce the historical crash gap: Workflow consumed the terminal,
      // but the Agent item and Turn are still waiting in the real database.
      await first.workflows.observeJob(ended)
      await first.workflows.observeSubscriptions(ended)
      expect(await first.workflows.listWaitingSubscriptions()).toHaveLength(0)
      expect((await first.loop.snapshot()).turns[0]?.status).toBe('waiting_job')
      await first.loop.close()
      const resumed = await value.createLoop()
      try {
        await resumed.loop.waitForIdle()
        await Promise.all([resumed.loop.observeGenerationJob(ended), resumed.loop.observeGenerationJob(stale)])
        await resumed.loop.waitForIdle()
        const snapshot = await resumed.loop.snapshot()
        expect(snapshot.turns.find((candidate) => candidate.id === turn.id)?.status).toBe(
          status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed')
        expect(snapshot.items.filter((item) => item.type === 'generation_subscription')).toHaveLength(1)
        expect(snapshot.items.find((item) => item.id === waiting.id)).toMatchObject({ status: 'completed' })
        expect((await resumed.loop.replay(0)).filter((event) => event.type === 'job.observed')).toHaveLength(1)
        expect((await resumed.workflows.getIntentByJob(jobId))?.status).toBe(
          status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed')
        expect(value.postCount()).toBe(1)
      } finally { await resumed.loop.close() }
    })

  it('rolls back Agent observation atomically and recovers after a transaction failure', async () => {
    const value = await fixture()
    const first = await value.createLoop()
    await first.loop.start({ legacyRunId: 'observation-crash', sourceMessageId: 'crash', request: agentRequest(), mode: 'auto' })
    await first.loop.waitForIdle()
    const waiting = (await first.loop.snapshot()).items.find((item) => item.type === 'generation_subscription')!
    const jobId = (waiting.payload as { jobId: string }).jobId
    await value.jobs.transition(jobId, { status: 'preparing', stage: 'validating', startedAt: new Date().toISOString() })
    const ended = await value.jobs.transition(jobId, { status: 'timed_out', stage: 'timed_out', completedAt: new Date().toISOString() })
    const fault = openDatabase(value.databasePath)
    fault.sqlite.exec(`CREATE TRIGGER completion_observation_failure BEFORE UPDATE ON agent_items
      WHEN OLD.type = 'generation_subscription' BEGIN SELECT RAISE(ABORT, 'INJECTED_OBSERVATION_FAILURE'); END;`)
    await expect(first.loop.observeGenerationJob(ended)).rejects.toThrow('INJECTED_OBSERVATION_FAILURE')
    const unchanged = await first.loop.snapshot()
    expect(unchanged.turns[0]?.status).toBe('waiting_job')
    expect(unchanged.items.find((item) => item.id === waiting.id)?.status).toBe('waiting')
    expect((await first.loop.replay(0)).filter((event) => event.type === 'job.observed')).toHaveLength(0)
    fault.sqlite.exec('DROP TRIGGER completion_observation_failure')
    fault.sqlite.close()
    await first.loop.close()
    const resumed = await value.createLoop()
    await resumed.loop.waitForIdle()
    expect((await resumed.loop.snapshot()).turns[0]?.status).toBe('failed')
    expect((await resumed.loop.replay(0)).filter((event) => event.type === 'job.observed')).toHaveLength(1)
    expect(value.postCount()).toBe(1)
    await resumed.loop.close()
  })

  it('can finish a failed Job when failure finalization itself is interrupted', async () => {
    const value = await fixture()
    const active = await value.createLoop()
    await active.loop.start({ legacyRunId: 'terminal-write-crash', sourceMessageId: 'terminal-crash', request: agentRequest(), mode: 'auto' })
    await active.loop.waitForIdle()
    const waiting = (await active.loop.snapshot()).items.find((item) => item.type === 'generation_subscription')!
    const jobId = (waiting.payload as { jobId: string }).jobId
    await value.jobs.transition(jobId, { status: 'preparing', stage: 'validating', startedAt: new Date().toISOString() })
    const ended = await value.jobs.transition(jobId, { status: 'timed_out', stage: 'timed_out', completedAt: new Date().toISOString() })
    const fault = openDatabase(value.databasePath)
    fault.sqlite.exec(`CREATE TRIGGER completion_terminal_failure BEFORE UPDATE ON agent_turns_v2
      WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'INJECTED_TERMINAL_FAILURE'); END;`)
    await expect(active.loop.observeGenerationJob(ended)).rejects.toThrow('INJECTED_TERMINAL_FAILURE')
    const pending = await active.loop.snapshot()
    expect(pending.turns[0]?.status).toBe('waiting_job')
    expect(pending.items.find((item) => item.id === waiting.id)?.status).toBe('completed')
    fault.sqlite.exec('DROP TRIGGER completion_terminal_failure')
    fault.sqlite.close()
    await active.loop.observeGenerationJob(ended)
    await active.loop.waitForIdle()
    expect((await active.loop.snapshot()).turns[0]?.status).toBe('failed')
    expect((await active.loop.replay(0)).filter((event) => event.type === 'job.observed')).toHaveLength(1)
    expect(value.postCount()).toBe(1)
    await active.loop.close()
  })

  it('survives restart, observes the original terminal Job, and resumes without reposting', async () => {
    const value = await fixture()
    const first = await value.createLoop()
    const turn = await first.loop.start({
      legacyRunId: 'run-generation-restart',
      sourceMessageId: 'message-generation',
      request: agentRequest(),
      mode: 'auto'
    })
    await first.loop.waitForIdle()
    const waiting = await first.loop.snapshot()
    const waitingItem = waiting.items.find((item) => item.turnId === turn.id && item.type === 'generation_subscription')
    expect(waiting.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({ status: 'waiting_job' })
    expect(waitingItem).toMatchObject({ status: 'waiting' })
    const jobId = String((waitingItem?.payload as { jobId?: string }).jobId)
    await first.loop.close()

    await value.jobs.transition(jobId, {
      status: 'preparing',
      stage: 'validating',
      startedAt: '2026-08-22T18:59:59.000+08:00'
    })
    await value.jobs.transition(jobId, {
      status: 'completed',
      stage: 'completed',
      completedAt: '2026-08-22T19:00:00.000+08:00'
    })
    const resumed = await value.createLoop()
    await resumed.loop.waitForIdle()
    const completed = await resumed.loop.snapshot()
    expect(completed.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({ status: 'completed' })
    expect(completed.items.find((item) => item.id === waitingItem?.id)).toMatchObject({ status: 'completed' })
    expect((await resumed.loop.replay(0)).map((event) => event.type)).toEqual(expect.arrayContaining([
      'job.waiting', 'job.observed', 'turn.assessed'
    ]))
    expect(value.postCount()).toBe(1)
    await resumed.loop.close()
  })

  it('interrupts only the Agent subscription and leaves the background Job intact', async () => {
    const value = await fixture()
    const active = await value.createLoop()
    const turn = await active.loop.start({
      legacyRunId: 'run-generation-interrupt',
      sourceMessageId: 'message-generation',
      request: agentRequest(),
      mode: 'auto'
    })
    await active.loop.waitForIdle()
    const waiting = await active.loop.snapshot()
    const item = waiting.items.find((candidate) => candidate.turnId === turn.id && candidate.type === 'generation_subscription')
    const jobId = String((item?.payload as { jobId?: string }).jobId)

    await active.loop.input({ mode: 'interrupt_now', request: agentRequest() }, async () => {
      throw new Error('interrupt_now must not create a new run')
    })
    expect((await active.loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)).toMatchObject({ status: 'interrupted' })
    expect(await active.workflows.listWaitingSubscriptions()).toEqual([])
    expect(await value.jobs.getJob(jobId)).toMatchObject({ status: 'queued', cancelRequested: false })
    expect(value.postCount()).toBe(1)
    await active.loop.close()
  })

  it('stops an autonomous generation sequence at the Turn budget without starting a third Job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-generation-budget-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'generation-budget.aicanvas'), 'Generation budget', { idFactory: nextId })
    const tools: AgentToolPlan[] = [0, 1, 2].map((index) => ({
      kind: 'generation',
      request: { ...generationRequest(), prompt: `Bounded generation ${index + 1}` }
    }))
    const boundedPlan: AgentPlan = {
      summary: '验证生成预算停止条件',
      response: '不应执行到该完成消息。',
      nextAction: null,
      tools
    }
    const scripted = new ScriptedPlannerAdapter([
      { kind: 'tool', call: tools[0]!, toolIndex: 0, plan: boundedPlan },
      { kind: 'tool', call: tools[1]!, toolIndex: 1, plan: null },
      { kind: 'tool', call: tools[2]!, toolIndex: 2, plan: null }
    ])
    let executions = 0
    const loop = new PersistentAgentLoop({
      projectId: opened.workspace.metadata.id,
      repository: new AgentHarnessRepository(join(opened.workspace.directory, 'project.db'), { idFactory: nextId }),
      planner: scripted,
      loadRequest: async () => agentRequest(),
      executeTool: async (_tool, context) => {
        executions += 1
        return {
          toolIndex: context.toolIndex,
          ok: true,
          batchId: null,
          jobId: null,
          affectedElementIds: [],
          message: `Mock generation ${executions} completed without network.`
        }
      }
    })
    await loop.initialize()
    const turn = await loop.start({
      legacyRunId: 'run-generation-budget',
      sourceMessageId: 'message-generation-budget',
      request: agentRequest(),
      mode: 'auto'
    })
    await loop.waitForIdle()

    const snapshot = await loop.snapshot()
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'budget_limited',
      errorCode: 'BUDGET_GENERATION_JOBS',
      toolCallsUsed: 2
    })
    expect(snapshot.items.filter((item) => item.turnId === turn.id && item.type === 'tool_call')).toHaveLength(2)
    expect(executions).toBe(2)

    await loop.close()
    await opened.workspace.close(true)
  })
})
