import { z } from 'zod'
import { blendModeSchema, elementControlIntentSchema, elementProvenanceSchema, sceneRelationSchema, sceneSchema } from '../domain'
import { generationJobStatusSchema, referenceModeSchema } from './generation'

export const renderModeSchema = z.enum(['editing', 'reference', 'final'])

export const promptIrElementSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  semanticRole: z.string().min(1),
  controlIntent: elementControlIntentSchema.optional(),
  provenance: elementProvenanceSchema.optional(),
  referencePolicy: z.enum(['include', 'reference-only', 'exclude']),
  presentation: z.enum(['visual', 'semantic-guide', 'omitted']),
  zIndex: z.number().int().nonnegative(),
  opacity: z.number().min(0).max(1),
  blendMode: blendModeSchema.default('normal'),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.number()
  }),
  attributes: z.record(z.string(), z.unknown())
})

export const promptIrOcclusionSchema = z.object({
  frontElementId: z.string().uuid(),
  behindElementId: z.string().uuid(),
  overlapRatio: z.number().min(0).max(1),
  instruction: z.string().min(1)
})

export const promptIrSchema = z.object({
  version: z.literal(1),
  sceneId: z.string().uuid(),
  sceneRevision: z.number().int().nonnegative(),
  originalRequirement: z.string().max(8_000),
  canvas: z.object({
    aspectWidth: z.number().int().positive(),
    aspectHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(),
    outputHeight: z.number().int().positive(),
    backgroundColor: z.string(),
    transparent: z.boolean(),
    globalStyle: z.string()
  }),
  elements: z.array(promptIrElementSchema).max(10_000),
  relations: z.array(sceneRelationSchema).max(20_000),
  occlusions: z.array(promptIrOcclusionSchema).max(20_000),
  protectedElementIds: z.array(z.string().uuid()).max(10_000),
  prohibitions: z.array(z.string().min(1)).max(10_000),
  compiledAt: z.string().datetime({ offset: true })
})

export const providerCompiledPromptSchema = z.object({
  providerId: z.string().min(1),
  prompt: z.string().min(1).max(8_000),
  negativePrompt: z.string().max(4_000),
  referenceStrategy: z.enum(['composite', 'text-only']),
  referenceMode: referenceModeSchema.default('hybrid'),
  warnings: z.array(z.string()).max(100)
})

export const promptPackageSchema = z.object({
  version: z.literal(1),
  targetOutput: z.object({ aspectWidth: z.number().int().positive(), aspectHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(), outputHeight: z.number().int().positive() }).optional(),
  id: z.string().uuid(),
  referenceMode: referenceModeSchema.default('hybrid'),
  sceneIntent: z.object({
    purpose: z.string().min(1).max(500),
    medium: z.array(z.string().min(1).max(120)).min(1).max(20),
    usage: z.string().max(240).nullable(),
    originalRequirement: z.string().max(8_000)
  }),
  compositionContract: z.array(z.string().min(1).max(1_000)).max(20_000),
  elementBriefs: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string(),
    semanticRole: z.string().min(1),
    controlIntent: elementControlIntentSchema.optional(),
    provenance: elementProvenanceSchema.optional(),
    layer: z.number().int().nonnegative(),
    blendMode: blendModeSchema.default('normal'),
    visibility: z.enum(['visual', 'semantic-guide', 'omitted']),
    bounds: promptIrElementSchema.shape.bounds,
    relations: z.array(z.string().min(1).max(1_000)).max(200),
    occludedBy: z.array(z.string().uuid()).max(1_000),
    protected: z.boolean()
  })).max(10_000),
  styleBible: z.array(z.string().min(1).max(1_000)).max(100),
  textContract: z.array(z.object({
    elementId: z.string().uuid(),
    content: z.string().max(4_000),
    style: z.string().max(4_000),
    accuracy: z.enum(['strict', 'balanced', 'expressive']),
    mode: z.enum(['exact-overlay', 'reference', 'image-text']),
    visualWeight: z.enum(['whisper', 'secondary', 'primary', 'hero']).default('secondary')
  })).max(1_000),
  negativeConstraints: z.array(z.string().min(1).max(1_000)).max(10_000),
  referenceManifest: z.array(z.object({
    assetId: z.string().uuid(),
    role: z.enum(['appearance-composite', 'semantic-sheet', 'source-image', 'sketch-underlay', 'mask']),
    weight: z.number().min(0).max(1),
    sourceElementId: z.string().uuid().nullable()
  })).max(100),
  renderTier: z.enum(['local-sketch', 'mock-draft', 'mock-final', 'draft', 'final']),
  generationProfile: z.object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    imageReferences: z.boolean(),
    multipleReferences: z.boolean(),
    maskEditing: z.boolean()
  }),
  provenance: z.object({
    sceneId: z.string().uuid(),
    sceneRevision: z.number().int().nonnegative(),
    briefId: z.string().uuid(),
    directionId: z.string().uuid().nullable().optional(),
    planId: z.string().uuid(),
    compiledAt: z.string().datetime({ offset: true })
  })
})

export const canvasGenerationInputSchema = z.object({
  scene: sceneSchema,
  originalRequirement: z.string().trim().min(1).max(8_000),
  providerId: z.string().min(1),
  model: z.string().min(1),
  count: z.number().int().min(1).max(4).default(1),
  profileId: z.string().trim().min(1).max(120).default('local-sketch'),
  confirmed: z.boolean().default(false),
  sourceMessageId: z.string().min(1).nullable().default(null),
  referenceMode: referenceModeSchema.default('hybrid')
})

export const canvasGenerationResultSchema = z.object({
  jobId: z.string().min(1),
  jobStatus: generationJobStatusSchema,
  referenceAssetId: z.string().uuid(),
  semanticSheetAssetId: z.string().uuid(),
  promptIr: promptIrSchema,
  promptPackage: promptPackageSchema,
  sentPrompt: z.string().min(1),
  sentNegativePrompt: z.string(),
  warnings: z.array(z.string())
})

export type RenderMode = z.infer<typeof renderModeSchema>
export type PromptIrElement = z.infer<typeof promptIrElementSchema>
export type PromptIrOcclusion = z.infer<typeof promptIrOcclusionSchema>
export type PromptIr = z.infer<typeof promptIrSchema>
export type ProviderCompiledPrompt = z.infer<typeof providerCompiledPromptSchema>
export type PromptPackage = z.infer<typeof promptPackageSchema>
export type CanvasGenerationInput = z.input<typeof canvasGenerationInputSchema>
export type CanvasGenerationResult = z.infer<typeof canvasGenerationResultSchema>
