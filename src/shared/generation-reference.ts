import { z } from 'zod'

export const generationReferenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }).strict(),
  z.object({ kind: z.literal('canvas'), sceneRevision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('result'), resultId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('images'), assetIds: z.array(z.string().uuid()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('unresolved') }).strict()
])
export type GenerationReferenceSource = z.infer<typeof generationReferenceSourceSchema>

export const generationReferencePreviewInputSchema = z.object({
  projectId: z.string().uuid(),
  source: generationReferenceSourceSchema,
  profileId: z.string().min(1).max(120),
  modelOverride: z.string().min(1).max(200).nullable().default(null),
  referenceMode: z.enum(['visual', 'structure', 'hybrid'])
}).strict()
export type GenerationReferencePreviewInput = z.infer<typeof generationReferencePreviewInputSchema>
export interface GenerationReferencePreview {
  readonly source: GenerationReferenceSource
  readonly signature: string
  readonly summary: string
  readonly supportedModes: readonly ('visual' | 'structure' | 'hybrid')[]
  readonly thumbnails: readonly string[]
  readonly assetIds: readonly string[]
}
