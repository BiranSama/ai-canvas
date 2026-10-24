import { z } from 'zod'

export const agentEvalLayerSchema = z.enum([
  'protocol', 'tool', 'run', 'context', 'design', 'generation', 'recovery', 'product'
])

export const agentEvalRiskSchema = z.enum([
  'requirement_error', 'quality_failure', 'unauthorized_write', 'network_or_cost',
  'recovery_loss', 'memory_injection', 'dishonest_completion', 'ui_misleading'
])

export const agentEvalEvidenceSchema = z.object({
  file: z.string().trim().min(1).max(300).refine((value) => !value.includes('..') && !/^[a-z]:[\\/]/i.test(value), {
    message: 'Eval evidence paths must stay repository-relative.'
  }),
  testName: z.string().trim().min(1).max(500)
})

export const agentEvalScenarioSchema = z.object({
  id: z.string().regex(/^AH-EVAL-\d{3}$/),
  title: z.string().trim().min(1).max(160),
  requirementIds: z.array(z.string().trim().min(1).max(40)).min(1),
  layer: agentEvalLayerSchema,
  risks: z.array(agentEvalRiskSchema).min(1),
  safetyCritical: z.boolean(),
  maxSteps: z.number().int().positive().max(100),
  evidence: z.array(agentEvalEvidenceSchema).min(1)
})

export const agentEvalObservationSchema = z.object({
  scenarioId: z.string().regex(/^AH-EVAL-\d{3}$/),
  evidencePassed: z.boolean(),
  taskSuccess: z.number().min(0).max(1),
  safetyPass: z.boolean(),
  toolCorrectness: z.number().min(0).max(1),
  efficiency: z.number().min(0).max(1),
  honestCompletion: z.number().min(0).max(1),
  observedSteps: z.number().int().nonnegative(),
  externalRequests: z.number().int().nonnegative(),
  actualCostCny: z.number().nonnegative(),
  unauthorizedWrites: z.number().int().nonnegative(),
  notes: z.array(z.string().trim().min(1).max(500)).default([])
})

export const agentEvalFailureCodeSchema = z.enum([
  'EVIDENCE_FAILED',
  'TASK_FAILED',
  'SAFETY_FAILED',
  'TOOL_INCORRECT',
  'STEP_BUDGET_EXCEEDED',
  'DISHONEST_COMPLETION',
  'EXTERNAL_REQUEST',
  'NONZERO_COST',
  'UNAUTHORIZED_WRITE'
])

export const agentEvalScenarioResultSchema = z.object({
  scenarioId: z.string().regex(/^AH-EVAL-\d{3}$/),
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  safetyPassed: z.boolean(),
  failureCodes: z.array(agentEvalFailureCodeSchema),
  observedSteps: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  externalRequests: z.number().int().nonnegative(),
  actualCostCny: z.number().nonnegative(),
  unauthorizedWrites: z.number().int().nonnegative()
})

export const agentEvalReportSchema = z.object({
  profile: z.literal('ah1-local-mock'),
  scenarioCount: z.number().int().nonnegative(),
  passedScenarios: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(100),
  overallScore: z.number().min(0).max(100),
  safetyRate: z.number().min(0).max(100),
  externalRequests: z.number().int().nonnegative(),
  actualCostCny: z.number().nonnegative(),
  unauthorizedWrites: z.number().int().nonnegative(),
  acceptanceCandidate: z.boolean(),
  results: z.array(agentEvalScenarioResultSchema)
})

// A real-model run makes paid text-model requests by design, so it cannot use
// the zero-spend local profile above. It keeps the same summary vocabulary and
// adds the run-level evidence a pass/fail baseline between engines needs.
export const agentModelEvalProfileSchema = z.enum(['agent-real-model', 'agent-replay'])

export const agentModelEvalCategorySchema = z.enum([
  'new_layout', 'local_edit', 'multi_turn', 'directive_memory', 'look_advise', 'generate_place', 'safety'
])

export const agentModelEvalSafetyKindSchema = z.enum([
  'unauthorized_paid_request', 'unmentioned_change', 'non_undoable_write', 'blocked_network_request'
])

export const agentModelEvalSafetyCountsSchema = z.object({
  unauthorizedPaidRequests: z.number().int().nonnegative(),
  unmentionedChanges: z.number().int().nonnegative(),
  nonUndoableWrites: z.number().int().nonnegative(),
  blockedNetworkRequests: z.number().int().nonnegative()
})

export const agentModelEvalFailureCodeSchema = z.enum([
  'ASSERTION_FAILED',
  'SAFETY_FLOOR',
  'TURN_FAILED',
  'SETUP_FAILED',
  'NO_MODEL_CALL',
  'TOOL_STEP_LIMIT',
  'MODEL_CALL_LIMIT',
  'SPEND_LIMIT',
  'REPLY_HYGIENE',
  'REPLAY_MISMATCH',
  'STALE_RECORDING',
  'RUN_ERROR'
])

export const agentModelEvalCheckSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(80),
  passed: z.boolean(),
  detail: z.string().max(2_000),
  safety: agentModelEvalSafetyKindSchema.nullable()
})

export const agentModelEvalLayoutScoreSchema = z.object({
  total: z.number().int().min(0).max(40),
  max: z.literal(40),
  dimensions: z.record(z.string(), z.number().int().min(0).max(4))
})

export const agentModelEvalRunResultSchema = z.object({
  run: z.number().int().positive(),
  passed: z.boolean(),
  failureCodes: z.array(agentModelEvalFailureCodeSchema),
  checks: z.array(agentModelEvalCheckSchema),
  safety: agentModelEvalSafetyCountsSchema,
  turnStatus: z.string().max(80),
  toolSteps: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  caseModelCalls: z.number().int().nonnegative(),
  paidGenerationRequests: z.number().int().nonnegative(),
  generationJobs: z.number().int().nonnegative(),
  spendCny: z.number().nonnegative(),
  spendBasis: z.enum(['token_usage', 'reserved_ceiling']),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  layoutScore: agentModelEvalLayoutScoreSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
  promptFingerprint: z.string().max(200).nullable(),
  recording: z.string().max(500).nullable(),
  problems: z.array(z.string().max(2_000)).max(50)
})

export const agentModelEvalCaseResultSchema = z.object({
  caseId: z.string().regex(/^[a-z]+(?:-[a-z]+)*-\d{2}$/),
  category: agentModelEvalCategorySchema,
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(1).max(2_000),
  runCount: z.number().int().nonnegative(),
  passedRuns: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(100),
  safetyFloorViolations: z.number().int().nonnegative(),
  meanToolSteps: z.number().nonnegative(),
  meanModelCalls: z.number().nonnegative(),
  meanSpendCny: z.number().nonnegative(),
  meanLayoutScore: z.number().min(0).max(40).nullable(),
  runs: z.array(agentModelEvalRunResultSchema)
})

export const agentModelEvalReportSchema = z.object({
  profile: agentModelEvalProfileSchema,
  formatVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  configuration: z.object({
    engine: z.object({
      id: z.string().trim().min(1).max(80),
      version: z.number().int().positive(),
      label: z.string().trim().min(1).max(160)
    }),
    promptFingerprints: z.array(z.string().max(200)).max(100),
    llm: z.object({
      protocol: z.string().trim().min(1).max(80),
      model: z.string().trim().min(1).max(300),
      endpointHost: z.string().trim().min(1).max(300),
      transport: z.enum(['auto', 'stream', 'buffered']),
      reasoningEffort: z.string().trim().min(1).max(40)
    }),
    imageProvider: z.literal('local-mock'),
    runsPerCase: z.number().int().positive().max(20),
    caseFilter: z.array(z.string().max(80)).max(100),
    pricing: z.object({
      inputCnyPerMillionTokens: z.number().nonnegative().nullable(),
      outputCnyPerMillionTokens: z.number().nonnegative().nullable()
    })
  }),
  scenarioCount: z.number().int().nonnegative(),
  passedScenarios: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(100),
  safetyRate: z.number().min(0).max(100),
  externalRequests: z.number().int().nonnegative(),
  actualCostCny: z.number().nonnegative(),
  unauthorizedWrites: z.number().int().nonnegative(),
  acceptanceCandidate: z.boolean(),
  runCount: z.number().int().nonnegative(),
  passedRuns: z.number().int().nonnegative(),
  safetyFloor: agentModelEvalSafetyCountsSchema.extend({ total: z.number().int().nonnegative() }),
  toolSteps: z.number().int().nonnegative(),
  meanLayoutScore: z.number().min(0).max(40).nullable(),
  categories: z.array(z.object({
    category: agentModelEvalCategorySchema,
    label: z.string().trim().min(1).max(40),
    caseCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    passedRuns: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(100)
  })),
  cases: z.array(agentModelEvalCaseResultSchema)
})

export const anyAgentEvalReportSchema = z.discriminatedUnion('profile', [agentEvalReportSchema, agentModelEvalReportSchema])

export type AgentEvalLayer = z.infer<typeof agentEvalLayerSchema>
export type AgentEvalRisk = z.infer<typeof agentEvalRiskSchema>
export type AgentEvalScenario = z.infer<typeof agentEvalScenarioSchema>
export type AgentEvalObservation = z.infer<typeof agentEvalObservationSchema>
export type AgentEvalFailureCode = z.infer<typeof agentEvalFailureCodeSchema>
export type AgentEvalScenarioResult = z.infer<typeof agentEvalScenarioResultSchema>
export type AgentEvalReport = z.infer<typeof agentEvalReportSchema>
export type AgentModelEvalProfile = z.infer<typeof agentModelEvalProfileSchema>
export type AgentModelEvalCategory = z.infer<typeof agentModelEvalCategorySchema>
export type AgentModelEvalSafetyKind = z.infer<typeof agentModelEvalSafetyKindSchema>
export type AgentModelEvalSafetyCounts = z.infer<typeof agentModelEvalSafetyCountsSchema>
export type AgentModelEvalFailureCode = z.infer<typeof agentModelEvalFailureCodeSchema>
export type AgentModelEvalCheck = z.infer<typeof agentModelEvalCheckSchema>
export type AgentModelEvalLayoutScore = z.infer<typeof agentModelEvalLayoutScoreSchema>
export type AgentModelEvalRunResult = z.infer<typeof agentModelEvalRunResultSchema>
export type AgentModelEvalCaseResult = z.infer<typeof agentModelEvalCaseResultSchema>
export type AgentModelEvalReport = z.infer<typeof agentModelEvalReportSchema>
export type AnyAgentEvalReport = z.infer<typeof anyAgentEvalReportSchema>
