import { z } from 'zod'
import type { CompletionFacts } from './design-capability'
import { creativeBriefSchema, creativeContextSchema, creativeDesignContractSchema, elementControlIntentSchema, elementProvenanceSchema, sceneCommandSchema, sceneElementSchema } from '../domain'
import { generationRequestSchema } from './generation'
import { agentFailureEnvelopeSchema } from './agent-recovery'
import { atomicAgentToolPlanSchemas } from './agent-atomic-tools'
import { agentResultReferenceSchema } from './agent-result-reference'

export const agentRunStatusSchema = z.enum([
  'queued',
  'planning',
  'awaiting_confirmation',
  'awaiting_execution',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
])

export const agentActivityStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export const agentActivityKindSchema = z.enum([
  'plan',
  'tool',
  'generation',
  'decision',
  'receipt',
  'recovery'
])

export const agentActivityEventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.string().trim().min(1).max(80),
  state: agentActivityStateSchema,
  summary: z.string().trim().min(1).max(500),
  createdAt: z.string().datetime({ offset: true })
})

export const agentDecisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  consequence: z.string().trim().min(1).max(300)
})

export const agentDecisionSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  activityId: z.string().uuid(),
  kind: z.enum(['aspect_ratio', 'generation_confirmation', 'budget_alternative']),
  title: z.string().trim().min(1).max(200),
  consequence: z.string().trim().min(1).max(500),
  options: z.array(agentDecisionOptionSchema).min(2).max(6),
  defaultOptionId: z.string().trim().min(1).max(80),
  status: z.enum(['waiting', 'resolved', 'cancelled']),
  selectedOptionId: z.string().trim().min(1).max(80).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable()
})

export const activityBudgetImpactSchema = z.object({
  requests: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  maxCny: z.number().nonnegative()
})

export const agentActivitySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  kind: agentActivityKindSchema,
  eventType: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
  state: agentActivityStateSchema,
  progress: z.number().min(0).max(1).nullable(),
  objectLabel: z.string().trim().min(1).max(160),
  actionLabel: z.string().trim().min(1).max(240),
  impactLabel: z.string().trim().min(1).max(500),
  scopeLabel: z.string().trim().min(1).max(240).nullable(),
  affectedIds: z.array(z.string().uuid()).max(10_000),
  operationBatchId: z.string().uuid().nullable(),
  jobId: z.string().min(1).max(200).nullable(),
  budgetImpact: activityBudgetImpactSchema.nullable(),
  recoverable: z.boolean(),
  undoneAt: z.string().datetime({ offset: true }).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  events: z.array(agentActivityEventSchema),
  decision: agentDecisionSchema.nullable()
})

export const conversationAttachmentSchema = z.object({
  kind: z.enum(['selection', 'asset']),
  id: z.string().min(1),
  name: z.string().min(1).max(200)
})

export const sceneElementSummarySchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  semanticRole: z.string(),
  zIndex: z.number().int().nonnegative().optional(),
  groupId: z.string().uuid().nullable(),
  childIds: z.array(z.string().uuid()).max(1_000).optional(),
  locked: z.boolean(),
  visible: z.boolean(),
  referencePolicy: z.enum(['include', 'reference-only', 'exclude']).optional(),
  controlIntent: elementControlIntentSchema.optional(),
  provenance: elementProvenanceSchema.optional(),
  content: z.string().max(4_000).optional(),
  fontSize: z.number().min(8).max(512).optional(),
  fontFamily: z.string().max(240).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  align: z.enum(['start', 'center', 'end', 'justify']).optional(),
  assetId: z.string().uuid().optional(),
  hasEditMask: z.boolean().optional(),
  accuracy: z.enum(['strict', 'balanced', 'expressive']).optional(),
  visualWeight: z.enum(['whisper', 'secondary', 'primary', 'hero']).optional(),
  renderStrategy: z.enum(['standard', 'ai-material', 'ai-complete', 'editable-overlay']).optional(),
  resultAssetId: z.string().uuid().nullable().optional(),
  subject: z.string().max(1_000).optional(),
  visualKind: z.enum(['product', 'portrait', 'architecture', 'botanical', 'abstract', 'album', 'coffee', 'landscape', 'generic']).optional(),
  shapeRole: z.enum(['final', 'placeholder']).optional(),
  fill: z.string().max(64).optional(),
  lightIntensity: z.number().min(0).max(1).optional(),
  transform: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number()
  })
})

export const sceneSummarySchema = z.object({
  revision: z.number().int().nonnegative(),
  canvas: z.object({
    aspectWidth: z.number().int().positive(),
    aspectHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(),
    outputHeight: z.number().int().positive(),
    globalStyle: z.string()
  }),
  elementCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative().optional(),
  creativeBrief: creativeBriefSchema.nullable().optional(),
  creativeContext: creativeContextSchema.nullable().optional(),
  elements: z.array(sceneElementSummarySchema).max(10_000)
})

export const ephemeralAnnotationRegionSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(['edit', 'generate', 'protect']).default('edit'),
  points: z.array(z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  })).min(3).max(4_096),
  closed: z.boolean().default(true),
  width: z.number().min(0.001).max(0.2).default(0.015)
})

export const ephemeralAnnotationSchema = ephemeralAnnotationRegionSchema.extend({
  targetElementId: z.string().uuid().nullable().default(null),
  // Optional on the wire so R1 single-region turns remain readable. New R2
  // clients always send the complete region list.
  regions: z.array(ephemeralAnnotationRegionSchema).max(256).optional()
})

export const agentRequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(8_000),
  sceneSummary: sceneSummarySchema,
  selectedIds: z.array(z.string().uuid()).max(1_000),
  selectedElements: z.array(sceneElementSchema).max(1_000),
  attachments: z.array(conversationAttachmentSchema).max(20).default([]),
  ephemeralAnnotation: ephemeralAnnotationSchema.nullable().default(null),
  autoGenerate: z.boolean().default(false),
  activeGenerationJobId: z.string().min(1).nullable().default(null),
  generationBudget: z.object({
    jobsUsed: z.number().int().nonnegative(),
    imagesReserved: z.number().int().nonnegative(),
    jobsRemaining: z.number().int().nonnegative(),
    imagesRemaining: z.number().int().nonnegative(),
    reservedCostCny: z.number().nonnegative()
  }).optional(),
  generationResults: z.array(z.object({
    resultId: z.string().uuid(),
    jobId: z.string().uuid(),
    assetId: z.string().uuid(),
    providerId: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(300),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })).max(40).optional()
})

export const sceneBatchToolSchema = z.object({
  kind: z.literal('scene_batch'),
  summary: z.string().trim().min(1).max(240),
  commands: z.array(sceneCommandSchema).min(1).max(1_000)
})

export const generationToolSchema = z.object({
  kind: z.literal('generation'),
  request: generationRequestSchema
})

export const canvasGenerationToolSchema = z.object({
  kind: z.literal('canvas_generation'),
  originalRequirement: z.string().trim().min(1).max(8_000),
  providerId: z.string().min(1).default('mock'),
  model: z.string().min(1).default('mock-balanced'),
  count: z.number().int().min(1).max(4).default(1),
  referenceMode: z.enum(['visual', 'structure', 'hybrid']).default('hybrid'),
  sourceMessageId: z.string().min(1).nullable().default(null)
})

export const canvasEditToolSchema = z.object({
  kind: z.literal('canvas_edit'),
  targetElementId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8_000),
  providerId: z.string().min(1).default('mock'),
  model: z.string().min(1).default('mock-balanced'),
  count: z.number().int().min(1).max(4).default(1),
  sourceMessageId: z.string().min(1).nullable().default(null),
  ephemeralAnnotation: ephemeralAnnotationSchema.nullable().default(null)
})

export const cancelGenerationToolSchema = z.object({
  kind: z.literal('cancel_generation'),
  jobId: z.string().min(1)
})

export const memoryCandidateToolSchema = z.object({
  kind: z.literal('memory_candidate'),
  memoryKind: z.enum(['fact', 'choice', 'direction', 'constraint']),
  content: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1)
})

export const directiveCreateToolSchema = z.object({
  kind: z.literal('directive_create'),
  category: z.enum(['creative', 'content', 'workflow', 'privacy']),
  text: z.string().trim().min(1).max(4_000),
  priority: z.number().int().min(0).max(1_000).default(100)
})

export const placeGenerationResultToolSchema = z.object({
  kind: z.literal('place_generation_result'),
  resultId: agentResultReferenceSchema,
  targetElementId: z.string().uuid().optional().describe('替换已有图片或占位时指定；保留目标ID、布局和关系。省略则新增图片。')
})

export const readSceneToolSchema = z.object({
  kind: z.literal('read_scene'),
  elementIds: z.array(z.string().uuid()).min(1).max(100)
})

export const agentToolPlanSchema = z.discriminatedUnion('kind', [
  sceneBatchToolSchema,
  generationToolSchema,
  canvasGenerationToolSchema,
  canvasEditToolSchema,
  cancelGenerationToolSchema,
  memoryCandidateToolSchema,
  directiveCreateToolSchema,
  placeGenerationResultToolSchema,
  ...atomicAgentToolPlanSchemas
])

export const agentPlanSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  response: z.string().trim().min(1).max(4_000),
  nextAction: z.string().max(500).nullable(),
  tools: z.array(agentToolPlanSchema).max(12),
  designContract: creativeDesignContractSchema.optional()
})

export const agentToolOutcomeSchema = z.object({
  toolIndex: z.number().int().nonnegative(),
  ok: z.boolean(),
  batchId: z.string().uuid().nullable().default(null),
  jobId: z.string().nullable().default(null),
  affectedElementIds: z.array(z.string().uuid()).max(10_000).default([]),
  message: z.string().max(1_000),
  failure: agentFailureEnvelopeSchema.nullable().optional(),
  sceneRevisionBefore: z.number().int().nonnegative().optional(),
  sceneRevisionAfter: z.number().int().nonnegative().optional(),
  data: z.unknown().optional()
})

export const completeAgentRunSchema = z.object({
  runId: z.string().uuid(),
  outcomes: z.array(agentToolOutcomeSchema).max(12)
})

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>
export type AgentActivityKind = z.infer<typeof agentActivityKindSchema>
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>
export type AgentDecisionOption = z.infer<typeof agentDecisionOptionSchema>
export type AgentDecision = z.infer<typeof agentDecisionSchema>
export type ActivityBudgetImpact = z.infer<typeof activityBudgetImpactSchema>
export type AgentActivity = z.infer<typeof agentActivitySchema>
export type ConversationAttachment = z.infer<typeof conversationAttachmentSchema>
export type SceneElementSummary = z.infer<typeof sceneElementSummarySchema>
export type SceneSummary = z.infer<typeof sceneSummarySchema>
export type EphemeralAnnotation = z.infer<typeof ephemeralAnnotationSchema>
export type EphemeralAnnotationRegion = z.infer<typeof ephemeralAnnotationRegionSchema>
export type AgentRequest = z.infer<typeof agentRequestSchema>
export type AgentToolPlan = z.infer<typeof agentToolPlanSchema>
export type ReadSceneToolRequest = z.infer<typeof readSceneToolSchema>
export type AgentSdkToolRequest = AgentToolPlan | ReadSceneToolRequest
export type AgentPlan = z.infer<typeof agentPlanSchema>
export type AgentToolOutcome = z.infer<typeof agentToolOutcomeSchema>

export interface OperationReceiptItem {
  readonly object: string
  readonly action: string
  readonly impact: string
}

export interface OperationReceipt {
  readonly completion?: CompletionFacts
  readonly summary: string
  readonly items: readonly OperationReceiptItem[]
  readonly batchId: string | null
  readonly jobId: string | null
  readonly nextAction: string | null
  readonly undoable: boolean
  readonly designReview?: {
    readonly briefId?: string
    readonly directions: readonly {
      readonly id: string
      readonly title: string
      readonly recommended: boolean
      readonly composition: string
      readonly subject: string
      readonly typography: string
      readonly lighting: string
      readonly difference: string
    }[]
    readonly selectedDirectionId: string
    readonly capabilityPackIds: readonly string[]
    readonly total: number | null
    readonly recommendation: 'complete' | 'refine_once' | 'needs_user_review' | 'stop' | null
  }
}

export interface ConversationMessage {
  readonly id: string
  readonly conversationId: string
  readonly projectId: string
  readonly role: 'user' | 'assistant'
  readonly kind: 'text' | 'receipt' | 'error'
  readonly content: string
  readonly receipt: OperationReceipt | null
  readonly attachments: readonly ConversationAttachment[]
  readonly runId: string | null
  readonly createdAt: string
}

export interface AgentRun {
  readonly id: string
  readonly conversationId: string
  readonly projectId: string
  readonly userMessageId: string
  readonly status: AgentRunStatus
  readonly autoGenerate: boolean
  readonly confirmationRequired: boolean
  readonly maxSteps: number
  readonly stepCount: number
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
}

export interface ConversationSnapshot {
  readonly conversationId: string
  readonly projectId: string
  readonly messages: readonly ConversationMessage[]
  readonly runs: readonly AgentRun[]
  readonly activities: readonly AgentActivity[]
}
