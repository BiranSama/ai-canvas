import { z } from 'zod'
import { canvasSchema, sceneElementSchema, sceneRelationSchema } from '../scene/schema'
import { creativeContextSchema, elementProvenanceSchema } from '../creative/schema'

const idSchema = z.string().uuid()

const setCanvasCommandSchema = z.object({
  kind: z.literal('scene.set-canvas'),
  canvas: canvasSchema
})

const setCreativeContextCommandSchema = z.object({
  kind: z.literal('scene.set-creative-context'),
  creativeContext: creativeContextSchema.nullable()
})

const addElementCommandSchema = z.object({
  kind: z.literal('element.add'),
  element: sceneElementSchema
})

const updateElementCommandSchema = z.object({
  kind: z.literal('element.update'),
  elementId: idSchema,
  changes: z.record(z.string(), z.unknown())
})

const setImageCommandSchema = z.object({
  kind: z.literal('element.set-image'),
  elementId: idSchema,
  assetId: idSchema,
  provenance: elementProvenanceSchema
})

const removeElementCommandSchema = z.object({
  kind: z.literal('element.remove'),
  elementId: idSchema
})

const reorderElementCommandSchema = z.object({
  kind: z.literal('element.reorder'),
  elementId: idSchema,
  toIndex: z.number().int().nonnegative()
})

const groupElementsCommandSchema = z.object({
  kind: z.literal('element.group'),
  group: sceneElementSchema.refine((element) => element.type === 'group', {
    message: 'The group payload must be a group element.'
  }),
  elementIds: z.array(idSchema).min(1).max(10_000)
})

const ungroupElementsCommandSchema = z.object({
  kind: z.literal('element.ungroup'),
  groupId: idSchema
})

const addRelationCommandSchema = z.object({
  kind: z.literal('relation.add'),
  relation: sceneRelationSchema
})

const removeRelationCommandSchema = z.object({
  kind: z.literal('relation.remove'),
  relationId: idSchema
})

export const sceneCommandSchema = z.discriminatedUnion('kind', [
  setCanvasCommandSchema,
  setCreativeContextCommandSchema,
  addElementCommandSchema,
  updateElementCommandSchema,
  setImageCommandSchema,
  removeElementCommandSchema,
  reorderElementCommandSchema,
  groupElementsCommandSchema,
  ungroupElementsCommandSchema,
  addRelationCommandSchema,
  removeRelationCommandSchema
])

export const commandBatchInputSchema = z.object({
  id: idSchema,
  origin: z.enum(['user', 'agent', 'system']),
  summary: z.string().trim().min(1).max(240),
  commands: z.array(sceneCommandSchema).min(1).max(1000)
})

export type SceneCommand = z.infer<typeof sceneCommandSchema>
export type CommandBatchInput = z.infer<typeof commandBatchInputSchema>
