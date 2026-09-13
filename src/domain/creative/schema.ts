import { z } from 'zod'

const idSchema = z.string().uuid()
const briefPositionSchema = z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'])
const relationKindSchema = z.enum(['aligns-with', 'above', 'below', 'in-front-of', 'behind', 'points-to', 'illuminates'])
const currentThemeSchema = z.enum(['portrait', 'architecture', 'botanical', 'abstract', 'product', 'album', 'coffee', 'landscape', 'general'])
export const textVisualWeightSchema = z.enum(['whisper', 'secondary', 'primary', 'hero'])

const briefSubjectSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1_000),
  pose: z.string().max(500),
  position: briefPositionSchema,
  prominence: z.enum(['primary', 'secondary', 'accent'])
})

const briefTextSchema = z.object({
  id: idSchema,
  content: z.string().min(1).max(1_000),
  role: z.enum(['title', 'subtitle', 'caption', 'label']),
  style: z.string().max(1_000),
  accuracy: z.enum(['strict', 'balanced', 'expressive']),
  mode: z.enum(['exact-overlay', 'reference', 'image-text']),
  visualWeight: textVisualWeightSchema.optional(),
  position: briefPositionSchema
})

const briefCompositionRelationSchema = z.object({
  kind: relationKindSchema,
  sourceId: idSchema,
  targetId: idSchema,
  description: z.string().max(1_000)
})

const briefLightingSchema = z.object({
  description: z.string().trim().min(1).max(500),
  color: z.string().trim().min(1).max(64),
  direction: z.number().min(-360).max(360),
  intensity: z.number().min(0).max(1),
  softness: z.number().min(0).max(1)
})

function validateBriefRelations(
  brief: { readonly subjects: readonly { readonly id: string }[]; readonly text: readonly { readonly id: string }[]; readonly composition: readonly { readonly sourceId: string; readonly targetId: string }[] },
  context: z.RefinementCtx
): void {
  const ids = [...brief.subjects.map((item) => item.id), ...brief.text.map((item) => item.id)]
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['subjects'], message: 'Brief object IDs must be unique.' })
  const validIds = new Set(ids)
  brief.composition.forEach((relation, index) => {
    if (relation.sourceId === relation.targetId || !validIds.has(relation.sourceId) || !validIds.has(relation.targetId)) {
      context.addIssue({ code: 'custom', path: ['composition', index], message: 'Brief relation endpoints must reference distinct brief objects.' })
    }
  })
}

export const creativeBriefV1Schema = z.object({
  version: z.literal(1),
  id: idSchema,
  originalRequirement: z.string().trim().min(1).max(8_000),
  intent: z.string().trim().min(1).max(500),
  theme: z.enum(['portrait', 'architecture', 'botanical', 'abstract', 'product', 'general']),
  media: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  mood: z.array(z.string().trim().min(1).max(120)).max(20),
  usage: z.string().trim().min(1).max(240).nullable(),
  aspectPreference: z.object({ width: z.number().int().min(1).max(100), height: z.number().int().min(1).max(100) }).nullable(),
  subjects: z.array(briefSubjectSchema).min(1).max(20),
  text: z.array(briefTextSchema).max(20),
  composition: z.array(briefCompositionRelationSchema).max(100),
  palette: z.array(z.string().trim().min(1).max(64)).max(20),
  lighting: z.array(briefLightingSchema).max(12),
  constraints: z.array(z.string().trim().min(1).max(500)).max(100),
  generationIntent: z.enum(['none', 'draft', 'final', 'ask'])
}).superRefine(validateBriefRelations)

export const creativeBriefV2Schema = z.object({
  version: z.literal(2),
  id: idSchema,
  originalRequirement: z.string().trim().min(1).max(8_000),
  purpose: z.string().trim().min(1).max(500),
  intent: z.string().trim().min(1).max(500),
  theme: currentThemeSchema,
  media: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  mood: z.array(z.string().trim().min(1).max(120)).max(20),
  usage: z.string().trim().min(1).max(240).nullable(),
  aspectPreference: z.object({ width: z.number().int().min(1).max(100), height: z.number().int().min(1).max(100) }).nullable(),
  subjects: z.array(briefSubjectSchema).min(1).max(20),
  text: z.array(briefTextSchema).max(20),
  composition: z.array(briefCompositionRelationSchema).max(100),
  compositionNotes: z.array(z.string().trim().min(1).max(500)).max(30),
  style: z.array(z.string().trim().min(1).max(240)).max(30),
  palette: z.array(z.string().trim().min(1).max(64)).max(20),
  lighting: z.array(briefLightingSchema).max(12),
  keep: z.array(z.string().trim().min(1).max(500)).max(100),
  prohibitions: z.array(z.string().trim().min(1).max(500)).max(100),
  constraints: z.array(z.string().trim().min(1).max(500)).max(100),
  ambiguities: z.array(z.object({
    id: idSchema,
    topic: z.string().trim().min(1).max(160),
    question: z.string().trim().min(1).max(500),
    impact: z.enum(['low', 'medium', 'high'])
  })).max(30),
  precision: z.enum(['precise', 'ambiguous']),
  generationIntent: z.enum(['none', 'draft', 'final', 'ask'])
}).superRefine(validateBriefRelations)

export const creativeBriefFieldSourceKindSchema = z.enum(['user', 'scene', 'agent_inference', 'legacy_unattributed'])

export const creativeBriefFieldSourceSchema = z.object({
  path: z.string().trim().min(1).max(300).regex(/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/, 'Field source path must be a valid non-root JSON Pointer.'),
  source: creativeBriefFieldSourceKindSchema,
  sourceId: z.string().trim().min(1).max(500).nullable(),
  evidence: z.string().trim().min(1).max(1_000).nullable()
})

export const creativeBriefAcceptanceCriterionSchema = z.object({
  id: idSchema,
  criterion: z.string().trim().min(1).max(500),
  priority: z.enum(['must', 'prefer'])
})

export const creativeBriefV3Schema = z.object({
  version: z.literal(3),
  id: idSchema,
  originalRequirement: z.string().trim().min(1).max(8_000),
  purpose: z.string().trim().min(1).max(500),
  intent: z.string().trim().min(1).max(500),
  theme: currentThemeSchema,
  media: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  mood: z.array(z.string().trim().min(1).max(120)).max(20),
  usage: z.string().trim().min(1).max(240).nullable(),
  aspectPreference: z.object({ width: z.number().int().min(1).max(100), height: z.number().int().min(1).max(100) }).nullable(),
  subjects: z.array(briefSubjectSchema).min(1).max(20),
  text: z.array(briefTextSchema).max(20),
  composition: z.array(briefCompositionRelationSchema).max(100),
  compositionNotes: z.array(z.string().trim().min(1).max(500)).max(30),
  style: z.array(z.string().trim().min(1).max(240)).max(30),
  palette: z.array(z.string().trim().min(1).max(64)).max(20),
  lighting: z.array(briefLightingSchema).max(12),
  keep: z.array(z.string().trim().min(1).max(500)).max(100),
  prohibitions: z.array(z.string().trim().min(1).max(500)).max(100),
  constraints: z.array(z.string().trim().min(1).max(500)).max(100),
  ambiguities: z.array(z.object({
    id: idSchema,
    topic: z.string().trim().min(1).max(160),
    question: z.string().trim().min(1).max(500),
    impact: z.enum(['low', 'medium', 'high'])
  })).max(30),
  precision: z.enum(['precise', 'ambiguous']),
  generationIntent: z.enum(['none', 'draft', 'final', 'ask']),
  audience: z.array(z.string().trim().min(1).max(240)).max(20),
  acceptanceCriteria: z.array(creativeBriefAcceptanceCriterionSchema).max(100),
  fieldSources: z.array(creativeBriefFieldSourceSchema).max(300),
  supersedesId: idSchema.nullable(),
  createdAt: z.string().datetime({ offset: true })
}).superRefine((brief, context) => {
  validateBriefRelations(brief, context)
  if (brief.id === brief.supersedesId) {
    context.addIssue({ code: 'custom', path: ['supersedesId'], message: 'A Creative Brief cannot supersede itself.' })
  }
  const criterionIds = brief.acceptanceCriteria.map((criterion) => criterion.id)
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({ code: 'custom', path: ['acceptanceCriteria'], message: 'Acceptance criterion IDs must be unique.' })
  }
  const sourcePaths = brief.fieldSources.map((source) => source.path)
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    context.addIssue({ code: 'custom', path: ['fieldSources'], message: 'Creative Brief field source paths must be unique.' })
  }
})

/**
 * Strict creation-time validation. Persisted v3 documents may contain the
 * migration-only legacy_unattributed sentinel, but newly authored v3 briefs
 * must never use it to disguise unknown provenance.
 */
export const newCreativeBriefV3Schema = creativeBriefV3Schema.superRefine((brief, context) => {
  brief.fieldSources.forEach((source, index) => {
    if (source.source === 'legacy_unattributed') {
      context.addIssue({
        code: 'custom',
        path: ['fieldSources', index, 'source'],
        message: 'New Creative Brief v3 fields cannot use legacy_unattributed.'
      })
    }
  })
})

export const creativeBriefSchema = z.discriminatedUnion('version', [creativeBriefV1Schema, creativeBriefV2Schema, creativeBriefV3Schema])

export const directionProposalSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  briefId: idSchema,
  capabilityPackId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  recommended: z.boolean(),
  composition: z.string().trim().min(1).max(1_000),
  subject: z.string().trim().min(1).max(1_000),
  typography: z.string().trim().min(1).max(1_000),
  palette: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  lighting: z.string().trim().min(1).max(1_000),
  localSketchCost: z.literal('no-cost'),
  difference: z.string().trim().min(1).max(1_000)
})

export const capabilityPackDescriptorSchema = z.object({
  id: z.string().trim().min(1).max(120),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
  purpose: z.string().trim().min(1).max(500),
  theme: currentThemeSchema,
  capabilities: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  rules: z.array(z.string().trim().min(1).max(500)).min(1).max(50)
})

export const creativeDesignContractV1Schema = z.object({
  version: z.literal(1),
  brief: creativeBriefV2Schema,
  directions: z.array(directionProposalSchema).min(1).max(3),
  selectedDirectionId: idSchema,
  capabilityPackIds: z.array(z.string().trim().min(1).max(120)).min(1).max(8)
}).superRefine((value, context) => {
  if (!value.directions.some((direction) => direction.id === value.selectedDirectionId)) {
    context.addIssue({ code: 'custom', path: ['selectedDirectionId'], message: 'Selected direction must exist in the contract.' })
  }
  value.directions.forEach((direction, index) => {
    if (direction.briefId !== value.brief.id) context.addIssue({ code: 'custom', path: ['directions', index, 'briefId'], message: 'Direction must belong to the embedded brief.' })
  })
  if (value.directions.filter((direction) => direction.recommended).length !== 1) {
    context.addIssue({ code: 'custom', path: ['directions'], message: 'Exactly one direction must be recommended.' })
  }
})

export const creativeDesignContractV2Schema = z.object({
  version: z.literal(2),
  brief: creativeBriefV3Schema,
  directions: z.array(directionProposalSchema).min(1).max(3),
  selectedDirectionId: idSchema,
  capabilityPackIds: z.array(z.string().trim().min(1).max(120)).min(1).max(8)
}).superRefine((value, context) => {
  if (!value.directions.some((direction) => direction.id === value.selectedDirectionId)) {
    context.addIssue({ code: 'custom', path: ['selectedDirectionId'], message: 'Selected direction must exist in the contract.' })
  }
  value.directions.forEach((direction, index) => {
    if (direction.briefId !== value.brief.id) context.addIssue({ code: 'custom', path: ['directions', index, 'briefId'], message: 'Direction must belong to the embedded brief.' })
  })
  if (value.directions.filter((direction) => direction.recommended).length !== 1) {
    context.addIssue({ code: 'custom', path: ['directions'], message: 'Exactly one direction must be recommended.' })
  }
})

export const creativeDesignContractSchema = z.discriminatedUnion('version', [creativeDesignContractV1Schema, creativeDesignContractV2Schema])

const plannedBoundsSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1)
}).superRefine((bounds, context) => {
  if (bounds.x + bounds.width > 1.000_001 || bounds.y + bounds.height > 1.000_001) {
    context.addIssue({ code: 'custom', message: 'Planned bounds must remain inside the canvas.' })
  }
})

export const elementControlIntentSchema = z.object({
  kind: z.enum(['layout', 'exact-text', 'subject', 'style', 'lighting', 'reference', 'mask', 'group']),
  priority: z.enum(['must', 'prefer', 'guide']),
  instruction: z.string().trim().min(1).max(1_000),
  strength: z.number().min(0).max(1)
})

export const elementProvenanceSchema = z.object({
  origin: z.enum(['user', 'agent-local', 'imported', 'mock-generated', 'provider-generated']),
  sourceBriefId: idSchema.nullable(),
  sourceDirectionId: idSchema.nullable(),
  sourceAssetId: idSchema.nullable()
})

export const elementPlanSchema = z.object({
  id: idSchema,
  sourceBriefId: idSchema.nullable(),
  type: z.enum(['text', 'shape', 'sketch', 'light', 'placeholder']),
  name: z.string().trim().min(1).max(120),
  semanticDescription: z.string().max(4_000),
  semanticRole: z.string().trim().min(1).max(120),
  layerGroup: z.string().max(120).nullable(),
  locked: z.boolean(),
  normalizedBounds: plannedBoundsSchema,
  rotation: z.number().min(-360).max(360),
  zIntent: z.number().int().nonnegative(),
  relations: z.array(z.object({
    id: idSchema,
    kind: relationKindSchema,
    targetElementId: idSchema,
    description: z.string().max(1_000)
  })).max(100),
  controlIntent: elementControlIntentSchema.optional(),
  provenance: elementProvenanceSchema.optional(),
  visualTreatment: z.record(z.string(), z.unknown()),
  generationPolicy: z.enum(['local', 'underlay', 'independent-later'])
})

export const scenePlanSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  briefId: idSchema,
  directionId: idSchema.optional(),
  capabilityPackIds: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  canvas: z.object({
    aspectWidth: z.number().int().min(1).max(100),
    aspectHeight: z.number().int().min(1).max(100),
    outputWidth: z.number().int().min(64).max(16_384),
    outputHeight: z.number().int().min(64).max(16_384),
    backgroundColor: z.string().min(1).max(64),
    transparent: z.boolean(),
    globalStyle: z.string().max(4_000)
  }),
  elements: z.array(elementPlanSchema).min(1).max(1_000)
}).superRefine((plan, context) => {
  const ids = plan.elements.map((element) => element.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['elements'], message: 'Element plan IDs must be unique.' })
  const zIntents = plan.elements.map((element) => element.zIntent)
  if (new Set(zIntents).size !== zIntents.length) context.addIssue({ code: 'custom', path: ['elements'], message: 'Element plan layer intents must be unique.' })
  const validIds = new Set(ids)
  const graph = new Map<string, string[]>()
  plan.elements.forEach((element, elementIndex) => {
    for (const [relationIndex, relation] of element.relations.entries()) {
      if (relation.targetElementId === element.id || !validIds.has(relation.targetElementId)) {
        context.addIssue({ code: 'custom', path: ['elements', elementIndex, 'relations', relationIndex], message: 'Plan relation endpoints are invalid.' })
      }
      if (['above', 'below', 'in-front-of', 'behind'].includes(relation.kind)) {
        const forward = relation.kind === 'below' || relation.kind === 'behind' ? relation.targetElementId : element.id
        const backward = forward === element.id ? relation.targetElementId : element.id
        graph.set(forward, [...(graph.get(forward) ?? []), backward])
      }
    }
    const targets = element.visualTreatment.targetElementIds
    if (element.type === 'light' && Array.isArray(targets) && targets.some((target) => typeof target !== 'string' || !validIds.has(target))) {
      context.addIssue({ code: 'custom', path: ['elements', elementIndex, 'visualTreatment', 'targetElementIds'], message: 'Light targets must reference planned elements.' })
    }
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((graph.get(id) ?? []).some(visit)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  if (ids.some(visit)) context.addIssue({ code: 'custom', path: ['elements'], message: 'Ordering relations must not contain cycles.' })
})

export const creativeContextSchema = z.object({
  brief: creativeBriefSchema,
  directions: z.array(directionProposalSchema).min(1).max(3).optional(),
  selectedDirectionId: idSchema.optional(),
  plan: scenePlanSchema
}).superRefine((value, context) => {
  if (value.plan.briefId !== value.brief.id) context.addIssue({ code: 'custom', path: ['plan', 'briefId'], message: 'Scene plan must belong to the embedded brief.' })
  if (value.selectedDirectionId !== undefined && !value.directions?.some((direction) => direction.id === value.selectedDirectionId)) {
    context.addIssue({ code: 'custom', path: ['selectedDirectionId'], message: 'Selected direction must exist in the creative context.' })
  }
  if (value.plan.directionId !== undefined && value.plan.directionId !== value.selectedDirectionId) {
    context.addIssue({ code: 'custom', path: ['plan', 'directionId'], message: 'Scene plan direction must match the selected direction.' })
  }
})

export type CreativeBriefV1 = z.infer<typeof creativeBriefV1Schema>
export type CreativeBriefV2 = z.infer<typeof creativeBriefV2Schema>
export type CreativeBriefV3 = z.infer<typeof creativeBriefV3Schema>
export type CreativeBriefFieldSource = z.infer<typeof creativeBriefFieldSourceSchema>
export type CreativeBriefAcceptanceCriterion = z.infer<typeof creativeBriefAcceptanceCriterionSchema>
export type CreativeBrief = z.infer<typeof creativeBriefSchema>
export type DirectionProposal = z.infer<typeof directionProposalSchema>
export type CapabilityPackDescriptor = z.infer<typeof capabilityPackDescriptorSchema>
export type CreativeDesignContractV1 = z.infer<typeof creativeDesignContractV1Schema>
export type CreativeDesignContractV2 = z.infer<typeof creativeDesignContractV2Schema>
export type CreativeDesignContract = z.infer<typeof creativeDesignContractSchema>
export type ElementControlIntent = z.infer<typeof elementControlIntentSchema>
export type ElementProvenance = z.infer<typeof elementProvenanceSchema>
export type ElementPlan = z.infer<typeof elementPlanSchema>
export type ScenePlan = z.infer<typeof scenePlanSchema>
export type CreativeContext = z.infer<typeof creativeContextSchema>
