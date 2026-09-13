import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentHarnessSnapshot, AgentItem, AgentTurn } from '../../src/shared/agent-harness'
import type { AgentActivity } from '../../src/shared/agent'
import { projectAgentExecutionFlow } from '../../src/renderer/src/agent/agent-execution-flow'

const THREAD_ID = '71000000-0000-4000-8000-000000000001'
const TURN_ID = '71000000-0000-4000-8000-000000000002'

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: TURN_ID,
    threadId: THREAD_ID,
    goalId: null,
    inputMessageId: 'message-1',
    taskId: null,
    taskRelation: 'new_task',
    dispatchMode: 'apply_now',
    baseTaskId: null,
    temporaryState: null,
    status: 'planning',
    sceneRevisionAtStart: 0,
    contextManifestId: null,
    writeLeaseId: null,
    modelTurnsUsed: 1,
    toolCallsUsed: 0,
    sceneWriteBatchesUsed: 0,
    recoveryAttemptsUsed: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:03.000Z',
    completedAt: null,
    ...overrides
  }
}

function item(
  id: string,
  ordinal: number,
  type: AgentItem['type'],
  status: AgentItem['status'],
  payload: unknown,
  updatedAt = '2026-09-01T10:00:04.000Z'
): AgentItem {
  return {
    id,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    type,
    status,
    ordinal,
    payloadVersion: 1,
    payload,
    createdAt: '2026-09-01T10:00:04.000Z',
    updatedAt
  }
}

function snapshot(currentTurn: AgentTurn, items: readonly AgentItem[] = []): AgentHarnessSnapshot {
  return {
    thread: {
      id: THREAD_ID,
      projectId: '71000000-0000-4000-8000-000000000003',
      title: '测试作品',
      status: 'active',
      activeGoalId: null,
      activeTurnId: currentTurn.id,
      lastSequence: 0,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: currentTurn.updatedAt
    },
    activeGoal: null,
    turns: [currentTurn],
    items: [...items],
    queue: [],
    lastSequence: 0
  }
}

function event(sequence: number, phase: 'reserved' | 'connecting' | 'headers' | 'first_event' | 'receiving' | 'completed'): AgentEvent {
  const occurredAt = `2026-09-01T10:00:0${Math.min(sequence, 9)}.000Z`
  return {
    id: `71000000-0000-4000-8000-${String(500 + sequence).padStart(12, '0')}`,
    projectId: '71000000-0000-4000-8000-000000000003',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: null,
    sequence,
    type: `provider.attempt.${phase}`,
    payloadVersion: 1,
    payload: {
      schemaVersion: 1,
      attemptId: '71000000-0000-4000-8000-000000000700',
      requestCorrelationId: '71000000-0000-4000-8000-000000000701',
      providerId: 'openai-compatible-llm',
      providerLabel: 'Fixture LLM',
      protocol: 'openai-responses',
      model: 'fixture-model',
      transportMode: 'stream',
      attempt: 1,
      phase,
      occurredAt,
      elapsedMs: sequence * 1_000,
      lastTransportActivityAt: phase === 'first_event' || phase === 'receiving' || phase === 'completed' ? occurredAt : null,
      lastSemanticProgressAt: phase === 'first_event' || phase === 'receiving' || phase === 'completed' ? occurredAt : null,
      receivedBytes: phase === 'first_event' || phase === 'receiving' || phase === 'completed' ? 128 * sequence : 0,
      recognizedEventCount: phase === 'first_event' || phase === 'receiving' || phase === 'completed' ? sequence : 0,
      providerResponseId: phase === 'completed' ? 'resp-fixture' : null,
      httpStatus: phase === 'headers' || phase === 'first_event' || phase === 'receiving' || phase === 'completed' ? 200 : null,
      failureCode: null
    },
    createdAt: occurredAt
  }
}

function executionFlow(
  current: AgentHarnessSnapshot,
  now: number,
  options: { readonly expanded?: boolean; readonly activities?: readonly AgentActivity[]; readonly events?: readonly AgentEvent[] } = {}
): NonNullable<ReturnType<typeof projectAgentExecutionFlow>> {
  const flow = projectAgentExecutionFlow(current, TURN_ID, now, options)
  if (flow === null) throw new Error('Expected the fixture turn to project an execution flow.')
  return flow
}

describe('Agent execution flow projection', () => {
  it('projects honest fixed phases without inventing future tools', () => {
    const flow = executionFlow(snapshot(turn({ status: 'building_context' })), Date.parse('2026-09-01T10:00:08.000Z'))

    expect(flow.stages.map((stage) => [stage.label, stage.state])).toEqual([
      ['已接收要求', 'completed'],
      ['准备创作上下文', 'running'],
      ['请求创作方案', 'queued']
    ])
    expect(flow.stages.some((stage) => stage.kind === 'tool')).toBe(false)
    expect(flow.canCancel).toBe(true)
  })

  it.each([
    ['normal', '等待模型返回可验证方案', '2026-09-01T10:00:14.999Z'],
    ['slow', '响应比平时慢，仍在等待', '2026-09-01T10:00:15.000Z'],
    ['long', '等待时间较长', '2026-09-01T10:00:33.000Z']
  ] as const)('classifies planning silence as %s without creating a retry', (stallLevel, detail, now) => {
    const flow = executionFlow(snapshot(turn()), Date.parse(now))
    const planning = flow.stages.find((stage) => stage.kind === 'planning')

    expect(flow.stallLevel).toBe(stallLevel)
    expect(planning).toMatchObject({ state: 'running' })
    expect(planning?.detail).toContain(detail)
    expect(flow.canCancel).toBe(true)
    expect(flow.canRestoreRequest).toBe(false)
  })

  it('projects real Provider milestones and derives stalling from the latest recorded event', () => {
    const events = [
      event(1, 'reserved'),
      event(2, 'connecting'),
      event(3, 'headers'),
      event(4, 'first_event'),
      event(5, 'receiving')
    ]
    const flow = executionFlow(
      snapshot(turn({ updatedAt: '2026-09-01T10:00:00.000Z' })),
      Date.parse('2026-09-01T10:00:17.000Z'),
      { expanded: true, events }
    )

    expect(flow.stallLevel).toBe('slow')
    expect(flow.lastProgressAgeMs).toBe(12_000)
    expect(flow.providerSummary).toBe('Fixture LLM · openai-responses · fixture-model')
    expect(flow.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '检查模型与工具', state: 'completed' }),
      expect.objectContaining({ label: '连接文字模型', state: 'completed' }),
      expect.objectContaining({ label: '等待首个响应', state: 'completed' }),
      expect.objectContaining({ label: '接收创作方案', state: 'running' })
    ]))
    const visible = JSON.stringify(flow)
    expect(visible).not.toContain('Authorization')
    expect(visible).not.toContain('reasoning')
    expect(visible).not.toContain('submitAgentPlan')
  })

  it('settles validation and recovery markers instead of leaving stopped work running', () => {
    const correlation = '71000000-0000-4000-8000-000000000701'
    const lifecycle = (sequence: number, type: string, payload: unknown): AgentEvent => ({
      ...event(sequence, 'completed'), type, payload
    })
    const validation = {
      schemaVersion: 1, requestCorrelationId: correlation,
      occurredAt: '2026-09-01T10:00:05.000Z', elapsedMs: 500, toolCount: null, failureCode: null
    }
    const recovery = {
      schemaVersion: 1, requestCorrelationId: correlation,
      failureId: '71000000-0000-4000-8000-000000000702', fingerprint: 'a'.repeat(32),
      attempt: 1, maxAttempts: 2, occurredAt: '2026-09-01T10:00:07.000Z', failureCode: 'TOOL_ARGUMENT_INVALID'
    }
    const events = [
      event(1, 'completed'),
      lifecycle(2, 'plan.validation.started', validation),
      lifecycle(3, 'plan.validation.failed', { ...validation, failureCode: 'TOOL_ARGUMENT_INVALID' }),
      lifecycle(4, 'recovery.started', recovery),
      lifecycle(5, 'recovery.exhausted', { ...recovery, attempt: 2 })
    ]
    const current = snapshot(turn({ status: 'failed' }))
    const flow = executionFlow(current, Date.parse('2026-09-01T10:00:08.000Z'), { expanded: true, events })
    expect(flow.stages.some((stage) => stage.state === 'running')).toBe(false)
    expect(flow.stages.some((stage) => stage.label === '校验创作方案')).toBe(false)
    expect(flow.stages.some((stage) => stage.label === '修正可恢复问题')).toBe(false)
    expect(flow.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '创作方案校验未通过', state: 'failed' }),
      expect.objectContaining({ label: '修正次数已用尽', state: 'failed' })
    ]))
    const interrupted = executionFlow(current, Date.now(), { expanded: true, events: events.slice(0, 2) })
    expect(interrupted.stages.find((stage) => stage.label === '校验创作方案')?.state).toBe('cancelled')
  })

  it('shows a real atomic tool with a friendly name, result, scope and duration', () => {
    const planId = '71000000-0000-4000-8000-000000000010'
    const callId = '71000000-0000-4000-8000-000000000011'
    const items = [
      item(planId, 1, 'plan', 'completed', {
        step: { kind: 'tool', toolIndex: 0, call: { kind: 'scene.update_elements', updates: [], summary: '调整标题与主体层级' } }
      }),
      item(callId, 2, 'tool_call', 'completed', {
        planItemId: planId,
        toolIndex: 0,
        tool: { kind: 'scene.update_elements', updates: [], summary: '调整标题与主体层级' }
      }),
      item('71000000-0000-4000-8000-000000000012', 3, 'tool_result', 'completed', {
        planItemId: planId,
        toolCallItemId: callId,
        tool: { kind: 'scene.update_elements' },
        outcome: {
          toolIndex: 0,
          ok: true,
          batchId: 'batch-1',
          jobId: null,
          affectedElementIds: ['element-1', 'element-2'],
          message: '已调整 2 个元素。'
        }
      }, '2026-09-01T10:00:06.500Z'),
      item('71000000-0000-4000-8000-000000000013', 4, 'scene_change', 'completed', {
        batchId: 'batch-1',
        toolCallItemId: callId
      }, '2026-09-01T10:00:06.600Z')
    ]
    const flow = executionFlow(snapshot(turn({ status: 'running', toolCallsUsed: 1, sceneWriteBatchesUsed: 1 }), items), Date.parse('2026-09-01T10:00:07.000Z'), { expanded: true })
    const tool = flow.stages.find((stage) => stage.kind === 'tool')

    expect(tool).toMatchObject({
      label: '更新画布元素',
      categoryLabel: '画布',
      state: 'completed',
      detail: '修改已写入 2 个元素。',
      scopeLabel: '2 个元素',
      durationMs: 2_500
    })
    expect(flow.stages.some((stage) => stage.kind === 'scene' && stage.label === '同步作品')).toBe(true)
    const visibleText = JSON.stringify(flow)
    expect(visibleText).not.toContain('scene.update_elements')
    expect(visibleText).not.toContain('toolIndex')
    expect(visibleText).not.toContain('"updates"')
  })

  it('reports a queued local-edit job without claiming the target image was already changed', () => {
    const callId = '71000000-0000-4000-8000-000000000015'
    const items = [
      item(callId, 1, 'tool_call', 'completed', { toolIndex: 0, tool: { kind: 'canvas_edit', targetElementId: 'image-1' } }),
      item('71000000-0000-4000-8000-000000000016', 2, 'tool_result', 'completed', {
        toolCallItemId: callId, outcome: { toolIndex: 0, ok: true, batchId: null, jobId: 'job-1', affectedElementIds: ['image-1'] }
      })
    ]
    const flow = executionFlow(snapshot(turn({ status: 'waiting_job' }), items), Date.now(), { expanded: true })
    expect(flow.stages.find((stage) => stage.kind === 'tool')).toMatchObject({
      detail: '图片任务已创建并进入可追溯队列。', scopeLabel: '1 个元素', state: 'completed'
    })
    expect(JSON.stringify(flow)).not.toContain('修改已写入')
  })

  it('keeps decisions, recovery, generation waiting and completion assessments observable', () => {
    const items = [
      item('71000000-0000-4000-8000-000000000020', 1, 'decision', 'completed', {
        proposal: { title: '是否开始生成', consequence: '将提交 1 个图片任务。' }
      }),
      item('71000000-0000-4000-8000-000000000021', 2, 'recovery', 'completed', {
        failure: { category: 'model_output', code: 'TOOL_ARGUMENT_INVALID', attempt: 1, maxAttempts: 2 }
      }),
      item('71000000-0000-4000-8000-000000000022', 3, 'generation_subscription', 'waiting', {
        jobId: 'job-1', lastJobStatus: 'generating'
      })
    ]
    const waiting = executionFlow(snapshot(turn({ status: 'waiting_job', recoveryAttemptsUsed: 1 }), items), Date.parse('2026-09-01T10:00:09.000Z'), { expanded: true })

    expect(waiting.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'decision', state: 'completed', label: '已确认下一步' }),
      expect.objectContaining({ kind: 'recovery', state: 'completed', label: '修正工具调用' }),
      expect.objectContaining({ kind: 'generation', state: 'waiting', label: '等待图片任务' })
    ]))

    const completedItems = [...items, item('71000000-0000-4000-8000-000000000023', 4, 'completion_assessment', 'completed', {
      status: 'completed_with_notes', summary: '结构已更新，文字仍作为参考。', notes: [], nextAction: null
    })]
    const completed = executionFlow(snapshot(turn({
      status: 'completed_with_notes',
      completedAt: '2026-09-01T10:00:10.000Z',
      updatedAt: '2026-09-01T10:00:10.000Z'
    }), completedItems), Date.parse('2026-09-01T10:00:11.000Z'), { expanded: true })

    expect(completed.stages.at(-1)).toMatchObject({ kind: 'assessment', state: 'completed', label: '核对本轮结果' })
    expect(completed.summary).toBe('本轮可验证操作已经完成，详细变化保留在操作回执。')
    expect(completed.canCancel).toBe(false)
  })

  it('distinguishes a real timeout and keeps explicit recovery user-controlled', () => {
    const flow = executionFlow(snapshot(turn({
      status: 'failed',
      errorCode: 'PROVIDER_TIMEOUT',
      errorMessage: 'Request timed out after 60000ms',
      completedAt: '2026-09-01T10:01:03.000Z',
      updatedAt: '2026-09-01T10:01:03.000Z'
    })), Date.parse('2026-09-01T10:01:04.000Z'))

    expect(flow.stallLevel).toBe('terminal')
    expect(flow.headline).toBe('规划未完成')
    expect(flow.summary).toContain('画布没有修改')
    expect(flow.canCancel).toBe(false)
    expect(flow.canRestoreRequest).toBe(true)
    expect(JSON.stringify(flow)).not.toContain('Request timed out')
  })

  it('adds a persisted direction change without duplicating ordinary tool activities', () => {
    const direction: AgentActivity = {
      id: '71000000-0000-4000-8000-000000000060',
      projectId: '71000000-0000-4000-8000-000000000003',
      runId: '71000000-0000-4000-8000-000000000061',
      kind: 'receipt',
      eventType: 'direction.completed',
      label: '设计方向已切换',
      state: 'completed',
      progress: 1,
      objectLabel: '当前作品',
      actionLabel: '采用“暮蓝”',
      impactLabel: '结构化计划与画布已同步，可一次撤销',
      scopeLabel: '3 个 Agent 管理元素',
      affectedIds: [],
      operationBatchId: '71000000-0000-4000-8000-000000000062',
      jobId: null,
      budgetImpact: null,
      recoverable: false,
      undoneAt: null,
      startedAt: null,
      endedAt: '2026-09-01T10:00:08.000Z',
      createdAt: '2026-09-01T10:00:08.000Z',
      updatedAt: '2026-09-01T10:00:08.000Z',
      events: [],
      decision: null
    }
    const ordinaryTool = { ...direction, id: '71000000-0000-4000-8000-000000000063', kind: 'tool' as const, eventType: 'tool.completed', label: '精确调整画布' }
    const flow = executionFlow(
      snapshot(turn({ status: 'completed', completedAt: '2026-09-01T10:00:07.000Z' })),
      Date.parse('2026-09-01T10:00:09.000Z'),
      { expanded: true, activities: [ordinaryTool, direction] }
    )

    expect(flow.stages.filter((stage) => stage.label === '设计方向已切换')).toHaveLength(1)
    expect(flow.stages.some((stage) => stage.label === '精确调整画布')).toBe(false)
    expect(flow.stages.at(-1)).toMatchObject({
      kind: 'scene',
      state: 'completed',
      label: '设计方向已切换',
      categoryLabel: '作品',
      scopeLabel: '3 个 Agent 管理元素'
    })
  })

  it('bounds the default DOM projection and reveals at most 24 observed stages', () => {
    const items = Array.from({ length: 30 }, (_, index) => item(
      `71000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      index + 1,
      'tool_call',
      'completed',
      { toolIndex: index, tool: { kind: 'scene.get_summary' } },
      `2026-09-01T10:00:${String(index).padStart(2, '0')}.000Z`
    ))
    const current = snapshot(turn({ status: 'running', toolCallsUsed: 30 }), items)

    const compact = executionFlow(current, Date.parse('2026-09-01T10:01:00.000Z'))
    const expanded = executionFlow(current, Date.parse('2026-09-01T10:01:00.000Z'), { expanded: true })

    expect(compact.stages).toHaveLength(6)
    expect(compact.hiddenStageCount).toBeGreaterThan(0)
    expect(expanded.stages).toHaveLength(24)
    expect(expanded.hiddenStageCount).toBeGreaterThan(0)
  })
})
