import { z } from 'zod'
import { creativeDesignContractSchema } from '../domain'
import { agentRequestSchema, agentToolPlanSchema } from './agent'
import { completionFactsSchema, designCompletionAssessmentSchema } from './design-capability'

export const agentModeSchema = z.enum(['review', 'collaboration', 'auto'])

export const agentRunBudgetSchema = z.object({
  maxModelTurns: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  maxSceneWriteBatches: z.number().int().nonnegative(),
  maxRecoveryAttempts: z.number().int().nonnegative(),
  maxGenerationJobs: z.number().int().nonnegative(),
  maxGeneratedImages: z.number().int().nonnegative(),
  maxWallTimeMs: z.number().int().nonnegative(),
  maxCostCny: z.number().nonnegative()
})

export const agentGoalScopeSchema = z.object({
  canvas: z.boolean().default(true),
  elementIds: z.array(z.string().uuid()).max(10_000).default([]),
  assetIds: z.array(z.string().uuid()).max(1_000).default([]),
  providerIds: z.array(z.string().min(1).max(200)).max(20).default([])
})

export const agentGoalStatusSchema = z.enum(['active', 'complete', 'blocked', 'cancelled'])
export const agentThreadStatusSchema = z.enum(['active', 'archived'])

export const agentTurnStatusSchema = z.enum([
  'queued',
  'building_context',
  'planning',
  'running',
  'waiting_decision',
  'waiting_job',
  'interrupted',
  'completed',
  'completed_with_notes',
  'needs_user_review',
  'blocked',
  'budget_limited',
  'usage_limited',
  'failed',
  'cancelled'
])

export const agentItemTypeSchema = z.enum([
  'user_message',
  'assistant_message',
  'plan',
  'decision',
  'tool_call',
  'tool_result',
  'scene_change',
  'generation_subscription',
  'completion_assessment',
  'context_compaction',
  'recovery'
])

export const agentItemStatusSchema = z.enum([
  'queued',
  'started',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export const turnInputModeSchema = z.enum([
  'correct_current',
  'append_current',
  'queue_next',
  'interrupt_now'
])

export const taskRelationSchema = z.enum([
  'continue_current',
  'revise_current',
  'supplement_current',
  'new_task',
  'temporary_try'
])

export const dispatchModeSchema = z.enum([
  'apply_now',
  'queue_after_current',
  'interrupt_current'
])

export const temporaryTryStateSchema = z.enum(['pending', 'accepted', 'rejected'])

export const agentTaskDispatchSchema = z.object({
  taskRelation: taskRelationSchema.nullable(),
  dispatchMode: dispatchModeSchema
}).superRefine((value, context) => {
  if (value.dispatchMode === 'interrupt_current' && value.taskRelation !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskRelation'],
      message: 'An interrupt is a control action and must not create a task relation.'
    })
  }
  if (value.dispatchMode !== 'interrupt_current' && value.taskRelation === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskRelation'],
      message: 'Creative work must declare how it relates to the current task.'
    })
  }
})

export const agentQueueStatusSchema = z.enum(['queued', 'paused', 'claimed', 'completed', 'cancelled'])

export const agentDecisionProposalSchema = z.object({
  kind: z.enum(['aspect_ratio', 'generation_confirmation', 'budget_alternative', 'clarification']),
  title: z.string().trim().min(1).max(200),
  consequence: z.string().trim().min(1).max(500),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    consequence: z.string().trim().min(1).max(300)
  })).min(2).max(6),
  defaultOptionId: z.string().trim().min(1).max(80)
}).superRefine((proposal, context) => {
  if (!proposal.options.some((option) => option.id === proposal.defaultOptionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultOptionId'],
      message: 'Decision default option must exist.'
    })
  }
})

export const agentCompletionAssessmentSchema = z.object({
  status: z.enum(['completed', 'completed_with_notes', 'needs_user_review', 'blocked']),
  summary: z.string().trim().min(1).max(4_000),
  notes: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  nextAction: z.string().trim().max(500).nullable().default(null),
  design: designCompletionAssessmentSchema.optional(),
  facts: completionFactsSchema.optional()
})

const plannerPlanEnvelopeSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  response: z.string().trim().min(1).max(4_000),
  nextAction: z.string().max(500).nullable(),
  tools: z.array(agentToolPlanSchema).max(12),
  designContract: creativeDesignContractSchema.optional()
})

export const plannerStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    content: z.string().trim().min(1).max(4_000)
  }),
  z.object({
    kind: z.literal('decision'),
    proposal: agentDecisionProposalSchema
  }),
  z.object({
    kind: z.literal('tool'),
    call: agentToolPlanSchema,
    toolIndex: z.number().int().nonnegative().max(11),
    plan: plannerPlanEnvelopeSchema.nullable().default(null)
  }),
  z.object({
    kind: z.literal('complete'),
    assessment: agentCompletionAssessmentSchema
  })
])

export const agentTurnInputSchema = z.object({
  mode: turnInputModeSchema,
  request: agentRequestSchema
})

export const agentTaskInputSchema = z.object({
  taskRelation: taskRelationSchema.nullable(),
  dispatchMode: dispatchModeSchema,
  request: agentRequestSchema
}).superRefine((value, context) => {
  if (value.dispatchMode === 'interrupt_current' && value.taskRelation !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskRelation'],
      message: 'An interrupt is a control action and must not create a task relation.'
    })
  }
  if (value.dispatchMode !== 'interrupt_current' && value.taskRelation === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskRelation'],
      message: 'Creative work must declare how it relates to the current task.'
    })
  }
})

export const agentStartInputSchema = z.object({
  request: agentRequestSchema,
  mode: agentModeSchema.default('collaboration'),
  taskRelation: taskRelationSchema.optional()
})

export const temporaryTryResolutionSchema = z.object({
  turnId: z.string().uuid(),
  resolution: z.enum(['accept', 'reject'])
})

export const agentDecisionResolutionSchema = z.object({
  turnId: z.string().uuid(),
  itemId: z.string().uuid(),
  optionId: z.string().trim().min(1).max(80)
})

export const agentEventReplayInputSchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(10_000).default(1_000)
})

export const agentThreadSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  status: agentThreadStatusSchema,
  activeGoalId: z.string().uuid().nullable(),
  activeTurnId: z.string().uuid().nullable(),
  lastSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const agentGoalContractSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  objective: z.string().trim().min(1).max(8_000),
  completionDefinition: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  mode: agentModeSchema,
  scope: agentGoalScopeSchema,
  permissionProfileId: z.string().trim().min(1).max(160).nullable(),
  budget: agentRunBudgetSchema,
  prohibitions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  status: agentGoalStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const agentTurnSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  goalId: z.string().uuid().nullable(),
  inputMessageId: z.string().min(1).nullable(),
  taskId: z.string().uuid().nullable().default(null),
  taskRelation: taskRelationSchema.nullable().default(null),
  dispatchMode: dispatchModeSchema.nullable().default(null),
  baseTaskId: z.string().uuid().nullable().default(null),
  temporaryState: temporaryTryStateSchema.nullable().default(null),
  status: agentTurnStatusSchema,
  // Main readback from the goal captured when this Turn was created. Null is
  // legacy/unverifiable; it never means a fresh default allowance.
  timeLimitMs: z.number().int().nonnegative().nullable().optional(),
  sceneRevisionAtStart: z.number().int().nonnegative(),
  contextManifestId: z.string().uuid().nullable(),
  writeLeaseId: z.string().uuid().nullable(),
  modelTurnsUsed: z.number().int().nonnegative(),
  toolCallsUsed: z.number().int().nonnegative(),
  sceneWriteBatchesUsed: z.number().int().nonnegative(),
  recoveryAttemptsUsed: z.number().int().nonnegative(),
  errorCode: z.string().max(120).nullable(),
  errorMessage: z.string().max(1_000).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable()
})

export const agentItemSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  type: agentItemTypeSchema,
  status: agentItemStatusSchema,
  ordinal: z.number().int().nonnegative(),
  payloadVersion: z.number().int().positive(),
  payload: z.unknown(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const agentEventSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  itemId: z.string().uuid().nullable(),
  sequence: z.number().int().positive(),
  type: z.string().trim().min(1).max(120),
  payloadVersion: z.number().int().positive(),
  payload: z.unknown(),
  createdAt: z.string().datetime({ offset: true })
})

export const agentQueueEntrySchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  messageId: z.string().min(1),
  mode: turnInputModeSchema,
  taskId: z.string().uuid().nullable().default(null),
  taskRelation: taskRelationSchema.nullable().default(null),
  dispatchMode: dispatchModeSchema.nullable().default(null),
  baseTaskId: z.string().uuid().nullable().default(null),
  position: z.number().int().nonnegative(),
  status: agentQueueStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const agentHarnessSnapshotSchema = z.object({
  thread: agentThreadSchema,
  activeGoal: agentGoalContractSchema.nullable(),
  turns: z.array(agentTurnSchema),
  items: z.array(agentItemSchema),
  queue: z.array(agentQueueEntrySchema),
  lastSequence: z.number().int().nonnegative()
})

export const DEFAULT_REVIEW_BUDGET = agentRunBudgetSchema.parse({
  maxModelTurns: 8,
  maxToolCalls: 12,
  maxSceneWriteBatches: 4,
  maxRecoveryAttempts: 3,
  maxGenerationJobs: 0,
  maxGeneratedImages: 0,
  maxWallTimeMs: 5 * 60_000,
  maxCostCny: 0
})

export const DEFAULT_COLLABORATION_BUDGET = agentRunBudgetSchema.parse({
  maxModelTurns: 8,
  maxToolCalls: 12,
  maxSceneWriteBatches: 4,
  maxRecoveryAttempts: 3,
  maxGenerationJobs: 0,
  maxGeneratedImages: 0,
  maxWallTimeMs: 5 * 60_000,
  maxCostCny: 0
})

export const DEFAULT_AUTO_BUDGET = agentRunBudgetSchema.parse({
  maxModelTurns: 12,
  maxToolCalls: 20,
  maxSceneWriteBatches: 6,
  maxRecoveryAttempts: 3,
  maxGenerationJobs: 2,
  maxGeneratedImages: 4,
  maxWallTimeMs: 10 * 60_000,
  maxCostCny: 0
})

const TERMINAL_TURN_STATUSES = new Set<AgentTurnStatus>([
  'interrupted', 'completed', 'completed_with_notes', 'needs_user_review', 'blocked',
  'budget_limited', 'usage_limited', 'failed', 'cancelled'
])

export function isTerminalAgentTurnStatus(status: AgentTurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status)
}

export type AgentMode = z.infer<typeof agentModeSchema>
export type AgentRunBudget = z.infer<typeof agentRunBudgetSchema>
export type AgentGoalScope = z.infer<typeof agentGoalScopeSchema>
export type AgentGoalStatus = z.infer<typeof agentGoalStatusSchema>
export type AgentThreadStatus = z.infer<typeof agentThreadStatusSchema>
export type AgentTurnStatus = z.infer<typeof agentTurnStatusSchema>
export type AgentItemType = z.infer<typeof agentItemTypeSchema>
export type AgentItemStatus = z.infer<typeof agentItemStatusSchema>
export type TurnInputMode = z.infer<typeof turnInputModeSchema>
export type TaskRelation = z.infer<typeof taskRelationSchema>
export type DispatchMode = z.infer<typeof dispatchModeSchema>
export type TemporaryTryState = z.infer<typeof temporaryTryStateSchema>
export type AgentTaskDispatch = z.infer<typeof agentTaskDispatchSchema>
export type AgentQueueStatus = z.infer<typeof agentQueueStatusSchema>
export type AgentDecisionProposal = z.infer<typeof agentDecisionProposalSchema>
export type AgentCompletionAssessment = z.infer<typeof agentCompletionAssessmentSchema>
export type PlannerStep = z.infer<typeof plannerStepSchema>
export type AgentTurnInput = z.infer<typeof agentTurnInputSchema>
export type AgentTaskInput = z.infer<typeof agentTaskInputSchema>
export type AgentStartInput = z.infer<typeof agentStartInputSchema>
export type TemporaryTryResolution = z.infer<typeof temporaryTryResolutionSchema>
export type AgentDecisionResolution = z.infer<typeof agentDecisionResolutionSchema>
export type AgentEventReplayInput = z.infer<typeof agentEventReplayInputSchema>
export type AgentThread = z.infer<typeof agentThreadSchema>
export type AgentGoalContract = z.infer<typeof agentGoalContractSchema>
export type AgentTurn = z.infer<typeof agentTurnSchema>
export type AgentItem = z.infer<typeof agentItemSchema>
export type AgentEvent = z.infer<typeof agentEventSchema>
export type AgentQueueEntry = z.infer<typeof agentQueueEntrySchema>
export type AgentHarnessSnapshot = z.infer<typeof agentHarnessSnapshotSchema>

export function adaptLegacyTurnInputMode(mode: TurnInputMode): AgentTaskDispatch {
  switch (mode) {
    case 'correct_current':
      return { taskRelation: 'revise_current', dispatchMode: 'apply_now' }
    case 'append_current':
      return { taskRelation: 'supplement_current', dispatchMode: 'apply_now' }
    case 'queue_next':
      return { taskRelation: 'continue_current', dispatchMode: 'queue_after_current' }
    case 'interrupt_now':
      return { taskRelation: null, dispatchMode: 'interrupt_current' }
  }
}

export function normalizeAgentTaskInput(input: AgentTurnInput | AgentTaskInput): AgentTaskInput {
  if ('mode' in input) {
    return agentTaskInputSchema.parse({
      ...adaptLegacyTurnInputMode(input.mode),
      request: input.request
    })
  }
  return agentTaskInputSchema.parse(input)
}
