import { z } from 'zod'
import { sceneSchema } from '../domain'
import { generationJobStatusSchema } from './generation'

export const canvasEditInputSchema = z.object({
  scene: sceneSchema,
  targetElementId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().max(4_000).default(''),
  providerId: z.string().min(1),
  model: z.string().min(1),
  count: z.number().int().min(1).max(4).default(1),
  profileId: z.string().trim().min(1).max(120).default('local-sketch'),
  confirmed: z.boolean().default(false),
  sourceMessageId: z.string().min(1).nullable().default(null),
  parentResultId: z.string().min(1).nullable().default(null)
})

export const canvasEditResultSchema = z.object({
  jobId: z.string().min(1),
  jobStatus: generationJobStatusSchema,
  sourceAssetId: z.string().uuid(),
  maskAssetId: z.string().uuid(),
  maskWidth: z.number().int().positive(),
  maskHeight: z.number().int().positive()
})

export type CanvasEditInput = z.input<typeof canvasEditInputSchema>
export type CanvasEditResult = z.infer<typeof canvasEditResultSchema>
