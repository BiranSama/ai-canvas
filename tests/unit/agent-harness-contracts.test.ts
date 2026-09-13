import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_BUDGET,
  DEFAULT_REVIEW_BUDGET,
  agentGoalContractSchema,
  agentDecisionProposalSchema,
  agentRunBudgetSchema,
  isTerminalAgentTurnStatus,
  plannerStepSchema,
  turnInputModeSchema
} from '../../src/shared/agent-harness'

describe('AH1 harness contracts', () => {
  it('keeps real cost at zero in every default budget', () => {
    expect(DEFAULT_REVIEW_BUDGET).toMatchObject({ maxGenerationJobs: 0, maxGeneratedImages: 0, maxCostCny: 0 })
    expect(DEFAULT_AUTO_BUDGET).toMatchObject({ maxGenerationJobs: 2, maxGeneratedImages: 4, maxCostCny: 0 })
  })

  it('rejects negative or partial resource budgets', () => {
    expect(() => agentRunBudgetSchema.parse({ ...DEFAULT_REVIEW_BUDGET, maxCostCny: -1 })).toThrow()
    expect(() => agentRunBudgetSchema.parse({ maxModelTurns: 8 })).toThrow()
  })

  it('distinguishes active waits from terminal review states', () => {
    expect(isTerminalAgentTurnStatus('waiting_decision')).toBe(false)
    expect(isTerminalAgentTurnStatus('waiting_job')).toBe(false)
    expect(isTerminalAgentTurnStatus('needs_user_review')).toBe(true)
    expect(isTerminalAgentTurnStatus('budget_limited')).toBe(true)
    expect(isTerminalAgentTurnStatus('completed')).toBe(true)
  })

  it('keeps steer, append, queue and interrupt as explicit wire values', () => {
    expect(turnInputModeSchema.options).toEqual([
      'correct_current', 'append_current', 'queue_next', 'interrupt_now'
    ])
  })

  it('requires a visible completion definition and a fully bounded scope', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      threadId: '00000000-0000-4000-8000-000000000002',
      objective: '建立画布',
      completionDefinition: ['画布结构完整'],
      mode: 'collaboration',
      scope: { canvas: true, elementIds: [], assetIds: [], providerIds: [] },
      permissionProfileId: null,
      budget: DEFAULT_REVIEW_BUDGET,
      prohibitions: ['禁止真实 API'],
      status: 'active',
      version: 1,
      createdAt: '2026-08-22T12:00:00.000+08:00',
      updatedAt: '2026-08-22T12:00:00.000+08:00'
    }
    expect(agentGoalContractSchema.parse(base)).toMatchObject({ objective: '建立画布' })
    expect(() => agentGoalContractSchema.parse({ ...base, completionDefinition: [] })).toThrow()
  })

  it('accepts one observable planner step and rejects hidden decision defaults', () => {
    expect(plannerStepSchema.parse({
      kind: 'complete',
      assessment: { status: 'completed', summary: '完成', notes: [], nextAction: null }
    })).toMatchObject({ kind: 'complete' })
    expect(() => agentDecisionProposalSchema.parse({
      kind: 'clarification',
      title: '选择方向',
      consequence: '决定下一步',
      options: [
        { id: 'a', label: 'A', consequence: '采用 A' },
        { id: 'b', label: 'B', consequence: '采用 B' }
      ],
      defaultOptionId: 'missing'
    })).toThrow('Decision default option must exist.')
  })
})
