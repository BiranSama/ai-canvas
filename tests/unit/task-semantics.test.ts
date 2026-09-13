import { describe, expect, it } from 'vitest'
import {
  adaptLegacyTurnInputMode,
  agentTaskDispatchSchema,
  agentTaskInputSchema,
  agentTurnSchema,
  agentQueueEntrySchema
} from '../../src/shared/agent-harness'

const request = {
  text: '继续完善当前构图',
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

describe('Product 1.0 task semantics', () => {
  it('maps every legacy input mode to the approved relation and dispatch pair', () => {
    expect(adaptLegacyTurnInputMode('correct_current')).toEqual({ taskRelation: 'revise_current', dispatchMode: 'apply_now' })
    expect(adaptLegacyTurnInputMode('append_current')).toEqual({ taskRelation: 'supplement_current', dispatchMode: 'apply_now' })
    expect(adaptLegacyTurnInputMode('queue_next')).toEqual({ taskRelation: 'continue_current', dispatchMode: 'queue_after_current' })
    expect(adaptLegacyTurnInputMode('interrupt_now')).toEqual({ taskRelation: null, dispatchMode: 'interrupt_current' })
  })

  it('requires a relation for creative work and forbids one for a pure interrupt', () => {
    expect(agentTaskDispatchSchema.parse({ taskRelation: 'new_task', dispatchMode: 'queue_after_current' })).toEqual({
      taskRelation: 'new_task', dispatchMode: 'queue_after_current'
    })
    expect(() => agentTaskDispatchSchema.parse({ taskRelation: null, dispatchMode: 'apply_now' })).toThrow()
    expect(() => agentTaskDispatchSchema.parse({ taskRelation: 'continue_current', dispatchMode: 'interrupt_current' })).toThrow()
    expect(agentTaskInputSchema.parse({
      taskRelation: 'temporary_try', dispatchMode: 'apply_now', request
    }).taskRelation).toBe('temporary_try')
  })

  it('projects task identity and temporary state through Turn and Queue contracts', () => {
    const taskId = '00000000-0000-4000-8000-000000000111'
    const base = {
      id: '00000000-0000-4000-8000-000000000112',
      threadId: '00000000-0000-4000-8000-000000000113',
      taskId,
      taskRelation: 'temporary_try',
      dispatchMode: 'apply_now',
      baseTaskId: '00000000-0000-4000-8000-000000000114',
      temporaryState: 'pending',
      createdAt: '2026-08-30T12:00:00.000+08:00',
      updatedAt: '2026-08-30T12:00:00.000+08:00'
    } as const
    expect(agentTurnSchema.parse({
      ...base,
      goalId: null,
      inputMessageId: 'run-1',
      status: 'completed',
      sceneRevisionAtStart: 0,
      contextManifestId: null,
      writeLeaseId: null,
      modelTurnsUsed: 0,
      toolCallsUsed: 0,
      sceneWriteBatchesUsed: 0,
      recoveryAttemptsUsed: 0,
      errorCode: null,
      errorMessage: null,
      completedAt: '2026-08-30T12:00:00.000+08:00'
    })).toMatchObject({ taskId, taskRelation: 'temporary_try', temporaryState: 'pending' })
    expect(agentQueueEntrySchema.parse({
      ...base,
      messageId: 'run-queued',
      mode: 'queue_next',
      position: 0,
      status: 'queued'
    })).toMatchObject({ taskId, taskRelation: 'temporary_try', dispatchMode: 'apply_now' })
  })
})
