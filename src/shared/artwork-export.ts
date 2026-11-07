import { z } from 'zod'
import { adjustmentSettingsSchema, blendModeSchema, layerStyleSchema } from '../domain'

/*
 * What the export panel hands Main to write. The page draws the pixels
 * (with the canvas's own drawing); Main asks where to save, encodes and
 * writes. A page can only write where the person chose: each choice is a
 * one-time target Main keeps.
 */

export const EXPORT_FILE_KINDS = ['png', 'jpeg', 'webp', 'psd', 'pdf'] as const
export type ExportFileKind = (typeof EXPORT_FILE_KINDS)[number]
export type ExportImageFormat = 'png' | 'jpeg' | 'webp'

export const EXPORT_EXTENSIONS: Readonly<Record<ExportFileKind, string>> = { png: 'png', jpeg: 'jpg', webp: 'webp', psd: 'psd', pdf: 'pdf' }

/** The largest edge the canvas can have, and so the largest export. */
export const MAX_EXPORT_EDGE = 16_384
/** What one export may hand Main in pixels, across all its layers. */
export const MAX_EXPORT_BYTES = 1_800_000_000

const dimension = z.number().int().min(1).max(MAX_EXPORT_EDGE)
const target = z.string().uuid()
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const fileStem = z.string().trim().min(1).max(160)

export const exportFileChoiceSchema = z.object({ suggestedName: fileStem, kind: z.enum(EXPORT_FILE_KINDS) }).strict()
export type ExportFileChoice = z.infer<typeof exportFileChoiceSchema>
export const exportFolderChoiceSchema = z.object({ suggestedName: fileStem }).strict()

export type ExportTargetChoice =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly target: string; readonly path: string }

/** The bytes of an RGBA picture, row by row. */
const rgbaSchema = z.instanceof(Uint8Array)

function checkPixels(value: { readonly width: number; readonly height: number; readonly pixels: Uint8Array }, channels: number, context: z.RefinementCtx, path: string[] = ['pixels']): void {
  if (value.pixels.byteLength !== value.width * value.height * channels) context.addIssue({ code: 'custom', path, message: 'Pixel data does not match the size.' })
}

export const exportImageWriteSchema = z.object({
  target,
  /** For a folder target: the file's name inside it. */
  fileName: fileStem.optional(),
  format: z.enum(['png', 'jpeg', 'webp']),
  width: dimension,
  height: dimension,
  pixels: rgbaSchema
}).strict().superRefine((value, context) => checkPixels(value, 4, context))
export type ExportImageWrite = z.infer<typeof exportImageWriteSchema>

export const exportPdfWriteSchema = z.object({
  target,
  title: z.string().max(200),
  /** The page in PostScript points (1/72 inch). */
  pageWidth: z.number().positive().max(14_400),
  pageHeight: z.number().positive().max(14_400),
  width: dimension,
  height: dimension,
  /** Keep transparency (lossless) instead of a high-quality JPEG. */
  transparent: z.boolean(),
  pixels: rgbaSchema
}).strict().superRefine((value, context) => checkPixels(value, 4, context))
export type ExportPdfWrite = z.infer<typeof exportPdfWriteSchema>

const finite = z.number().finite()

export const psdTextSchema = z.object({
  content: z.string().max(4000),
  orientation: z.enum(['horizontal', 'vertical']),
  fontFamily: z.string().min(1).max(240),
  fontWeight: z.number().int().min(100).max(900),
  /** In document pixels, which a PSD at 72 ppi reads as points. */
  fontSize: finite.positive().max(4096),
  color: hexColor,
  /** How opaque the letters are, from the fill colour's own transparency. */
  fillOpacity: finite.min(0).max(1),
  letterSpacing: finite,
  lineHeight: finite.positive().max(10),
  align: z.enum(['start', 'center', 'end', 'justify']),
  /** The text box before rotation, in document pixels; rotation turns it about its top-left corner. */
  box: z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }).strict(),
  rotation: finite,
  /** A flip or skew from free transform, in the box's pixels before it is turned: [a, b, c, d, e, f] as a canvas transform. */
  shear: z.tuple([finite, finite, finite, finite, finite, finite]).optional(),
  /** How tall the laid-out lines are; the canvas centres them in the box. */
  textHeight: finite.nonnegative(),
  stroke: z.object({ color: hexColor, width: finite.positive(), opacity: finite.min(0).max(1) }).strict().nullable(),
  shadow: z.object({ color: hexColor, blur: finite.nonnegative(), opacity: finite.min(0).max(1) }).strict().nullable()
}).strict()
export type PsdText = z.infer<typeof psdTextSchema>

const psdMaskSchema = z.object({
  left: z.number().int(),
  top: z.number().int(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  /** Gray, one byte a pixel: white shows the layer, black hides it. */
  pixels: z.instanceof(Uint8Array),
  disabled: z.boolean()
}).strict().superRefine((value, context) => checkPixels(value, 1, context))

const psdLayerSchema = z.object({
  kind: z.literal('layer'),
  name: z.string().min(1).max(255),
  hidden: z.boolean(),
  opacity: finite.min(0).max(1),
  blendMode: blendModeSchema,
  left: z.number().int(),
  top: z.number().int(),
  /** 0 × 0 for a layer with nothing drawn. */
  width: z.number().int().nonnegative().max(MAX_EXPORT_EDGE),
  height: z.number().int().nonnegative().max(MAX_EXPORT_EDGE),
  pixels: rgbaSchema,
  mask: psdMaskSchema.nullable(),
  text: psdTextSchema.nullable(),
  /** Clipped to the layer below it, its clipping mask's base. */
  clipping: z.boolean().optional(),
  /** Its layer styles, written as Photoshop's layer effects rather than drawn into its pixels. */
  style: layerStyleSchema.optional()
}).strict().superRefine((value, context) => checkPixels(value, 4, context))
export type PsdLayer = z.infer<typeof psdLayerSchema>

/** Photoshop's adjustment layer: no pixels, only its settings and its mask over the document. */
const psdAdjustmentSchema = z.object({
  kind: z.literal('adjustment'),
  name: z.string().min(1).max(255),
  hidden: z.boolean(),
  opacity: finite.min(0).max(1),
  blendMode: blendModeSchema,
  /** Clipped to the layer below it, so it changes that layer alone. */
  clipping: z.boolean(),
  settings: adjustmentSettingsSchema,
  mask: psdMaskSchema.nullable()
}).strict()
export type PsdAdjustment = z.infer<typeof psdAdjustmentSchema>

export interface PsdGroup {
  readonly kind: 'group'
  readonly name: string
  readonly hidden: boolean
  readonly opacity: number
  /** Bottom first, as a PSD lists them. */
  readonly children: readonly PsdNode[]
}
export type PsdNode = PsdLayer | PsdGroup | PsdAdjustment

const psdGroupSchema: z.ZodType<PsdGroup> = z.lazy(() => z.object({
  kind: z.literal('group'),
  name: z.string().min(1).max(255),
  hidden: z.boolean(),
  opacity: finite.min(0).max(1),
  children: z.array(z.union([psdLayerSchema, psdGroupSchema, psdAdjustmentSchema])).max(10_000)
}).strict())

export const psdDocumentSchema = z.object({
  width: dimension,
  height: dimension,
  /** Bottom first. */
  children: z.array(z.union([psdLayerSchema, psdGroupSchema, psdAdjustmentSchema])).max(10_000),
  /** The flattened picture, for viewers that do not read layers. */
  composite: rgbaSchema
}).strict().superRefine((value, context) => checkPixels({ width: value.width, height: value.height, pixels: value.composite }, 4, context, ['composite']))
export type PsdDocument = z.infer<typeof psdDocumentSchema>

export const exportPsdWriteSchema = z.object({ target, document: psdDocumentSchema }).strict()
export type ExportPsdWrite = z.infer<typeof exportPsdWriteSchema>

export interface ExportWriteResult {
  readonly path: string
}

export const exportRevealSchema = z.object({ path: z.string().min(1).max(4096) }).strict()

/** A file name with nothing Windows or macOS refuses, at most 96 characters; empty becomes 未命名作品. */
export function safeFileStem(name: string): string {
  const safe = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 96)
  return safe || '未命名作品'
}

export function exportFileName(projectName: string, kind: ExportFileKind): string {
  return `${safeFileStem(projectName)}.${EXPORT_EXTENSIONS[kind]}`
}
