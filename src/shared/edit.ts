import { z } from 'zod'
import { sceneSchema } from '../domain'
import { generationJobStatusSchema } from './generation'

export const canvasEditInputSchema = z.object({
  scene: sceneSchema,
  /** The image (or placeholder) edited; none for a fill of the selection, which edits the whole picture. */
  targetElementId: z.string().uuid().nullable(),
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().max(4_000).default(''),
  providerId: z.string().min(1),
  model: z.string().min(1),
  count: z.number().int().min(1).max(4).default(1),
  profileId: z.string().trim().min(1).max(120).default('local-sketch'),
  confirmed: z.boolean().default(false),
  sourceMessageId: z.string().min(1).nullable().default(null),
  parentResultId: z.string().min(1).nullable().default(null),
  /**
   * mask: change the parts of an image its edit masks mark. in-context:
   * redraw the box of an image or subject placeholder within the picture
   * beneath it, to be cut out and blended in when placed. selection:
   * Photoshop's Generative Fill, the picture repainted inside the person's
   * selection and placed as a new layer masked by it.
   */
  mode: z.enum(['mask', 'in-context', 'selection']).default('mask'),
  /** For a fill: the selection as a grayscale asset the canvas's size. */
  selectionMaskAssetId: z.string().uuid().nullable().default(null)
}).refine((input) => input.mode === 'selection' ? input.selectionMaskAssetId !== null : input.targetElementId !== null,
  'A fill needs the selection; any other edit needs its target.')

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
