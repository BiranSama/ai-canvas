import { z } from 'zod'

export const designDimensionSchema = z.enum([
  'requirements_fidelity',
  'composition',
  'hierarchy',
  'whitespace',
  'text',
  'subject',
  'lighting',
  'style',
  'editability',
  'convergence'
])

export const designCheckResultSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['pass', 'warning', 'fail']),
  evidence: z.array(z.string().trim().min(1).max(500)).max(20)
})

export const designRubricEntrySchema = z.object({
  dimension: designDimensionSchema,
  score: z.number().int().min(0).max(4),
  rationale: z.string().trim().min(1).max(1_000),
  evidence: z.array(z.string().trim().min(1).max(500)).max(20)
})

export const designRubricSchema = z.object({
  version: z.literal(1),
  entries: z.array(designRubricEntrySchema).length(10),
  total: z.number().int().min(0).max(40)
}).superRefine((rubric, context) => {
  const dimensions = rubric.entries.map((entry) => entry.dimension)
  if (new Set(dimensions).size !== 10) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'Design rubric must contain every dimension exactly once.' })
  }
  const expectedTotal = rubric.entries.reduce((sum, entry) => sum + entry.score, 0)
  if (expectedTotal !== rubric.total) {
    context.addIssue({ code: 'custom', path: ['total'], message: 'Design rubric total must equal the sum of its entries.' })
  }
})

export const designCompletionAssessmentSchema = z.object({
  version: z.literal(1),
  requirements: z.array(designCheckResultSchema).max(100),
  structure: z.array(designCheckResultSchema).max(100),
  design: designRubricSchema,
  unresolvedDecisionIds: z.array(z.string().uuid()).max(100),
  budgetState: z.string().trim().min(1).max(500),
  recommendation: z.enum(['complete', 'refine_once', 'needs_user_review', 'stop']),
  localRefineCount: z.number().int().min(0).max(1),
  sceneRevision: z.number().int().nonnegative().optional(),
  unverifiedMust: z.array(z.object({ id: z.string().max(120), label: z.string().max(240), reason: z.string().max(1000) })).max(100).optional()
})

export const completionFactsSchema = z.object({
  version: z.literal(1),
  operationStatus: z.enum(['completed', 'not_requested', 'missing']),
  structureStatus: z.enum(['passed', 'failed', 'not_checked']),
  visualStatus: z.enum(['needs_user_review', 'not_checked']),
  unverifiedMust: z.array(z.object({ id: z.string().max(120), label: z.string().max(240), reason: z.string().max(1000) })).max(100),
  scope: z.object({ sceneRevision: z.number().int().nonnegative(), resultIds: z.array(z.string().uuid()).max(128) }).nullable(),
  scopeUnavailableReason: z.string().max(1000).nullable().optional(),
  userAcceptance: z.object({ acceptedAt: z.string().datetime({ offset: true }), sceneRevision: z.number().int().nonnegative(), resultIds: z.array(z.string().uuid()).max(128) }).nullable()
}).strict()
export const acceptDesignReviewInputSchema = z.object({ projectId: z.string().uuid(), messageId: z.string().uuid(), sceneRevision: z.number().int().nonnegative() }).strict()
export type CompletionFacts = z.infer<typeof completionFactsSchema>
export type AcceptDesignReviewInput = z.infer<typeof acceptDesignReviewInputSchema>

export type DesignDimension = z.infer<typeof designDimensionSchema>
export type DesignCheckResult = z.infer<typeof designCheckResultSchema>
export type DesignRubricEntry = z.infer<typeof designRubricEntrySchema>
export type DesignRubric = z.infer<typeof designRubricSchema>
export type DesignCompletionAssessment = z.infer<typeof designCompletionAssessmentSchema>
