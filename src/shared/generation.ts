import { z } from 'zod'
import type { GenerationCost } from './generation-cost'
import { generationReferenceSourceSchema } from './generation-reference'

export const generationJobStatusSchema = z.enum([
  'queued',
  'preparing',
  'generating',
  'downloading',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
])

// Adding a Job state must explicitly classify it for every lifecycle consumer.
const generationJobTerminal = {
  queued: false, preparing: false, generating: false, downloading: false,
  completed: true, failed: true, cancelled: true, timed_out: true, interrupted: true
} satisfies Record<z.infer<typeof generationJobStatusSchema>, boolean>

export function isTerminalGenerationJobStatus(status: z.infer<typeof generationJobStatusSchema>): boolean {
  return generationJobTerminal[status]
}

export const generationStageSchema = z.enum([
  'queued',
  'validating',
  'submitting',
  'generating',
  'localizing',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
])

export const generationReferenceSchema = z.object({
  assetId: z.string().min(1),
  intent: z.enum(['composition', 'style', 'subject', 'color', 'edit-source', 'mask']),
  strength: z.number().min(0).max(1).default(0.7)
})

export const referenceModeSchema = z.enum(['visual', 'structure', 'hybrid'])

export const generationRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().max(4_000).default(''),
  aspectWidth: z.number().int().min(1).max(100),
  aspectHeight: z.number().int().min(1).max(100),
  outputWidth: z.number().int().min(64).max(16_384),
  outputHeight: z.number().int().min(64).max(16_384),
  count: z.number().int().min(1).max(4).default(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  references: z.array(generationReferenceSchema).max(8).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  sourceMessageId: z.string().min(1).nullable().default(null),
  parentResultId: z.string().min(1).nullable().default(null),
  referenceMode: referenceModeSchema.default('hybrid'),
  variationInstruction: z.string().max(4_000).default(''),
  preserveConstraints: z.string().max(4_000).default('')
})

export const editRequestSchema = z.object({
  kind: z.literal('edit'),
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().max(4_000).default(''),
  aspectWidth: z.number().int().min(1).max(100),
  aspectHeight: z.number().int().min(1).max(100),
  outputWidth: z.number().int().min(64).max(16_384),
  outputHeight: z.number().int().min(64).max(16_384),
  count: z.number().int().min(1).max(4).default(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  sourceAssetId: z.string().min(1),
  maskAssetId: z.string().min(1),
  references: z.array(generationReferenceSchema).max(8).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  sourceMessageId: z.string().min(1).nullable().default(null),
  parentResultId: z.string().min(1).nullable().default(null),
  referenceMode: referenceModeSchema.default('hybrid'),
  variationInstruction: z.string().max(4_000).default(''),
  preserveConstraints: z.string().max(4_000).default('')
})

export const imageTaskRequestSchema = z.union([editRequestSchema, generationRequestSchema])

export const providerCapabilitiesSchema = z.object({
  textToImage: z.boolean(),
  imageReferences: z.boolean(),
  maskEditing: z.boolean(),
  multipleReferences: z.boolean(),
  transparentOutput: z.boolean(),
  maxImages: z.number().int().min(1),
  supportedRatios: z.array(z.string()),
  supportedFormats: z.array(z.enum(['png', 'jpeg', 'webp']))
})

export const generationProfileTierSchema = z.enum(['local-sketch', 'draft', 'final'])
export const generationProfileOperationSchema = z.enum(['generate', 'reference', 'edit', 'multi-image'])
export const generationProfileStatusSchema = z.enum(['available', 'locked', 'invalid'])

export const generationProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  tier: generationProfileTierSchema,
  providerId: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(200),
  supportedOperations: z.array(generationProfileOperationSchema).min(1).max(4),
  defaultQuantity: z.number().int().min(1).max(4),
  maxQuantity: z.number().int().min(1).max(4),
  requireConfirmation: z.boolean(),
  simulated: z.boolean(),
  estimatedUnitCostCny: z.number().min(0).max(10_000).nullable(),
  budgetPolicyId: z.string().trim().min(1).max(120)
}).superRefine((profile, context) => {
  if (profile.defaultQuantity > profile.maxQuantity) {
    context.addIssue({ code: 'custom', path: ['defaultQuantity'], message: 'Default quantity cannot exceed the profile maximum.' })
  }
})

export const generationProfileAvailabilitySchema = z.object({
  profile: generationProfileSchema,
  status: generationProfileStatusSchema,
  reason: z.string().trim().min(1).max(500).nullable(),
  actualUnitCostCny: z.number().min(0).max(10_000).nullable()
})

export const generationProfileSnapshotSchema = z.object({
  realCallsAuthorized: z.boolean(),
  profiles: z.array(generationProfileAvailabilitySchema).min(1).max(20)
})

export const generationDraftSchema = z.object({
  prompt: z.string().max(8_000),
  negativePrompt: z.string().max(4_000),
  aspect: z.object({ width: z.number().int().min(1).max(100), height: z.number().int().min(1).max(100) }),
  quantity: z.number().int().min(1).max(4),
  profileId: z.string().trim().min(1).max(120),
  referenceResultIds: z.array(z.string().min(1).max(200)).max(8),
  sourceSceneRevision: z.number().int().nonnegative().nullable(),
  referenceMode: referenceModeSchema.default('hybrid'),
  variationInstruction: z.string().max(4_000).default(''),
  preserveConstraints: z.string().max(4_000).default(''),
  expandedSections: z.array(z.enum(['parameters', 'references', 'advanced'])).max(3)
})

export const generationProfileRequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  referenceSource: generationReferenceSourceSchema.optional(),
  expectedReferenceSignature: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profileId: z.string().trim().min(1).max(120),
  confirmed: z.boolean().default(false),
  operation: generationProfileOperationSchema,
  draft: generationDraftSchema,
  outputWidth: z.number().int().min(64).max(16_384),
  outputHeight: z.number().int().min(64).max(16_384),
  references: z.array(generationReferenceSchema).max(8).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  sourceMessageId: z.string().min(1).nullable().default(null),
  parentResultId: z.string().min(1).nullable().default(null),
  modelOverride: z.string().trim().min(1).max(200).nullable().default(null)
}).superRefine((input, context) => {
  if (input.profileId !== input.draft.profileId) context.addIssue({ code: 'custom', path: ['draft', 'profileId'], message: 'Draft and request profile IDs must match.' })
  if (input.references.length > 0 && input.operation === 'generate') context.addIssue({ code: 'custom', path: ['operation'], message: 'Reference inputs require the reference operation.' })
})

export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>
export type GenerationStage = z.infer<typeof generationStageSchema>
export type GenerationReference = z.infer<typeof generationReferenceSchema>
export type ReferenceMode = z.infer<typeof referenceModeSchema>
export type GenerationRequest = z.infer<typeof generationRequestSchema>
export type EditRequest = z.infer<typeof editRequestSchema>
export type ImageTaskRequest = z.infer<typeof imageTaskRequestSchema>
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>
export type GenerationProfileTier = z.infer<typeof generationProfileTierSchema>
export type GenerationProfileOperation = z.infer<typeof generationProfileOperationSchema>
export type GenerationProfile = z.infer<typeof generationProfileSchema>
export type GenerationProfileAvailability = z.infer<typeof generationProfileAvailabilitySchema>
export type GenerationProfileSnapshot = z.infer<typeof generationProfileSnapshotSchema>
export type GenerationDraft = z.infer<typeof generationDraftSchema>
export type GenerationProfileRequest = z.infer<typeof generationProfileRequestSchema>

export interface GenerationError {
  readonly code: string
  readonly message: string
  readonly stage: GenerationStage
}

export interface GenerationResult {
  readonly assetAvailable?: boolean
  readonly id: string
  readonly jobId: string
  readonly projectId: string
  readonly assetId: string
  readonly variantIndex: number
  readonly parentResultId: string | null
  readonly favorite: boolean
  readonly referenceDeleted: boolean
  readonly createdAt: string
}

export interface GenerationJob {
  readonly cost?: GenerationCost
  readonly copiedFromProjectId?: string | null
  readonly id: string
  readonly executionIdentityId?: string | null
  readonly effectiveTimeoutMs?: number | null
  readonly submissionState?: 'not_sent' | 'may_have_sent' | 'accepted'
  readonly projectId: string
  readonly providerId: string
  readonly model: string
  readonly request: ImageTaskRequest
  readonly status: GenerationJobStatus
  readonly stage: GenerationStage
  readonly externalTaskId: string | null
  readonly attempt: number
  readonly parentJobId: string | null
  readonly sourceMessageId: string | null
  readonly cancelRequested: boolean
  readonly error: GenerationError | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly results: readonly GenerationResult[]
}
