import { z } from 'zod'
import { creativeContextSchema, elementControlIntentSchema, elementProvenanceSchema, textVisualWeightSchema } from '../creative/schema'

export const SCENE_SCHEMA_VERSION = 1 as const
export const ELEMENT_SCHEMA_VERSION = 1 as const

const finiteNumber = z.number().finite()
const normalizedPosition = finiteNumber.min(-4).max(4)
const normalizedSize = finiteNumber.positive().max(4)
const colorSchema = z.string().min(1).max(64)
const idSchema = z.string().uuid()

export const normalizedPointSchema = z.object({
  x: normalizedPosition,
  y: normalizedPosition
})

export const normalizedTransformSchema = z.object({
  x: normalizedPosition,
  y: normalizedPosition,
  width: normalizedSize,
  height: normalizedSize,
  rotation: finiteNumber.min(-3600).max(3600).default(0)
})

export const canvasSchema = z.object({
  aspectWidth: z.number().int().min(1).max(100),
  aspectHeight: z.number().int().min(1).max(100),
  outputWidth: z.number().int().min(64).max(16384),
  outputHeight: z.number().int().min(64).max(16384),
  backgroundColor: colorSchema,
  transparent: z.boolean(),
  globalStyle: z.string().max(4000).default('')
})

const referencePolicySchema = z.enum(['include', 'reference-only', 'exclude'])
export const blendModeSchema = z.enum(['normal', 'multiply', 'screen', 'overlay', 'soft-light'])

const elementBaseShape = {
  id: idSchema,
  version: z.literal(ELEMENT_SCHEMA_VERSION),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  transform: normalizedTransformSchema,
  zIndex: z.number().int().nonnegative(),
  opacity: finiteNumber.min(0).max(1).default(1),
  blendMode: blendModeSchema.optional(),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  groupId: idSchema.nullable().default(null),
  semanticRole: z.string().trim().min(1).max(120).default('content'),
  referencePolicy: referencePolicySchema.default('include'),
  controlIntent: elementControlIntentSchema.optional(),
  provenance: elementProvenanceSchema.optional()
}

export const imageElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('image'),
  assetId: idSchema,
  crop: z.object({
    x: finiteNumber.min(0).max(1),
    y: finiteNumber.min(0).max(1),
    width: finiteNumber.positive().max(1),
    height: finiteNumber.positive().max(1)
  }),
  fit: z.enum(['cover', 'contain', 'fill']),
  referenceRole: z.enum(['subject', 'style', 'composition', 'color', 'material', 'general'])
})

export const textElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('text'),
  content: z.string().max(4000),
  orientation: z.enum(['horizontal', 'vertical']),
  align: z.enum(['start', 'center', 'end', 'justify']),
  wrapping: z.enum(['none', 'word', 'character']),
  fontFamily: z.string().trim().min(1).max(240).default('Segoe UI Variable'),
  fontSize: finiteNumber.min(8).max(512).default(72),
  fontWeight: z.number().int().min(100).max(900).default(400),
  fill: colorSchema.default('#F4F4F2'),
  stroke: colorSchema.nullable().default(null),
  strokeWidth: finiteNumber.min(0).max(32).default(0),
  shadowColor: colorSchema.nullable().default(null),
  shadowBlur: finiteNumber.min(0).max(128).default(0),
  letterSpacing: finiteNumber.min(-100).max(100),
  lineHeight: finiteNumber.min(0.5).max(5),
  accuracy: z.enum(['strict', 'balanced', 'expressive']),
  visualWeight: textVisualWeightSchema.optional(),
  styleDescription: z.string().max(4000),
  renderStrategy: z.enum(['standard', 'ai-material', 'ai-complete', 'editable-overlay']),
  resultAssetId: idSchema.nullable()
})

export const sketchStrokeSchema = z.object({
  id: idSchema,
  points: z.array(normalizedPointSchema).min(2).max(20_000),
  color: colorSchema,
  width: finiteNumber.positive().max(1),
  opacity: finiteNumber.min(0).max(1)
})

export const sketchElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('sketch'),
  strokes: z.array(sketchStrokeSchema).max(10_000),
  fidelity: finiteNumber.min(0).max(1),
  finalVisible: z.boolean()
})

export const shapeElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('shape'),
  shape: z.enum(['rectangle', 'ellipse', 'line']),
  fill: colorSchema,
  stroke: colorSchema.nullable(),
  strokeWidth: finiteNumber.min(0).max(1),
  cornerRadius: finiteNumber.min(0).max(0.5).default(0),
  role: z.enum(['final', 'placeholder'])
})

export const placeholderElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('placeholder'),
  subject: z.string().trim().min(1).max(1000),
  pose: z.string().max(1000),
  facing: z.string().max(240),
  allowOverflow: z.boolean(),
  transparentBackground: z.boolean(),
  frameShape: z.enum(['rectangle', 'ellipse', 'portrait', 'free']).default('rectangle'),
  visualKind: z.enum(['product', 'portrait', 'architecture', 'botanical', 'abstract', 'album', 'coffee', 'landscape', 'generic']).optional(),
  generationNotes: z.string().max(4000)
})

export const lightElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('light'),
  direction: finiteNumber.min(-3600).max(3600),
  color: colorSchema,
  intensity: finiteNumber.min(0).max(1),
  softness: finiteNumber.min(0).max(1),
  range: finiteNumber.positive().max(4),
  targetElementIds: z.array(idSchema).max(1000)
})

export const maskPathSchema = z.object({
  id: idSchema,
  points: z.array(normalizedPointSchema).min(3).max(20_000),
  closed: z.boolean().default(true)
})

export const maskElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('mask'),
  mode: z.enum(['edit', 'protect', 'generate']),
  targetElementId: idSchema,
  paths: z.array(maskPathSchema).min(1).max(1000),
  feather: finiteNumber.min(0).max(1)
})

export const groupElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal('group'),
  childIds: z.array(idSchema).min(1).max(10_000)
})

export const sceneElementSchema = z.discriminatedUnion('type', [
  imageElementSchema,
  textElementSchema,
  sketchElementSchema,
  shapeElementSchema,
  placeholderElementSchema,
  lightElementSchema,
  maskElementSchema,
  groupElementSchema
])

export const sceneRelationSchema = z.object({
  id: idSchema,
  type: z.enum(['aligns-with', 'above', 'below', 'in-front-of', 'behind', 'points-to', 'illuminates']),
  sourceElementId: idSchema,
  targetElementId: idSchema,
  description: z.string().max(1000).default('')
})

const sceneBaseSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  id: idSchema,
  projectId: idSchema,
  revision: z.number().int().nonnegative(),
  canvas: canvasSchema,
  elements: z.array(sceneElementSchema).max(10_000),
  relations: z.array(sceneRelationSchema).max(20_000),
  creativeContext: creativeContextSchema.nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

export const sceneSchema = sceneBaseSchema.superRefine((scene, context) => {
  const elementsById = new Map(scene.elements.map((element) => [element.id, element]))
  const elementIds = scene.elements.map((element) => element.id)
  if (new Set(elementIds).size !== elementIds.length) {
    context.addIssue({ code: 'custom', path: ['elements'], message: 'Element IDs must be unique.' })
  }

  const relationIds = scene.relations.map((relation) => relation.id)
  if (new Set(relationIds).size !== relationIds.length) {
    context.addIssue({ code: 'custom', path: ['relations'], message: 'Relation IDs must be unique.' })
  }

  scene.elements.forEach((element, index) => {
    if (element.zIndex !== index) {
      context.addIssue({
        code: 'custom',
        path: ['elements', index, 'zIndex'],
        message: 'zIndex must match canonical element order.'
      })
    }

    if (element.groupId !== null) {
      const group = elementsById.get(element.groupId)
      if (group?.type !== 'group' || !group.childIds.includes(element.id)) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'groupId'],
          message: 'groupId must point to a group containing the element.'
        })
      }
    }

    if (element.type === 'group') {
      if (new Set(element.childIds).size !== element.childIds.length || element.childIds.includes(element.id)) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'childIds'],
          message: 'Group child IDs must be unique and cannot include the group itself.'
        })
      }
      for (const childId of element.childIds) {
        const child = elementsById.get(childId)
        if (child === undefined || child.groupId !== element.id) {
          context.addIssue({
            code: 'custom',
            path: ['elements', index, 'childIds'],
            message: 'Every group child must exist and point back to the group.'
          })
        }
      }
    }

    if (element.type === 'mask' && !elementsById.has(element.targetElementId)) {
      context.addIssue({
        code: 'custom',
        path: ['elements', index, 'targetElementId'],
        message: 'Mask target must exist.'
      })
    }

    if (element.type === 'light') {
      for (const targetId of element.targetElementIds) {
        if (!elementsById.has(targetId)) {
          context.addIssue({
            code: 'custom',
            path: ['elements', index, 'targetElementIds'],
            message: 'Light targets must exist.'
          })
        }
      }
    }

    if (
      element.blendMode !== undefined &&
      element.blendMode !== 'normal' &&
      (element.type === 'placeholder' || element.type === 'mask' || element.type === 'group')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['elements', index, 'blendMode'],
        message: `Blend mode ${element.blendMode} is not supported for ${element.type} elements.`
      })
    }
  })

  scene.relations.forEach((relation, index) => {
    if (
      relation.sourceElementId === relation.targetElementId ||
      !elementsById.has(relation.sourceElementId) ||
      !elementsById.has(relation.targetElementId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['relations', index],
        message: 'Relation endpoints must be different existing elements.'
      })
    }
  })
})

export type Scene = z.infer<typeof sceneSchema>
export type SceneElement = z.infer<typeof sceneElementSchema>
export type SceneRelation = z.infer<typeof sceneRelationSchema>
export type BlendMode = z.infer<typeof blendModeSchema>
export type NormalizedTransform = z.infer<typeof normalizedTransformSchema>
export type Canvas = z.infer<typeof canvasSchema>
