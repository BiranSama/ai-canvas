import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import {
  AgentContextRepository,
  AgentHarnessRepository,
  DeterministicCreativePlannerAdapter,
  AgentPlannerError,
  PersistentAgentLoop,
  ScriptedPlannerAdapter,
  type PlannerAdapter
} from '../../src/main/agent'
import type { AgentLoopToolContext, AgentPlanner } from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { AgentPlan, AgentRequest, AgentToolOutcome, AgentToolPlan } from '../../src/shared/agent'
import { DEFAULT_AUTO_BUDGET, DEFAULT_COLLABORATION_BUDGET, DEFAULT_REVIEW_BUDGET, type AgentMode } from '../../src/shared/agent-harness'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function idFactory(): () => string {
  let value = 12_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(text: string, revision = 0): AgentRequest {
  return {
    text,
    sceneSummary: {
      revision,
      canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024, globalStyle: '' },
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

function sceneTool(summary: string): AgentToolPlan {
  return {
    kind: 'scene_batch',
    summary,
    commands: [{
      kind: 'scene.set-canvas',
      canvas: {
        aspectWidth: 1,
        aspectHeight: 1,
        outputWidth: 1024,
        outputHeight: 1024,
        backgroundColor: '#FFFFFF',
        transparent: false,
        globalStyle: summary
      }
    }]
  }
}

function generationTool(): AgentToolPlan {
  return {
    kind: 'generation',
    request: {
      prompt: 'A quiet local Mock study',
      negativePrompt: '',
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 320,
      outputHeight: 400,
      count: 1,
      providerId: 'mock',
      model: 'mock-slow',
      references: [],
      parameters: {},
      sourceMessageId: null,
      parentResultId: null,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: ''
    }
  }
}

async function harness(options: {
  readonly planner: PlannerAdapter
  readonly executeTool?: (
    tool: AgentToolPlan,
    toolIndex: number,
    signal: AbortSignal,
    context: AgentLoopToolContext
  ) => Promise<AgentToolOutcome>
  readonly budget?: typeof DEFAULT_AUTO_BUDGET
  readonly withContext?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s4-'))
  roots.push(root)
  const ids = idFactory()
  const opened = await ProjectWorkspace.create(join(root, 'loop.aicanvas'), 'Loop project', { idFactory: ids })
  const repository = new AgentHarnessRepository(join(opened.workspace.directory, 'project.db'), {
    idFactory: ids,
    now: () => '2026-08-22T12:00:00.000+08:00'
  })
  const contextRepository = options.withContext
    ? new AgentContextRepository(join(opened.workspace.directory, 'project.db'), {
        idFactory: ids,
        now: () => '2026-08-22T12:00:00.000+08:00'
      })
    : null
  const requests = new Map<string, AgentRequest>()
  const loop = new PersistentAgentLoop({
    projectId: opened.workspace.metadata.id,
    repository,
    ...(contextRepository === null ? {} : { contextRepository }),
    planner: options.planner,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    now: () => '2026-08-22T12:00:01.000+08:00',
    loadRequest: async (runId) => {
      const value = requests.get(runId)
      if (value === undefined) throw new Error(`Missing request ${runId}`)
      return value
    },
    executeTool: async (tool, context) => options.executeTool?.(tool, context.toolIndex, context.signal, context) ?? ({
      toolIndex: context.toolIndex,
      ok: true,
      batchId: ids(),
      jobId: null,
      affectedElementIds: [],
      message: tool.kind === 'scene_batch' ? tool.summary : 'completed'
    })
  })
  await loop.initialize()
  closers.push(async () => {
    await loop.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return {
    loop,
    ids,
    requests,
    contextRepository,
    start: async (runId: string, value: AgentRequest, mode?: AgentMode) => {
      requests.set(runId, value)
      return loop.start({
        legacyRunId: runId,
        sourceMessageId: `${runId}-message`,
        request: value,
        ...(mode === undefined ? {} : { mode })
      })
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

describe('AH1 S4 persistent agent loop', () => {
  it('counts a submitted attempt on Harness expiry and records unknown external state', async () => {
    const planner: PlannerAdapter = {
      async next(_input, _signal, context): Promise<never> {
        const event = {
          schemaVersion: 1 as const, attemptId: 'deadline-attempt', requestCorrelationId: context!.requestCorrelationId,
          providerId: 'fixture', providerLabel: 'Fixture', protocol: 'openai-responses' as const, model: 'fixture',
          transportMode: 'stream' as const, attempt: 1, occurredAt: new Date().toISOString(), elapsedMs: 0,
          lastTransportActivityAt: null, lastSemanticProgressAt: null, receivedBytes: 0, recognizedEventCount: 0,
          providerResponseId: null, httpStatus: null, failureCode: null
        }
        await context?.observe?.({ type: 'provider.attempt.reserved', payload: { ...event, phase: 'reserved' } })
        await context?.observe?.({ type: 'provider.attempt.connecting', payload: { ...event, phase: 'connecting' } })
        return new Promise<never>(() => undefined)
      }
    }
    const value = await harness({ planner, budget: { ...DEFAULT_AUTO_BUDGET, maxWallTimeMs: 3_000 } })
    const turn = await value.start('run-paid-deadline', request('建立构图'))
    await value.loop.waitForIdle()
    const snapshot = await value.loop.snapshot()
    expect(snapshot.turns.find((item) => item.id === turn.id)).toMatchObject({ status: 'budget_limited', modelTurnsUsed: 1, recoveryAttemptsUsed: 0 })
    expect(snapshot.items.find((item) => item.type === 'recovery')).toMatchObject({ status: 'failed', payload: {
      failure: { schemaVersion: 2, code: 'BUDGET_WALL_TIME', externalState: 'unknown', remainingCostCny: null }
    } })
  })

  it('preserves validated siblings when a completed model response repairs one invalid tool', async () => {
    const valid = sceneTool('已验证的背景')
    const repaired = sceneTool('修好的主体')
    const attempted = sceneTool('模型不应擅自换掉背景')
    let calls = 0
    const executed: AgentToolPlan[] = []
    const planner: AgentPlanner = { async plan() {
      calls += 1
      if (calls === 1) {
        const error = new AgentPlannerError('MODEL_PLAN_SCHEMA_INVALID', '第二个工具参数无效。')
        Object.defineProperty(error, 'validatedTools', { value: [valid, null] })
        throw error
      }
      return { summary: '修正', response: '已完成', nextAction: null, tools: [attempted, repaired] }
    } }
    const value = await harness({ planner: new DeterministicCreativePlannerAdapter(planner), executeTool: async (tool, toolIndex) => {
      executed.push(tool)
      return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: '完成' }
    } })
    await value.start('run-partial-repair', request('建立 1:1 方形构图'))
    await value.loop.waitForIdle()
    expect(calls).toBe(2)
    expect((await value.loop.snapshot()).turns).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed' })]))
    expect(executed).toEqual([valid, repaired])
    const snapshot = await value.loop.snapshot()
    expect(JSON.stringify(snapshot.items.filter((item) => item.type === 'recovery'))).not.toContain('validatedTools')
  })

  it('stops after two unchanged corrections and persists the final failure lineage', async () => {
    let calls = 0
    const planner: AgentPlanner = { async plan() {
      calls += 1
      throw new AgentPlannerError('MODEL_PLAN_SCHEMA_INVALID', '身份格式无效。', [{ issueCode: 'INVALID_FORMAT', path: 'tools.0.id', expected: 'UUID' }])
    } }
    const value = await harness({ planner: new DeterministicCreativePlannerAdapter(planner) })
    const turn = await value.start('run-repeated-fingerprint', request('创建主体'))
    await value.loop.waitForIdle()
    const snapshot = await value.loop.snapshot()
    expect(calls).toBe(3)
    expect(snapshot.turns.find((item) => item.id === turn.id)).toMatchObject({ status: 'failed', recoveryAttemptsUsed: 2, toolCallsUsed: 0 })
    const failures = snapshot.items.filter((item) => item.type === 'recovery')
    expect(failures.map((item) => item.status)).toEqual(['completed', 'completed', 'failed'])
    expect((await value.loop.replay(0)).some((event) => event.type === 'recovery.exhausted')).toBe(true)
  })
  it('ends a planner that never returns at the remaining Harness deadline', async () => {
    let calls = 0
    const planner: PlannerAdapter = {
      async next(): Promise<never> {
        calls += 1
        return new Promise<never>(() => undefined)
      }
    }
    const value = await harness({
      planner,
      budget: { ...DEFAULT_AUTO_BUDGET, maxWallTimeMs: 3_000 }
    })
    const startedAt = Date.now()
    const turn = await value.start('run-never-returning-planner', request('建立一个方形构图'))
    await value.loop.waitForIdle()
    const elapsed = Date.now() - startedAt
    const snapshot = await value.loop.snapshot()
    expect(calls).toBe(1)
    expect(elapsed).toBeLessThan(2_500)
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'budget_limited', errorCode: 'BUDGET_WALL_TIME'
    })
  })

  it('counts and persists at most two paid model-correction turns before one Scene write', async () => {
    let calls = 0
    const observedFailures: unknown[] = []
    const planner = {
      async plan(
        _request: AgentRequest,
        _signal: AbortSignal,
        failure?: unknown,
        context?: Parameters<AgentPlanner['plan']>[3]
      ): Promise<AgentPlan> {
        calls += 1
        observedFailures.push(failure ?? null)
        await context?.observe?.({
          type: 'provider.attempt.reserved',
          payload: {
            schemaVersion: 1,
            attemptId: `attempt-${calls}`,
            requestCorrelationId: context.requestCorrelationId,
            providerId: 'fixture-llm',
            providerLabel: 'Fixture LLM',
            protocol: 'openai-responses',
            model: 'fixture-model',
            transportMode: 'stream',
            attempt: calls,
            phase: 'reserved',
            occurredAt: new Date().toISOString(),
            elapsedMs: 0,
            lastTransportActivityAt: null,
            lastSemanticProgressAt: null,
            receivedBytes: 0,
            recognizedEventCount: 0,
            providerResponseId: null,
            httpStatus: null,
            failureCode: null
          }
        })
        if (calls <= 2) {
          throw new AgentPlannerError('MODEL_TOOL_UNSUPPORTED', '模型返回了未注册工具。')
        }
        return {
          summary: '纠正后建立构图',
          response: '构图已建立。',
          nextAction: null,
          tools: [sceneTool('纠正后建立构图')]
        }
      }
    }
    const value = await harness({ planner: new DeterministicCreativePlannerAdapter(planner) })
    const turn = await value.start('run-model-correction', request('建立一个 1:1 方形构图'))
    await value.loop.waitForIdle()

    const snapshot = await value.loop.snapshot()
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed',
      modelTurnsUsed: 3,
      recoveryAttemptsUsed: 2,
      toolCallsUsed: 1,
      sceneWriteBatchesUsed: 1
    })
    const recoveries = snapshot.items.filter((item) => item.turnId === turn.id && item.type === 'recovery')
    expect(recoveries).toHaveLength(2)
    expect(observedFailures[0]).toBeNull()
    expect(observedFailures[1]).toMatchObject({ code: 'MODEL_TOOL_UNSUPPORTED', attempt: 1, maxAttempts: 2 })
    expect(observedFailures[2]).toMatchObject({ code: 'MODEL_TOOL_UNSUPPORTED', attempt: 2, maxAttempts: 2 })
  })

  it('does not automatically resubmit a model request when the external POST state is unknown', async () => {
    let calls = 0
    const planner = {
      async plan(): Promise<AgentPlan> {
        calls += 1
        throw Object.assign(new Error('供应商连接在 POST 后中断，状态未知。'), { code: 'PROVIDER_NETWORK_ERROR' })
      }
    }
    const value = await harness({ planner: new DeterministicCreativePlannerAdapter(planner) })
    const turn = await value.start('run-unknown-post', request('建立一个 1:1 方形构图'))
    await value.loop.waitForIdle()

    const snapshot = await value.loop.snapshot()
    expect(calls).toBe(1)
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_NETWORK_ERROR',
      recoveryAttemptsUsed: 0,
      toolCallsUsed: 0
    })
    expect(snapshot.items.filter((item) => item.turnId === turn.id && item.type === 'recovery')).toMatchObject([
      { status: 'failed', payloadVersion: 2, payload: { failure: { schemaVersion: 2, externalState: 'unknown' } } }
    ])
  })

  it('keeps committed tools out of a refreshed replacement plan', async () => {
    let plannerCalls = 0
    const first = sceneTool('先建立背景')
    const stale = sceneTool('再调整主体')
    const repaired = sceneTool('按最新画布调整主体')
    const planner: AgentPlanner = {
      async plan(_request, _signal, failure) {
        plannerCalls += 1
        return {
          summary: failure === null || failure === undefined ? '两步计划' : '刷新后的剩余计划',
          response: '已完成。',
          nextAction: null,
          tools: failure === null || failure === undefined ? [first, stale] : [first, repaired]
        }
      }
    }
    const executed: string[] = []
    const value = await harness({
      planner: new DeterministicCreativePlannerAdapter(planner),
      executeTool: async (tool, toolIndex) => {
        const summary = tool.kind === 'scene_batch' ? tool.summary : tool.kind
        executed.push(summary)
        if (summary === '再调整主体') {
          throw Object.assign(new Error('画布版本已经变化。'), { code: 'SCENE_REVISION_STALE' })
        }
        return { toolIndex, ok: true, batchId: `${toolIndex}-${executed.length}`, jobId: null, affectedElementIds: [], message: '完成' }
      }
    })
    const turn = await value.start('run-preserve-committed-prefix', request('在 1:1 画布中建立背景后再调整主体'))
    await value.loop.waitForIdle()

    const snapshot = await value.loop.snapshot()
    expect(executed).toEqual(['先建立背景', '再调整主体', '按最新画布调整主体'])
    expect(plannerCalls).toBe(2)
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed', modelTurnsUsed: 2, recoveryAttemptsUsed: 1, toolCallsUsed: 3
    })
  })

  it('keeps one request correlation across the authored plan and its outbound tool context', async () => {
    let authoredCorrelation: string | null = null
    let toolCorrelation: string | null = null
    const planner: AgentPlanner = {
      async plan(_request, _signal, _failure, context) {
        authoredCorrelation = context?.requestCorrelationId ?? null
        return { summary: '建立画布', response: '完成。', nextAction: null, tools: [sceneTool('建立画布')] }
      }
    }
    const value = await harness({
      planner: new DeterministicCreativePlannerAdapter(planner),
      executeTool: async (_tool, toolIndex, _signal, context) => {
        toolCorrelation = context.requestCorrelationId
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: '完成' }
      }
    })
    const turn = await value.start('run-correlation-chain', request('建立一个 1:1 方形画布'))
    await value.loop.waitForIdle()
    const snapshot = await value.loop.snapshot()
    const authoredPlan = snapshot.items.find((item) => item.turnId === turn.id && item.type === 'plan'
      && typeof item.payload === 'object' && item.payload !== null && (item.payload as { plan?: unknown }).plan !== null)
    expect(authoredCorrelation).toMatch(/^[0-9a-f-]{36}$/i)
    expect(toolCorrelation).toBe(authoredCorrelation)
    expect((authoredPlan?.payload as { requestCorrelationId?: string }).requestCorrelationId).toBe(authoredCorrelation)
  })

  it('persists one observable tool step, result and completion assessment at a time', async () => {
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: sceneTool('建立构图'), toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '构图已建立', notes: [], nextAction: null } }
      ])
    })
    const events: string[] = []
    value.loop.subscribe((event) => events.push(event.type))
    const turn = await value.start('run-one', request('建立一个方形构图'))
    await value.loop.waitForIdle()

    const snapshot = await value.loop.snapshot()
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed', modelTurnsUsed: 0, toolCallsUsed: 1, sceneWriteBatchesUsed: 1
    })
    expect(snapshot.items.filter((item) => item.turnId === turn.id).map((item) => item.type)).toEqual([
      'user_message', 'plan', 'tool_call', 'tool_result', 'scene_change', 'plan', 'completion_assessment'
    ])
    expect(events).toEqual(expect.arrayContaining(['item.started', 'item.completed', 'turn.assessed']))
  })

  it('retries a transient local read at most twice without creating another model turn', async () => {
    let reads = 0
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: { kind: 'scene.get_summary' }, toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '读取完成', notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex) => {
        reads += 1
        if (reads <= 2) throw Object.assign(new Error('database is temporarily busy'), { code: 'SQLITE_BUSY' })
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: '读取完成' }
      }
    })
    const turn = await value.start('run-local-read-retry', request('读取当前画布摘要'))
    await value.loop.waitForIdle()

    const snapshot = await value.loop.snapshot()
    expect(reads).toBe(3)
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed', modelTurnsUsed: 0, recoveryAttemptsUsed: 2, toolCallsUsed: 1, sceneWriteBatchesUsed: 0
    })
    expect(snapshot.items.filter((candidate) => candidate.turnId === turn.id && candidate.type === 'recovery')).toHaveLength(2)
    expect((await value.loop.replay(0)).map((event) => event.type)).toEqual(expect.arrayContaining([
      'recovery.started', 'recovery.completed'
    ]))
  })

  it('proposes one pending design direction memory after completion without auto-confirming it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verified-design-memory-')); roots.push(root)
    const network = vi.fn(() => { throw new Error('OFFLINE_DESIGN_MEMORY_BOUNDARY') }); vi.stubGlobal('fetch', network)
    const runtime = await GenerationRuntime.create(root); closers.push(() => runtime.close())
    const designRequest = request('创建一张 4:5 咖啡新品海报，标题 MORNING RITUAL，不生成图片')
    await runtime.startAgentRun(designRequest, 'auto')
    await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns[0]?.status).toBe('completed')
    const snapshot = await runtime.getAgentHarnessSnapshot()
    const turn = snapshot.turns[0]!
    expect(runtime.getWorkspaceBootstrap().scene.elements.length).toBeGreaterThan(0)
    expect(snapshot.items.find((item) => item.type === 'completion_assessment')?.payload).toMatchObject({ facts: { operationStatus: 'completed', structureStatus: 'passed', userAcceptance: null } })
    const knowledge = await runtime.getProjectKnowledge()
    expect(knowledge.candidates).toEqual([
      expect.objectContaining({
        kind: 'direction', sourceType: 'planner', sourceId: turn.id, confidence: 0.72,
        status: 'pending', confirmedMemoryId: null
      })
    ])
    expect(knowledge.memories).toEqual([])
    expect((await runtime.replayAgentEvents(0)).map((event) => event.type)).toContain('memory.candidate.proposed')
    await runtime.close()
    expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals()
  })

  it('correct_current invalidates the unstarted remainder and replans after the active tool checkpoint', async () => {
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const executed: string[] = []
    const planner: PlannerAdapter = {
      next: async (input) => {
        const corrected = input.request.text.includes('银灰')
        const plan: AgentPlan = corrected
          ? { summary: '修正计划', response: '已修正', nextAction: null, tools: [sceneTool('银灰新方案')] }
          : { summary: '旧计划', response: '旧方案', nextAction: null, tools: [sceneTool('旧步骤一'), sceneTool('旧步骤二')] }
        const tool = plan.tools[input.nextToolIndex]
        return {
          step: tool === undefined
            ? { kind: 'complete', assessment: { status: 'completed', summary: plan.response, notes: [], nextAction: null } }
            : { kind: 'tool', call: tool, toolIndex: input.nextToolIndex, plan: input.activePlan === null ? plan : null },
          modelTurns: input.activePlan === null ? 1 : 0
        }
      }
    }
    const value = await harness({
      planner,
      executeTool: async (tool, toolIndex) => {
        if (tool.kind !== 'scene_batch') throw new Error('Expected scene tool.')
        executed.push(tool.summary)
        if (tool.summary === '旧步骤一') {
          notifyStarted()
          await firstStarted
        }
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: tool.summary }
      }
    })
    await value.start('run-correct', request('先用 1:1 蓝色旧方案'))
    await started
    await value.loop.input({ mode: 'correct_current', request: request('保持 1:1，不是蓝色，改成银灰') }, async () => {
      throw new Error('correct_current must not create a queued run')
    })
    releaseFirst()
    await value.loop.waitForIdle()

    expect(executed).toEqual(['旧步骤一', '银灰新方案'])
    expect((await value.loop.snapshot()).turns[0]).toMatchObject({ status: 'completed' })
  })

  it('advances queue_next after normal completion and pauses it after interruption', async () => {
    let release!: () => void
    let notify!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const active = new Promise<void>((resolve) => { notify = resolve })
    let executionCount = 0
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: sceneTool('执行'), toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '完成', notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex) => {
        executionCount += 1
        if (executionCount === 1) {
          notify()
          await gate
        }
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'done' }
      }
    })
    await value.start('run-current', request('当前任务'))
    await active
    await value.loop.input({ mode: 'queue_next', request: request('下一个任务') }, async (queuedRequest) => {
      value.requests.set('run-next', queuedRequest)
      return { runId: 'run-next', sourceMessageId: 'run-next-message' }
    })
    release()
    await value.loop.waitForIdle()
    expect(executionCount).toBe(2)
    expect((await value.loop.snapshot()).queue).toEqual([expect.objectContaining({ messageId: 'run-next', status: 'completed' })])

    let hold!: () => void
    let began!: () => void
    const holdGate = new Promise<void>((resolve) => { hold = resolve })
    const beganGate = new Promise<void>((resolve) => { began = resolve })
    const interrupted = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: sceneTool('等待中断'), toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '不应完成', notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex) => {
        began()
        await holdGate
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'late result' }
      }
    })
    await interrupted.start('run-interrupt', request('会被中断'))
    await beganGate
    await interrupted.loop.input({ mode: 'queue_next', request: request('中断后的排队任务') }, async (queuedRequest) => {
      interrupted.requests.set('run-paused', queuedRequest)
      return { runId: 'run-paused', sourceMessageId: 'run-paused-message' }
    })
    await interrupted.loop.input({ mode: 'interrupt_now', request: request('现在停止') }, async () => {
      throw new Error('interrupt_now must not create a queued run')
    })
    hold()
    await interrupted.loop.waitForIdle()
    expect((await interrupted.loop.snapshot()).queue).toEqual([expect.objectContaining({ messageId: 'run-paused', status: 'paused' })])
  })

  it('stops before a tool when the multidimensional budget is exhausted', async () => {
    let calls = 0
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: sceneTool('不应执行'), toolIndex: 0, plan: null }
      ]),
      budget: { ...DEFAULT_AUTO_BUDGET, maxToolCalls: 0 },
      executeTool: async (_tool, toolIndex) => {
        calls += 1
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'unexpected' }
      }
    })
    await value.start('run-budget', request('预算为零'))
    await value.loop.waitForIdle()
    expect(calls).toBe(0)
    expect((await value.loop.snapshot()).turns[0]).toMatchObject({
      status: 'budget_limited', errorCode: 'BUDGET_TOOL_CALLS'
    })
  })

  it('makes Review mode a real per-step write gate with the Review budget', async () => {
    let calls = 0
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: sceneTool('审阅后建立构图'), toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: '构图已建立', notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex) => {
        calls += 1
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'done' }
      }
    })
    const turn = await value.start('run-review', request('使用 1:1 建立构图'), 'review')
    await value.loop.waitForIdle()

    let snapshot = await value.loop.snapshot()
    expect(snapshot.activeGoal).toMatchObject({
      mode: 'review',
      budget: DEFAULT_REVIEW_BUDGET,
      permissionProfileId: 'owner-full-v1',
      scope: { providerIds: ['image-provider'] },
      prohibitions: expect.not.arrayContaining(['禁止真实 LLM API', '禁止真实图片 API'])
    })
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({ status: 'waiting_decision' })
    expect(calls).toBe(0)
    const decision = snapshot.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
    expect(decision?.payload).toMatchObject({
      toolIndex: 0,
      proposal: { kind: 'clarification', defaultOptionId: 'stop' }
    })

    await value.loop.resolveDecision(turn.id, decision?.id ?? '', 'apply_once')
    await value.loop.waitForIdle()
    snapshot = await value.loop.snapshot()
    expect(calls).toBe(1)
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({ status: 'completed' })
  })

  it('ends Review mode without writing when the user declines the proposed step', async () => {
    let calls = 0
    const value = await harness({
      planner: new ScriptedPlannerAdapter([{ kind: 'tool', call: sceneTool('不应写入'), toolIndex: 0, plan: null }]),
      executeTool: async (_tool, toolIndex) => {
        calls += 1
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'unexpected' }
      }
    })
    const turn = await value.start('run-review-stop', request('使用 1:1 建立构图'), 'review')
    await value.loop.waitForIdle()
    const waiting = await value.loop.snapshot()
    const decision = waiting.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
    await value.loop.resolveDecision(turn.id, decision?.id ?? '', 'stop')
    await value.loop.waitForIdle()

    expect(calls).toBe(0)
    expect((await value.loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'cancelled', errorCode: 'USER_DECLINED_REVIEW_ACTION'
    })
  })

  it('keeps Collaboration mode local by asking before a zero-budget generation tool', async () => {
    let calls = 0
    const tool = generationTool()
    const value = await harness({
      planner: new ScriptedPlannerAdapter([{ kind: 'tool', call: tool, toolIndex: 0, plan: {
        summary: '不应自动生成', response: '等待模式边界。', nextAction: null, tools: [tool]
      } }]),
      executeTool: async (_tool, toolIndex) => {
        calls += 1
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'unexpected' }
      }
    })
    const turn = await value.start('run-collaboration-generation', request('先讨论这个方案'), 'collaboration')
    await value.loop.waitForIdle()

    let snapshot = await value.loop.snapshot()
    expect(snapshot.activeGoal).toMatchObject({
      mode: 'collaboration',
      budget: DEFAULT_COLLABORATION_BUDGET,
      permissionProfileId: 'owner-full-v1',
      scope: { providerIds: ['image-provider'] }
    })
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'waiting_decision', toolCallsUsed: 0
    })
    expect(calls).toBe(0)
    const decision = snapshot.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
    expect(decision?.payload).toMatchObject({ proposal: { kind: 'generation_confirmation' } })

    await value.loop.resolveDecision(turn.id, decision?.id ?? '', 'keep_canvas')
    await value.loop.waitForIdle()
    snapshot = await value.loop.snapshot()
    expect(snapshot.turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed_with_notes', toolCallsUsed: 0
    })
    expect(calls).toBe(0)
  })

  it('treats an explicit Collaboration confirmation as a bounded one-plan Mock generation grant', async () => {
    let calls = 0
    let observedApprovalId: string | null | undefined
    const tool = generationTool()
    const plan: AgentPlan = {
      summary: '显式批准后生成', response: '本地 Mock 已完成。', nextAction: null, tools: [tool]
    }
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: tool, toolIndex: 0, plan },
        { kind: 'tool', call: tool, toolIndex: 0, plan: null },
        { kind: 'complete', assessment: { status: 'completed', summary: plan.response, notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex, _signal, context) => {
        calls += 1
        observedApprovalId = context.approvalId
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'local Mock only' }
      }
    })
    const turn = await value.start('run-collaboration-approved-generation', request('先讨论这个方案'), 'collaboration')
    await value.loop.waitForIdle()
    const waiting = await value.loop.snapshot()
    const decision = waiting.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')

    await value.loop.resolveDecision(turn.id, decision?.id ?? '', 'generate')
    await value.loop.waitForIdle()

    expect((await value.loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed', toolCallsUsed: 1
    })
    expect(calls).toBe(1)
    expect(observedApprovalId).toBe(decision?.id)
  })

  it('treats a direct generation instruction as a bounded Collaboration grant without broadening automatic budget', async () => {
    let calls = 0
    let observedApprovalId: string | null | undefined
    const tool = generationTool()
    const plan: AgentPlan = {
      summary: '直接执行一次本地生成', response: '本地 Mock 已完成。', nextAction: null, tools: [tool]
    }
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        { kind: 'tool', call: tool, toolIndex: 0, plan },
        { kind: 'complete', assessment: { status: 'completed', summary: plan.response, notes: [], nextAction: null } }
      ]),
      executeTool: async (_tool, toolIndex, _signal, context) => {
        calls += 1
        observedApprovalId = context.approvalId
        return { toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'local Mock only' }
      }
    })
    const turn = await value.start('run-collaboration-direct-generation', request('现在生成一张本地草图'), 'collaboration')
    await value.loop.waitForIdle()

    expect((await value.loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)).toMatchObject({
      status: 'completed', toolCallsUsed: 1
    })
    expect(calls).toBe(1)
    expect(observedApprovalId).toBeNull()
  })

  it('restores a waiting Decision after restart and continues from the next persisted step', async () => {
    const value = await harness({
      planner: new ScriptedPlannerAdapter([
        {
          kind: 'decision',
          proposal: {
            kind: 'clarification',
            title: '选择方向',
            consequence: '决定最终构图方向',
            options: [
              { id: 'quiet', label: '克制', consequence: '采用克制构图' },
              { id: 'bold', label: '大胆', consequence: '采用大胆构图' }
            ],
            defaultOptionId: 'quiet'
          }
        },
        { kind: 'complete', assessment: { status: 'completed', summary: '决定已应用', notes: [], nextAction: null } }
      ])
    })
    const turn = await value.start('run-decision', request('需要选择方向'))
    await value.loop.waitForIdle()
    const waiting = await value.loop.snapshot()
    const decision = waiting.items.find((item) => item.turnId === turn.id && item.type === 'decision')
    expect(decision).toMatchObject({ status: 'waiting' })
    await value.loop.close()

    const projectId = waiting.thread.projectId
    const databasePath = join(roots.at(-1)!, 'loop.aicanvas', 'project.db')
    const reopened = new PersistentAgentLoop({
      projectId,
      repository: new AgentHarnessRepository(databasePath, { idFactory: value.ids, now: () => '2026-08-22T12:02:00.000+08:00' }),
      planner: new ScriptedPlannerAdapter([
        {
          kind: 'decision',
          proposal: {
            kind: 'clarification', title: '选择方向', consequence: '决定最终构图方向',
            options: [
              { id: 'quiet', label: '克制', consequence: '采用克制构图' },
              { id: 'bold', label: '大胆', consequence: '采用大胆构图' }
            ],
            defaultOptionId: 'quiet'
          }
        },
        { kind: 'complete', assessment: { status: 'completed', summary: '决定已应用', notes: [], nextAction: null } }
      ]),
      now: () => '2026-08-22T12:02:00.000+08:00',
      loadRequest: async () => request('需要选择方向'),
      executeTool: async (_tool, context) => ({
        toolIndex: context.toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'unused'
      })
    })
    await reopened.initialize()
    closers.push(() => reopened.close())
    await reopened.resolveDecision(turn.id, decision!.id, 'bold')
    const started = Date.now()
    let resumedStatus = (await reopened.snapshot()).turns.find((candidate) => candidate.id === turn.id)?.status
    while (resumedStatus !== 'completed' && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      resumedStatus = (await reopened.snapshot()).turns.find((candidate) => candidate.id === turn.id)?.status
    }
    expect(resumedStatus).toBe('completed')
  })
})
