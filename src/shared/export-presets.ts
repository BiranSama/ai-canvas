import { MAX_EXPORT_EDGE } from './artwork-export'

/** A size small shops often post at. Common sizes on each platform, not their official rules. */
export interface SizePreset {
  readonly id: string
  readonly label: string
  readonly ratio: string
  readonly width: number
  readonly height: number
}

export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: 'xiaohongshu', label: '小红书笔记', ratio: '3:4', width: 1080, height: 1440 },
  { id: 'vertical-video', label: '抖音、视频号竖屏', ratio: '9:16', width: 1080, height: 1920 },
  { id: 'square', label: '朋友圈、社群方图', ratio: '1:1', width: 1080, height: 1080 },
  { id: 'product', label: '淘宝、拼多多主图', ratio: '1:1', width: 800, height: 800 },
  { id: 'wechat-cover', label: '公众号封面', ratio: '2.35:1', width: 900, height: 383 },
  { id: 'banner', label: '横幅', ratio: '16:9', width: 1920, height: 1080 }
]

/** The smallest edge a canvas, and so an export, can have. */
export const MIN_EXPORT_EDGE = 64

export function validExportSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= MIN_EXPORT_EDGE && height >= MIN_EXPORT_EDGE && width <= MAX_EXPORT_EDGE && height <= MAX_EXPORT_EDGE
}

/** 1×, 2× or 3× of the canvas, as large as fits when a larger one would pass the edge limit. */
export function scaledSize(width: number, height: number, scale: number): { readonly width: number; readonly height: number; readonly scale: number } {
  const fitted = Math.min(scale, MAX_EXPORT_EDGE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * fitted)), height: Math.max(1, Math.round(height * fitted)), scale: fitted }
}

export const PRINT_WIDTHS = [
  { id: 'a5', label: 'A5', widthMm: 148 },
  { id: 'a4', label: 'A4', widthMm: 210 },
  { id: 'a3', label: 'A3', widthMm: 297 }
] as const

export const PRINT_DPI = 300
/** Below this an image prints visibly soft. */
export const SOFT_PRINT_DPI = 150

export type PdfPageChoice = { readonly kind: 'screen' } | { readonly kind: 'print'; readonly widthMm: number }

export interface PdfLayout {
  /** The page in points, 1/72 inch. */
  readonly pageWidth: number
  readonly pageHeight: number
  readonly widthMm: number
  readonly heightMm: number
  /** The picture in pixels. */
  readonly width: number
  readonly height: number
  /** For print: the resolution it is drawn at, 300 unless the size limit lowered it. */
  readonly dpi: number | null
}

const MM_PER_INCH = 25.4
const POINTS_PER_INCH = 72
/** How screens count: 96 pixels make an inch. */
const SCREEN_PIXELS_PER_INCH = 96

/** The largest PDF page readers accept: 200 inches, 5080 mm, a side. */
export const MAX_PDF_PAGE_POINTS = 14_400

export function pdfPageFits(layout: PdfLayout): boolean {
  return layout.pageWidth <= MAX_PDF_PAGE_POINTS && layout.pageHeight <= MAX_PDF_PAGE_POINTS
}

/** Why a page is too large, with the largest width this picture can have. */
export function pdfTooLarge(layout: PdfLayout): string {
  const widest = Math.floor(5080 * Math.min(1, layout.widthMm / layout.heightMm))
  return `页面 ${Math.round(layout.widthMm)} × ${Math.round(layout.heightMm)} mm 太大了：PDF 每边最多 5080 mm（200 英寸）。这张作品打印时宽度最多 ${widest} mm。`
}

export function pdfLayout(canvas: { readonly outputWidth: number; readonly outputHeight: number }, choice: PdfPageChoice): PdfLayout {
  const ratio = canvas.outputHeight / canvas.outputWidth
  if (choice.kind === 'screen') {
    const widthIn = canvas.outputWidth / SCREEN_PIXELS_PER_INCH
    const heightIn = canvas.outputHeight / SCREEN_PIXELS_PER_INCH
    return {
      pageWidth: widthIn * POINTS_PER_INCH,
      pageHeight: heightIn * POINTS_PER_INCH,
      widthMm: widthIn * MM_PER_INCH,
      heightMm: heightIn * MM_PER_INCH,
      width: canvas.outputWidth,
      height: canvas.outputHeight,
      dpi: null
    }
  }
  const widthIn = choice.widthMm / MM_PER_INCH
  const heightIn = widthIn * ratio
  let width = Math.round(widthIn * PRINT_DPI)
  let height = Math.round(heightIn * PRINT_DPI)
  const longest = Math.max(width, height)
  if (longest > MAX_EXPORT_EDGE) {
    width = Math.max(1, Math.floor(width * MAX_EXPORT_EDGE / longest))
    height = Math.max(1, Math.floor(height * MAX_EXPORT_EDGE / longest))
  }
  return {
    pageWidth: widthIn * POINTS_PER_INCH,
    pageHeight: heightIn * POINTS_PER_INCH,
    widthMm: choice.widthMm,
    heightMm: heightIn * MM_PER_INCH,
    width,
    height,
    dpi: Math.round(width / widthIn)
  }
}

/**
 * How many of an image's own pixels land on each inch of paper, by how it
 * fills its box: filling crops it, fitting leaves room, stretching uses
 * the scarcer direction.
 */
export function printedResolution(
  source: { readonly width: number; readonly height: number },
  element: { readonly fit: 'cover' | 'contain' | 'fill'; readonly crop: { readonly width: number; readonly height: number }; readonly transform: { readonly width: number; readonly height: number } },
  page: { readonly widthMm: number; readonly heightMm: number }
): number {
  const sourceWidth = Math.max(1, source.width * element.crop.width)
  const sourceHeight = Math.max(1, source.height * element.crop.height)
  const boxWidthIn = element.transform.width * page.widthMm / MM_PER_INCH
  const boxHeightIn = element.transform.height * page.heightMm / MM_PER_INCH
  const across = sourceWidth / boxWidthIn
  const down = sourceHeight / boxHeightIn
  // Fitting inside the box scales by the roomier direction; filling it (by cropping or stretching), by the scarcer one.
  return element.fit === 'contain' ? Math.max(across, down) : Math.min(across, down)
}
