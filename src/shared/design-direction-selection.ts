import { z } from 'zod'

const idSchema = z.string().uuid()

export const designDirectionSelectionInputSchema = z.object({
  sourceRunId: idSchema,
  briefId: idSchema,
  directionId: idSchema,
  expectedSceneRevision: z.number().int().nonnegative(),
  resolution: z.enum(['strict', 'replace_agent_structure']).default('strict')
})

const selectionBaseSchema = z.object({
  directionId: idSchema,
  sceneRevision: z.number().int().nonnegative()
})

export const designDirectionSelectionResultSchema = z.discriminatedUnion('status', [
  z.object({
    ...selectionBaseSchema.shape,
    status: z.literal('applied'),
    batchId: idSchema,
    affectedElementIds: z.array(idSchema).max(10_000),
    message: z.string().trim().min(1).max(1_000)
  }),
  z.object({
    ...selectionBaseSchema.shape,
    status: z.literal('unchanged'),
    batchId: z.null(),
    affectedElementIds: z.array(idSchema).max(10_000),
    message: z.string().trim().min(1).max(1_000)
  }),
  z.object({
    ...selectionBaseSchema.shape,
    status: z.literal('conflict'),
    code: z.enum([
      'SCENE_REVISION_CHANGED',
      'MANUAL_SCENE_CHANGES',
      'PROTECTED_SCENE_CONTENT'
    ]),
    message: z.string().trim().min(1).max(1_000),
    canReplaceAgentStructure: z.boolean(),
    canRetryAfterUndo: z.boolean(),
    canTryTemporarily: z.boolean()
  }),
  z.object({
    ...selectionBaseSchema.shape,
    status: z.literal('rejected'),
    code: z.enum([
      'CREATIVE_CONTEXT_MISSING',
      'BRIEF_MISMATCH',
      'DIRECTION_NOT_FOUND',
      'CREATIVE_CONTEXT_INVALID',
      'SCENE_COMMAND_REJECTED',
      'SCENE_PERSIST_FAILED'
    ]),
    message: z.string().trim().min(1).max(1_000)
  })
])

export type DesignDirectionSelectionInput = z.infer<typeof designDirectionSelectionInputSchema>
export type DesignDirectionSelectionResult = z.infer<typeof designDirectionSelectionResultSchema>

