import { z } from 'zod'
import { generationReferenceSourceSchema } from './generation-reference'

export const generationWorkContextFields = z.object({
  prompt: z.string().max(8_000).default(''),
  negativePrompt: z.string().max(8_000).default('低清晰度，杂乱布局，错误文字，过度饱和'),
  ratioInput: z.string().max(40).default('4:5'),
  quantity: z.number().int().min(1).max(4).default(1),
  profileId: z.string().max(120).default('local-sketch'),
  profileSelectionMade: z.boolean().default(false),
  model: z.string().max(300).default('mock-balanced'),
  referenceResultId: z.string().uuid().nullable().default(null),
  referenceSource: generationReferenceSourceSchema.default({ kind: 'text' }),
  referenceMode: z.enum(['visual', 'structure', 'hybrid']).default('hybrid'),
  variationInstruction: z.string().max(8_000).default(''),
  preserveConstraints: z.string().max(8_000).default(''),
  expandedSections: z.array(z.enum(['parameters', 'references', 'advanced'])).max(3).default(['parameters']),
  focusedResultId: z.string().uuid().nullable().default(null),
  compareAId: z.string().uuid().nullable().default(null),
  compareBId: z.string().uuid().nullable().default(null),
  compareEnabled: z.boolean().default(false),
  compareActiveSide: z.enum(['A', 'B']).default('A'),
  familyExpanded: z.boolean().default(false),
  resultScrollLeft: z.number().nonnegative().max(1_000_000).default(0)
}).strict()

// A saved mode alone is not consent to attach today's canvas. Preserve the
// legacy prompt and require an explicit object choice before the next request.
export const generationWorkContextSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  if (input.referenceSource !== undefined) return value
  return { ...input, referenceSource: typeof input.referenceResultId === 'string'
    ? { kind: 'result', resultId: input.referenceResultId }
    : Object.hasOwn(input, 'referenceMode') ? { kind: 'unresolved' } : { kind: 'text' } }
}, generationWorkContextFields)

export const projectWorkContextSchema = z.object({
  version: z.literal(1),
  projectId: z.string().uuid(),
  generation: generationWorkContextSchema,
  conversationDraft: z.string().max(8_000).default(''),
  workspace: z.object({
    activeView: z.enum(['conversation', 'canvas', 'generate']).default('canvas'),
    selectedIds: z.array(z.string().uuid()).max(1_000).default([]),
    zoom: z.number().min(.05).max(32).default(1),
    pan: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
    inspectorOpen: z.boolean().default(true),
    inspectorTab: z.enum(['layers', 'properties']).default('layers'),
    transformRatioLocked: z.boolean().default(false),
    geometryUnit: z.enum(['px', 'percent']).default('px')
  }).strict()
}).strict()

export type GenerationWorkContext = z.infer<typeof generationWorkContextSchema>
export type ProjectWorkContext = z.infer<typeof projectWorkContextSchema>

export function defaultProjectWorkContext(projectId: string, ratio = '4:5'): ProjectWorkContext {
  return projectWorkContextSchema.parse({ version: 1, projectId, generation: { ratioInput: ratio }, workspace: {} })
}
