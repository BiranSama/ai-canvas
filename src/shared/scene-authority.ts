import { z } from 'zod'
import { commandBatchInputSchema, sceneSchema } from '../domain'

const operationPatchSchema = z.object({
  op: z.enum(['replace', 'remove', 'add']),
  path: z.array(z.union([z.string(), z.number()])),
  value: z.unknown().optional()
})

export const operationBatchSchema = z.object({
  id: z.string().uuid(),
  origin: z.enum(['user', 'agent', 'system']),
  summary: z.string().trim().min(1).max(240),
  committedAt: z.string().datetime({ offset: true }),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().positive(),
  patches: z.array(operationPatchSchema),
  inversePatches: z.array(operationPatchSchema)
})

export const sceneAuthorityStateSchema = z.object({
  scene: sceneSchema,
  sequence: z.number().int().nonnegative(),
  canUndo: z.boolean(),
  canRedo: z.boolean()
})

export const sceneExecuteInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  expectedSceneRevision: z.number().int().nonnegative(),
  batch: commandBatchInputSchema
})

export const sceneHistoryInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  expectedSceneRevision: z.number().int().nonnegative(),
  batchId: z.string().uuid().nullable().default(null)
})

export const sceneAuthorityErrorSchema = z.object({
  code: z.enum([
    'SCENE_REVISION_STALE',
    'SCENE_COMMAND_REJECTED',
    'SCENE_HISTORY_EMPTY',
    'SCENE_BATCH_NOT_LATEST',
    'SCENE_PERSIST_FAILED'
  ]),
  message: z.string().trim().min(1).max(1_000),
  recoverable: z.boolean()
})

export const sceneMutationReceiptSchema = z.object({
  state: sceneAuthorityStateSchema,
  action: z.enum(['execute', 'undo', 'redo']),
  batch: operationBatchSchema.nullable(),
  affectedBatchId: z.string().uuid().nullable()
})

export const sceneMutationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: sceneMutationReceiptSchema }),
  z.object({
    ok: z.literal(false),
    state: sceneAuthorityStateSchema,
    error: sceneAuthorityErrorSchema
  })
])

export const sceneChangedEventSchema = z.object({
  ...sceneMutationReceiptSchema.shape,
  projectId: z.string().uuid(),
  reason: z.enum(['user', 'agent', 'system', 'undo', 'redo'])
})

export type SceneAuthorityState = z.infer<typeof sceneAuthorityStateSchema>
export type SceneExecuteInput = z.infer<typeof sceneExecuteInputSchema>
export type SceneHistoryInput = z.infer<typeof sceneHistoryInputSchema>
export type SceneAuthorityError = z.infer<typeof sceneAuthorityErrorSchema>
export type SceneMutationReceipt = z.infer<typeof sceneMutationReceiptSchema>
export type SceneMutationResult = z.infer<typeof sceneMutationResultSchema>
export type SceneChangedEvent = z.infer<typeof sceneChangedEventSchema>
