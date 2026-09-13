import { z } from 'zod'
import { commandBatchInputSchema, sceneCommandSchema, sceneSchema } from '../domain'
import { agentToolOutcomeSchema } from './agent'

export const agentToolRiskSchema = z.enum([
  'read',
  'local_reversible',
  'persistent_reversible',
  'external',
  'dangerous'
])

export const agentPermissionSchema = z.enum([
  'project.read',
  'scene.read',
  'scene.write',
  'asset.read',
  'generation.read',
  'generation.create',
  'generation.cancel',
  'memory.read',
  'memory.write',
  'directive.write',
  'external.image',
  'dangerous'
])

export const agentToolDefinitionSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.number().int().positive(),
  risk: agentToolRiskSchema,
  requiredPermissions: z.array(agentPermissionSchema),
  supportsPreview: z.boolean(),
  supportsCancel: z.boolean(),
  idempotency: z.enum(['required', 'not_applicable']),
  implementation: z.enum(['available', 'planned'])
})

export const agentPermissionProfileSchema = z.object({
  id: z.string().trim().min(1).max(160),
  version: z.number().int().positive(),
  label: z.string().trim().min(1).max(200),
  permissions: z.array(agentPermissionSchema),
  allowedTools: z.array(z.string().trim().min(1).max(120)),
  allowExternal: z.boolean(),
  allowDangerous: z.boolean(),
  maxCostCny: z.number().nonnegative()
})

export const agentToolScopeSchema = z.object({
  canvas: z.boolean(),
  elementIds: z.array(z.string().uuid()).max(10_000)
})

export const sceneApplyBatchToolInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  expectedSceneRevision: z.number().int().nonnegative(),
  scope: agentToolScopeSchema,
  summary: z.string().trim().min(1).max(240),
  commands: z.array(sceneCommandSchema).min(1).max(1_000)
})

export const agentToolApprovalRecordSchema = z.object({
  effect: z.enum(['allow', 'ask', 'deny']),
  source: z.enum(['mode_policy', 'explicit_turn_request', 'persistent_grant', 'hard_policy']),
  code: z.string().trim().min(1).max(120),
  explanation: z.string().trim().min(1).max(500)
})

export const agentSceneToolPreviewSchema = z.object({
  expectedSceneRevision: z.number().int().nonnegative(),
  resultingSceneRevision: z.number().int().positive(),
  affectedElementIds: z.array(z.string().uuid()).max(10_000),
  operationCount: z.number().int().positive(),
  risk: agentToolRiskSchema,
  approval: agentToolApprovalRecordSchema,
  undoable: z.boolean()
})

export const agentSceneExecutionGrantSchema = z.object({
  toolCallId: z.string().uuid(),
  executionToken: z.string().min(32).max(256),
  expiresAt: z.string().datetime({ offset: true }),
  definition: agentToolDefinitionSnapshotSchema,
  batch: commandBatchInputSchema.extend({ origin: z.literal('agent') }),
  preview: agentSceneToolPreviewSchema
})

export const agentSceneToolPrepareResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('prepared'),
    grant: agentSceneExecutionGrantSchema
  }),
  z.object({
    state: z.literal('completed'),
    toolCallId: z.string().uuid(),
    outcome: agentToolOutcomeSchema
  })
])

const operationPatchSchema = z.object({
  op: z.enum(['replace', 'remove', 'add']),
  path: z.array(z.union([z.string(), z.number()])),
  value: z.unknown().optional()
})

export const agentOperationBatchSchema = z.object({
  id: z.string().uuid(),
  origin: z.literal('agent'),
  summary: z.string().trim().min(1).max(240),
  committedAt: z.string().datetime({ offset: true }),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().positive(),
  patches: z.array(operationPatchSchema),
  inversePatches: z.array(operationPatchSchema)
})

export const agentSceneToolCommitInputSchema = z.object({
  executionToken: z.string().min(32).max(256),
  rendererSessionId: z.string().uuid(),
  scene: sceneSchema,
  batch: agentOperationBatchSchema
})

export const agentSceneToolCommitReceiptSchema = z.object({
  toolCallId: z.string().uuid(),
  outcome: agentToolOutcomeSchema,
  replayed: z.boolean()
})

export const agentSceneToolPrepareIpcSchema = z.object({
  runId: z.string().uuid(),
  toolIndex: z.number().int().nonnegative().max(11),
  rendererSessionId: z.string().uuid()
})

export const agentSceneToolAbortIpcSchema = z.object({
  executionToken: z.string().min(32).max(256),
  rendererSessionId: z.string().uuid(),
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(1_000)
})

export type AgentToolRisk = z.infer<typeof agentToolRiskSchema>
export type AgentPermission = z.infer<typeof agentPermissionSchema>
export type AgentToolDefinitionSnapshot = z.infer<typeof agentToolDefinitionSnapshotSchema>
export type AgentPermissionProfile = z.infer<typeof agentPermissionProfileSchema>
export type AgentToolScope = z.infer<typeof agentToolScopeSchema>
export type SceneApplyBatchToolInput = z.infer<typeof sceneApplyBatchToolInputSchema>
export type AgentToolApprovalRecord = z.infer<typeof agentToolApprovalRecordSchema>
export type AgentSceneToolPreview = z.infer<typeof agentSceneToolPreviewSchema>
export type AgentSceneExecutionGrant = z.infer<typeof agentSceneExecutionGrantSchema>
export type AgentSceneToolPrepareResult = z.infer<typeof agentSceneToolPrepareResultSchema>
export type AgentSceneToolCommitInput = z.infer<typeof agentSceneToolCommitInputSchema>
export type AgentSceneToolCommitReceipt = z.infer<typeof agentSceneToolCommitReceiptSchema>
