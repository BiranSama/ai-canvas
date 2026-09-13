import { z } from 'zod'
import { generationCostSchema } from './generation-cost'
import {
  generationJobStatusSchema,
  generationProfileTierSchema,
  imageTaskRequestSchema
} from './generation'

const idSchema = z.string().uuid()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const generationWorkflowOperationSchema = z.enum([
  'text',
  'canvas',
  'edit',
  'similar',
  'text-effect'
])

export const generationWorkflowStepKindSchema = z.enum([
  'compile-prompt',
  'reserve-budget',
  'create-job',
  'observe-job',
  'localize-results',
  'record-lineage'
])

export const generationWorkflowStepSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: generationWorkflowStepKindSchema,
  label: z.string().trim().min(1).max(240),
  required: z.boolean()
})

export const generationWorkflowSpecSchema = z.object({
  version: z.literal(1),
  executionIdentityId: idSchema.nullable().optional(),
  effectiveTimeoutMs: z.number().int().positive().optional(),
  id: idSchema,
  profileId: z.string().trim().min(1).max(120),
  tier: generationProfileTierSchema,
  operation: generationWorkflowOperationSchema,
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  sourceSceneRevision: z.number().int().nonnegative().nullable(),
  promptPackageHash: hashSchema.nullable(),
  idempotencyKey: z.string().trim().min(1).max(500),
  steps: z.array(generationWorkflowStepSchema).min(4).max(12),
  limits: z.object({
    maxJobs: z.number().int().min(1).max(32),
    maxImages: z.number().int().min(1).max(128),
    maxCostCny: z.number().min(0).max(1_000_000),
    maxWallTimeMs: z.number().int().min(1).max(86_400_000),
    noImprovementLimit: z.number().int().min(0).max(32)
  })
})

export const providerCapabilityWarningSchema = z.object({
  code: z.string().trim().min(1).max(120),
  severity: z.enum(['info', 'warning']),
  message: z.string().trim().min(1).max(1_000),
  adaptation: z.string().trim().min(1).max(1_000)
})

export const providerCompiledRequestSchema = z.object({
  version: z.literal(1),
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  operation: generationWorkflowOperationSchema,
  request: imageTaskRequestSchema,
  warnings: z.array(providerCapabilityWarningSchema).max(30),
  capabilityFingerprint: hashSchema,
  compilation: z.enum(['exact', 'adapted'])
})

export const generationWorkflowIntentStatusSchema = z.enum([
  'prepared',
  'dispatching',
  'dispatched',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'external_unknown'
])

export const generationWorkflowIntentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  threadId: idSchema.nullable(),
  turnId: idSchema.nullable(),
  toolCallItemId: idSchema.nullable(),
  sourceMessageId: z.string().trim().min(1).max(500).nullable(),
  spec: generationWorkflowSpecSchema,
  compiledRequest: providerCompiledRequestSchema,
  promptPackage: z.unknown().nullable(),
  sourceHash: hashSchema,
  status: generationWorkflowIntentStatusSchema,
  jobId: z.string().trim().min(1).max(500).nullable(),
  dispatchAttempts: z.number().int().min(0).max(1),
  errorCode: z.string().trim().min(1).max(120).nullable(),
  errorMessage: z.string().trim().min(1).max(1_000).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  dispatchedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable()
})

export const generationBudgetReservationStatusSchema = z.enum(['reserved', 'committed', 'released'])

export const generationBudgetReservationSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  turnId: idSchema.nullable(),
  intentId: idSchema,
  requestLimit: z.number().int().min(1).max(32),
  imageLimit: z.number().int().min(1).max(128),
  costLimitCny: z.number().min(0).max(1_000_000),
  actualRequests: z.number().int().nonnegative(),
  actualImages: z.number().int().nonnegative(),
  actualCostCny: z.number().min(0).max(1_000_000).nullable(),
  cost: generationCostSchema.optional(),
  status: generationBudgetReservationStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const generationSubscriptionStatusSchema = z.enum(['waiting', 'observed', 'cancelled'])

export const generationSubscriptionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  threadId: idSchema,
  turnId: idSchema,
  intentId: idSchema,
  jobId: z.string().trim().min(1).max(500),
  status: generationSubscriptionStatusSchema,
  lastJobStatus: generationJobStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  observedAt: z.string().datetime({ offset: true }).nullable()
})

export const generationResultRecordSchema = z.object({
  resultId: idSchema,
  intentId: idSchema,
  promptPackageHash: hashSchema.nullable(),
  promptPackage: z.unknown().nullable(),
  sourceSceneRevision: z.number().int().nonnegative().nullable(),
  profileId: z.string().trim().min(1).max(120),
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  operation: generationWorkflowOperationSchema,
  actualCostCny: z.number().min(0).max(1_000_000).nullable(),
  cost: generationCostSchema.optional(),
  createdAt: z.string().datetime({ offset: true })
})

export const generationResultFamilyMemberSchema = z.object({
  resultId: idSchema,
  jobId: z.string().trim().min(1).max(500),
  assetId: idSchema,
  parentResultId: idSchema.nullable(),
  rootResultId: idSchema,
  variantIndex: z.number().int().nonnegative(),
  favorite: z.boolean(),
  profileId: z.string().trim().min(1).max(120).nullable(),
  operation: generationWorkflowOperationSchema.nullable(),
  sourceSceneRevision: z.number().int().nonnegative().nullable(),
  promptPackageHash: hashSchema.nullable(),
  sourceBriefId: idSchema.nullable().default(null),
  sourceDirectionId: idSchema.nullable().default(null),
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  actualCostCny: z.number().min(0).max(1_000_000).nullable(),
  cost: generationCostSchema.optional(),
  copiedFromProjectId: idSchema.nullable().optional(),
  referenceMode: z.enum(['visual', 'structure', 'hybrid']).default('hybrid'),
  variationInstruction: z.string().max(4_000).default(''),
  preserveConstraints: z.string().max(4_000).default(''),
  createdAt: z.string().datetime({ offset: true })
})

export const generationResultFamilySchema = z.object({
  id: idSchema,
  rootResultId: idSchema,
  members: z.array(generationResultFamilyMemberSchema).min(1),
  favoriteResultIds: z.array(idSchema),
  latestResultId: idSchema
})

export const generationResultFavoriteInputSchema = z.object({
  projectId: idSchema.optional(),
  resultId: idSchema,
  favorite: z.boolean()
})

export const placeGenerationResultInputSchema = z.object({
  projectId: idSchema.optional(),
  resultId: idSchema,
  placementId: idSchema,
  origin: z.enum(['user', 'agent']).default('user')
})

export const placeGenerationResultReceiptSchema = z.object({
  resultId: idSchema,
  jobId: z.string().trim().min(1).max(500),
  assetId: idSchema,
  elementId: idSchema,
  batchId: idSchema,
  sceneRevision: z.number().int().positive(),
  reused: z.boolean()
})

export type GenerationWorkflowOperation = z.infer<typeof generationWorkflowOperationSchema>
export type GenerationWorkflowSpec = z.infer<typeof generationWorkflowSpecSchema>
export type ProviderCapabilityWarning = z.infer<typeof providerCapabilityWarningSchema>
export type ProviderCompiledRequest = z.infer<typeof providerCompiledRequestSchema>
export type GenerationWorkflowIntentStatus = z.infer<typeof generationWorkflowIntentStatusSchema>
export type GenerationWorkflowIntent = z.infer<typeof generationWorkflowIntentSchema>
export type GenerationBudgetReservation = z.infer<typeof generationBudgetReservationSchema>
export type GenerationSubscription = z.infer<typeof generationSubscriptionSchema>
export type GenerationResultRecord = z.infer<typeof generationResultRecordSchema>
export type GenerationResultFamily = z.infer<typeof generationResultFamilySchema>
export type GenerationResultFavoriteInput = z.infer<typeof generationResultFavoriteInputSchema>
export type PlaceGenerationResultInput = z.infer<typeof placeGenerationResultInputSchema>
export type PlaceGenerationResultReceipt = z.infer<typeof placeGenerationResultReceiptSchema>
