import { z } from 'zod'
import { agentResultReferenceSchema } from './agent-result-reference'
import {
  canvasSchema,
  elementControlIntentSchema,
  elementProvenanceSchema,
  groupElementSchema,
  normalizedTransformSchema,
  sceneElementSchema,
  textVisualWeightSchema
} from '../domain'

const idSchema = z.string().uuid()
const colorSchema = z.string().trim().min(1).max(64)

const atomicWriteBase = {
  expectedSceneRevision: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(240)
}

export const sceneGetSummaryToolSchema = z.object({
  kind: z.literal('scene.get_summary')
})

export const sceneGetElementsToolSchema = z.object({
  kind: z.literal('scene.get_elements'),
  elementIds: z.array(idSchema).max(100).default([])
})

export const sceneSetCanvasToolSchema = z.object({
  kind: z.literal('scene.set_canvas'),
  ...atomicWriteBase,
  canvas: canvasSchema
})

export const sceneCreateElementsToolSchema = z.object({
  kind: z.literal('scene.create_elements'),
  ...atomicWriteBase,
  elements: z.array(sceneElementSchema).min(1).max(100)
})

export const sceneElementChangesSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4_000).optional(),
  transform: normalizedTransformSchema.optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  blendMode: z.enum(['normal', 'multiply', 'screen', 'overlay', 'soft-light']).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  semanticRole: z.string().trim().min(1).max(120).optional(),
  referencePolicy: z.enum(['include', 'reference-only', 'exclude']).optional(),
  controlIntent: elementControlIntentSchema.optional(),
  provenance: elementProvenanceSchema.optional(),
  assetId: idSchema.optional(),
  crop: z.object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1)
  }).optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  referenceRole: z.enum(['subject', 'style', 'composition', 'color', 'material', 'general']).optional(),
  content: z.string().max(4_000).optional(),
  orientation: z.enum(['horizontal', 'vertical']).optional(),
  align: z.enum(['start', 'center', 'end', 'justify']).optional(),
  wrapping: z.enum(['none', 'word', 'character']).optional(),
  fontFamily: z.string().trim().min(1).max(240).optional(),
  fontSize: z.number().finite().min(8).max(512).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fill: colorSchema.optional(),
  stroke: colorSchema.nullable().optional(),
  strokeWidth: z.number().finite().min(0).max(32).optional(),
  shadowColor: colorSchema.nullable().optional(),
  shadowBlur: z.number().finite().min(0).max(128).optional(),
  letterSpacing: z.number().finite().min(-100).max(100).optional(),
  lineHeight: z.number().finite().min(0.5).max(5).optional(),
  accuracy: z.enum(['strict', 'balanced', 'expressive']).optional(),
  visualWeight: textVisualWeightSchema.optional(),
  styleDescription: z.string().max(4_000).optional(),
  renderStrategy: z.enum(['standard', 'ai-material', 'ai-complete', 'editable-overlay']).optional(),
  resultAssetId: idSchema.nullable().optional(),
  fidelity: z.number().finite().min(0).max(1).optional(),
  finalVisible: z.boolean().optional(),
  shape: z.enum(['rectangle', 'ellipse', 'line']).optional(),
  cornerRadius: z.number().finite().min(0).max(0.5).optional(),
  role: z.enum(['final', 'placeholder']).optional(),
  subject: z.string().trim().min(1).max(1_000).optional(),
  pose: z.string().max(1_000).optional(),
  facing: z.string().max(240).optional(),
  allowOverflow: z.boolean().optional(),
  transparentBackground: z.boolean().optional(),
  frameShape: z.enum(['rectangle', 'ellipse', 'portrait', 'free']).optional(),
  visualKind: z.enum(['product', 'portrait', 'architecture', 'botanical', 'abstract', 'album', 'coffee', 'landscape', 'generic']).optional(),
  generationNotes: z.string().max(4_000).optional(),
  direction: z.number().finite().min(-3600).max(3600).optional(),
  color: colorSchema.optional(),
  intensity: z.number().finite().min(0).max(1).optional(),
  softness: z.number().finite().min(0).max(1).optional(),
  range: z.number().finite().positive().max(4).optional(),
  targetElementIds: z.array(idSchema).max(1_000).optional(),
  mode: z.enum(['edit', 'protect', 'generate']).optional(),
  feather: z.number().finite().min(0).max(1).optional()
}).strict().refine((changes) => Object.keys(changes).length > 0, 'At least one supported element field is required.')

export const sceneUpdateElementsToolSchema = z.object({
  kind: z.literal('scene.update_elements'),
  ...atomicWriteBase,
  updates: z.array(z.object({
    elementId: idSchema,
    changes: sceneElementChangesSchema
  })).min(1).max(100)
})

export const sceneReorderElementsToolSchema = z.object({
  kind: z.literal('scene.reorder_elements'),
  ...atomicWriteBase,
  moves: z.array(z.object({ elementId: idSchema, toIndex: z.number().int().nonnegative() })).min(1).max(100)
})

export const sceneGroupElementsToolSchema = z.object({
  kind: z.literal('scene.group_elements'),
  ...atomicWriteBase,
  group: groupElementSchema,
  elementIds: z.array(idSchema).min(1).max(1_000)
})

export const sceneRemoveElementsToolSchema = z.object({
  kind: z.literal('scene.remove_elements'),
  ...atomicWriteBase,
  elementIds: z.array(idSchema).min(1).max(100)
})

export const historyUndoBatchToolSchema = z.object({
  kind: z.literal('history.undo_batch'),
  expectedSceneRevision: z.number().int().nonnegative(),
  batchId: idSchema.nullable().default(null)
})

export const resultPlaceOnCanvasToolSchema = z.object({
  kind: z.literal('result.place_on_canvas'),
  resultId: agentResultReferenceSchema,
  targetElementId: idSchema.optional().describe('替换已有图片或占位时指定，保留目标布局。')
})

export const atomicAgentToolPlanSchemas = [
  sceneGetSummaryToolSchema,
  sceneGetElementsToolSchema,
  sceneSetCanvasToolSchema,
  sceneCreateElementsToolSchema,
  sceneUpdateElementsToolSchema,
  sceneReorderElementsToolSchema,
  sceneGroupElementsToolSchema,
  sceneRemoveElementsToolSchema,
  historyUndoBatchToolSchema,
  resultPlaceOnCanvasToolSchema
] as const
