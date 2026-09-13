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

export type AgentEvalLayer = z.infer<typeof agentEvalLayerSchema>
export type AgentEvalRisk = z.infer<typeof agentEvalRiskSchema>
export type AgentEvalScenario = z.infer<typeof agentEvalScenarioSchema>
export type AgentEvalObservation = z.infer<typeof agentEvalObservationSchema>
export type AgentEvalFailureCode = z.infer<typeof agentEvalFailureCodeSchema>
export type AgentEvalScenarioResult = z.infer<typeof agentEvalScenarioResultSchema>
export type AgentEvalReport = z.infer<typeof agentEvalReportSchema>
