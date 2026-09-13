import { z } from 'zod'

export const outboundContextPolicySchema = z.enum([
  'minimal',
  'review_each_image',
  'local_only',
  'custom'
])

export const contextSourceTypeSchema = z.enum([
  'policy',
  'user',
  'directive',
  'scene',
  'selection',
  'job',
  'result',
  'memory',
  'summary',
  'preference',
  'capability'
])

export const contextDispositionSchema = z.enum([
  'inline',
  'tool_available',
  'outbound',
  'excluded'
])

export const contextEntrySchema = z.object({
  id: z.string().uuid(),
  manifestId: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  sourceType: contextSourceTypeSchema,
  sourceId: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative().nullable(),
  scope: z.string().trim().min(1).max(500),
  disposition: contextDispositionSchema,
  reason: z.string().trim().min(1).max(1_000),
  content: z.unknown(),
  estimatedBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true })
})

export const contextManifestSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  sceneRevision: z.number().int().nonnegative(),
  entries: z.array(contextEntrySchema).max(2_000),
  outboundPolicy: outboundContextPolicySchema,
  estimatedTextBytes: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true })
})

export const projectDirectiveCategorySchema = z.enum([
  'creative',
  'content',
  'workflow',
  'privacy'
])

export const projectDirectiveSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  text: z.string().trim().min(1).max(4_000),
  category: projectDirectiveCategorySchema,
  priority: z.number().int().min(0).max(1_000),
  enabled: z.boolean(),
  sourceMessageId: z.string().trim().min(1).max(500).nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const projectMemoryKindSchema = z.enum(['fact', 'choice', 'direction', 'constraint'])
export const projectMemorySourceTypeSchema = z.enum(['user', 'turn', 'candidate', 'migration'])
export const projectMemoryStatusSchema = z.enum(['active', 'disabled', 'expired', 'deleted'])

export const projectMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: projectMemoryKindSchema,
  content: z.string().trim().min(1).max(4_000),
  sourceType: projectMemorySourceTypeSchema,
  sourceId: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  status: projectMemoryStatusSchema,
  version: z.number().int().positive(),
  supersedesId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const memoryCandidateStatusSchema = z.enum(['pending', 'confirmed', 'rejected'])

export const memoryCandidateSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: projectMemoryKindSchema,
  content: z.string().trim().min(1).max(4_000),
  sourceType: z.enum(['turn', 'planner', 'migration']),
  sourceId: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  status: memoryCandidateStatusSchema,
  confirmedMemoryId: z.string().uuid().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const contextCompactionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  sourceSequenceFrom: z.number().int().positive(),
  sourceSequenceTo: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(64_000),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true })
}).superRefine((value, context) => {
  if (value.sourceSequenceTo < value.sourceSequenceFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceSequenceTo'],
      message: 'Compaction sequence range is invalid.'
    })
  }
})

export const outboundContextStatusSchema = z.enum([
  'prepared',
  'approved',
  'blocked',
  'sent',
  'cancelled'
])

export const outboundContextRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  manifestId: z.string().uuid(),
  toolCallId: z.string().uuid().nullable(),
  providerId: z.string().trim().min(1).max(200).nullable(),
  model: z.string().trim().min(1).max(300).nullable(),
  policy: outboundContextPolicySchema,
  dataTypes: z.array(z.string().trim().min(1).max(120)).max(100),
  imageAssetIds: z.array(z.string().uuid()).max(100),
  textBytes: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  imageBytes: z.number().int().nonnegative().nullable(),
  approvalId: z.string().uuid().nullable(),
  requestCorrelationId: z.string().trim().min(1).max(200).nullable(),
  status: outboundContextStatusSchema,
  reason: z.string().trim().min(1).max(1_000),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const projectKnowledgeSnapshotSchema = z.object({
  projectId: z.string().uuid(),
  outboundPolicy: outboundContextPolicySchema,
  outboundPolicyVersion: z.number().int().positive(),
  directives: z.array(projectDirectiveSchema),
  memories: z.array(projectMemoryEntrySchema),
  candidates: z.array(memoryCandidateSchema),
  latestManifest: contextManifestSchema.nullable(),
  outboundRecords: z.array(outboundContextRecordSchema)
})

export const createProjectDirectiveInputSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  category: projectDirectiveCategorySchema,
  priority: z.number().int().min(0).max(1_000).default(100),
  sourceMessageId: z.string().trim().min(1).max(500).nullable().default(null)
})

export const updateProjectDirectiveInputSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  text: z.string().trim().min(1).max(4_000).optional(),
  category: projectDirectiveCategorySchema.optional(),
  priority: z.number().int().min(0).max(1_000).optional(),
  enabled: z.boolean().optional()
}).refine((value) => Object.keys(value).some((key) => !['id', 'expectedVersion'].includes(key)), {
  message: 'Directive update must contain at least one changed field.'
})

export const createProjectMemoryInputSchema = z.object({
  kind: projectMemoryKindSchema,
  content: z.string().trim().min(1).max(4_000),
  sourceType: projectMemorySourceTypeSchema,
  sourceId: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1).default(1),
  supersedesId: z.string().uuid().nullable().default(null)
})

export const updateProjectMemoryInputSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  kind: projectMemoryKindSchema.optional(),
  content: z.string().trim().min(1).max(4_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: projectMemoryStatusSchema.optional()
}).refine((value) => Object.keys(value).some((key) => !['id', 'expectedVersion'].includes(key)), {
  message: 'Memory update must contain at least one changed field.'
})

export const createMemoryCandidateInputSchema = z.object({
  kind: projectMemoryKindSchema,
  content: z.string().trim().min(1).max(4_000),
  sourceType: z.enum(['turn', 'planner', 'migration']),
  sourceId: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1)
})

export const resolveMemoryCandidateInputSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  resolution: z.enum(['confirm', 'reject'])
})

export const setOutboundPolicyInputSchema = z.object({
  policy: outboundContextPolicySchema,
  expectedVersion: z.number().int().positive()
})

export type OutboundContextPolicy = z.infer<typeof outboundContextPolicySchema>
export type ContextSourceType = z.infer<typeof contextSourceTypeSchema>
export type ContextDisposition = z.infer<typeof contextDispositionSchema>
export type ContextEntry = z.infer<typeof contextEntrySchema>
export type ContextManifest = z.infer<typeof contextManifestSchema>
export type ProjectDirectiveCategory = z.infer<typeof projectDirectiveCategorySchema>
export type ProjectDirective = z.infer<typeof projectDirectiveSchema>
export type ProjectMemoryKind = z.infer<typeof projectMemoryKindSchema>
export type ProjectMemorySourceType = z.infer<typeof projectMemorySourceTypeSchema>
export type ProjectMemoryStatus = z.infer<typeof projectMemoryStatusSchema>
export type ProjectMemoryEntry = z.infer<typeof projectMemoryEntrySchema>
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>
export type ContextCompaction = z.infer<typeof contextCompactionSchema>
export type OutboundContextStatus = z.infer<typeof outboundContextStatusSchema>
export type OutboundContextRecord = z.infer<typeof outboundContextRecordSchema>
export type ProjectKnowledgeSnapshot = z.infer<typeof projectKnowledgeSnapshotSchema>
export type CreateProjectDirectiveInput = z.infer<typeof createProjectDirectiveInputSchema>
export type UpdateProjectDirectiveInput = z.infer<typeof updateProjectDirectiveInputSchema>
export type CreateProjectMemoryInput = z.infer<typeof createProjectMemoryInputSchema>
export type UpdateProjectMemoryInput = z.infer<typeof updateProjectMemoryInputSchema>
export type CreateMemoryCandidateInput = z.infer<typeof createMemoryCandidateInputSchema>
export type ResolveMemoryCandidateInput = z.infer<typeof resolveMemoryCandidateInputSchema>
export type SetOutboundPolicyInput = z.infer<typeof setOutboundPolicyInputSchema>
