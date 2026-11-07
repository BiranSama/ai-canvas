import Konva from 'konva'
import { adaptedScene, clipBases, hiddenByGroups, LAYER_STYLE_KINDS, type Scene, type SceneElement } from '../../../domain'
import { hasVisibleEffects } from '../../../shared/layer-effects'
import { MAX_EXPORT_EDGE, type ExportImageFormat, type PsdAdjustment, type PsdLayer, type PsdNode, type PsdText } from '../../../shared/artwork-export'
import { activeAdjustments, ADJUSTMENT_LABELS, isFilterSettings } from '../../../shared/adjustments'
import { resolveBlendMode } from '../../../shared/blend-mode'
import { MAX_WEBP_EDGE, pdfLayout, pdfPageFits, pdfTooLarge, printedResolution, scaledSize, SOFT_PRINT_DPI, type PdfPageChoice, type SizePreset } from '../../../shared/export-presets'
import { ArtworkSession, canvasPixels } from '../canvas/artwork-render'
import { TEXT_SHADOW_OPACITY, textMetrics, textWrap } from '../canvas/layer-drawing'
import { countLayers, layerArea, psdPlan, type LayerPlan } from './psd-plan'
import { getRuntimeAssetUrl } from '../assets/runtime-assets'

/*
 * Each kind of export, from asking where to save to the written file. The
 * picture is drawn here with the canvas's own drawing, Main encodes and
 * writes it. Every export can be cancelled between steps, and reports how
 * far it has got.
 */

export interface ExportProgress {
  readonly label: string
  readonly done: number
  readonly total: number
}

export type ProgressListener = (progress: ExportProgress) => void

export interface ExportOutcome {
  readonly paths: readonly string[]
  /** What the export had to simplify, to say beside the result. */
  readonly notes: readonly string[]
}

function bytes(image: ImageData): Uint8Array<ArrayBuffer> {
  return new Uint8Array(image.data.buffer as ArrayBuffer, image.data.byteOffset, image.data.byteLength)
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('导出已取消。', 'AbortError')
}

/** Lets the panel show progress between steps that keep the page busy. */
function breathe(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

export interface ImageExportOptions {
  readonly format: ExportImageFormat
  readonly scale: number
  /** JPEG has no transparency: what shows through. */
  readonly jpegBackground: string
}

export async function exportImage(scene: Scene, projectName: string, options: ImageExportOptions, signal: AbortSignal, progress: ProgressListener): Promise<ExportOutcome | null> {
  const choice = await window.desktop.chooseExportFile({ suggestedName: projectName, kind: options.format })
  if (choice.cancelled) return null
  progress({ label: '正在画图', done: 0, total: 2 })
  const session = await ArtworkSession.prepare(scene, signal)
  try {
    checkAborted(signal)
    const size = scaledSize(scene.canvas.outputWidth, scene.canvas.outputHeight, options.scale, options.format === 'webp' ? MAX_WEBP_EDGE : MAX_EXPORT_EDGE)
    const canvas = session.render({ width: size.width, height: size.height, background: options.format === 'jpeg' && scene.canvas.transparent ? { color: options.jpegBackground } : 'canvas' })
    progress({ label: '正在保存', done: 1, total: 2 })
    // The last chance to stop: once Main is writing, the file is saved.
    checkAborted(signal)
    const result = await window.desktop.writeExportImage({ target: choice.target, format: options.format, width: size.width, height: size.height, pixels: bytes(canvasPixels(canvas)) })
    progress({ label: '已保存', done: 2, total: 2 })
    return { paths: [result.path], notes: size.scale < options.scale ? [`超过每边 ${options.format === 'webp' ? MAX_WEBP_EDGE : MAX_EXPORT_EDGE} 像素的上限，按 ${size.width}×${size.height} 导出。`] : [] }
  } finally {
    session.dispose()
  }
}

export async function exportPdf(scene: Scene, projectName: string, page: PdfPageChoice, signal: AbortSignal, progress: ProgressListener): Promise<ExportOutcome | null> {
  const layout = pdfLayout(scene.canvas, page)
  if (!pdfPageFits(layout)) throw new Error(pdfTooLarge(layout))
  const choice = await window.desktop.chooseExportFile({ suggestedName: projectName, kind: 'pdf' })
  if (choice.cancelled) return null
  progress({ label: '正在画图', done: 0, total: 2 })
  const session = await ArtworkSession.prepare(scene, signal)
  try {
    checkAborted(signal)
    const canvas = session.render({ width: layout.width, height: layout.height, background: 'canvas' })
    progress({ label: '正在保存', done: 1, total: 2 })
    checkAborted(signal)
    const result = await window.desktop.writeExportPdf({
      target: choice.target,
      title: projectName,
      pageWidth: layout.pageWidth,
      pageHeight: layout.pageHeight,
      width: layout.width,
      height: layout.height,
      transparent: scene.canvas.transparent,
      pixels: bytes(canvasPixels(canvas))
    })
    progress({ label: '已保存', done: 2, total: 2 })
    return { paths: [result.path], notes: layout.dpi !== null && layout.dpi < 300 ? [`这么大的页面按 ${layout.dpi} DPI 渲染（每边最多 16384 像素）。`] : [] }
  } finally {
    session.dispose()
  }
}

export interface SoftImage {
  readonly name: string
  readonly dpi: number
}

/** The images that would print soft at this page size, lowest resolution first. */
export async function softPrintImages(scene: Scene, page: PdfPageChoice): Promise<readonly SoftImage[]> {
  if (page.kind !== 'print') return []
  const layout = pdfLayout(scene.canvas, page)
  const hidden = hiddenByGroups(scene.elements)
  const soft: SoftImage[] = []
  for (const element of scene.elements) {
    if (element.type !== 'image' || !element.visible || hidden.has(element.id)) continue
    const url = getRuntimeAssetUrl(element.assetId)
    if (url === null) continue
    const image = new window.Image()
    image.src = url
    try {
      await image.decode()
    } catch {
      continue
    }
    const dpi = printedResolution({ width: image.naturalWidth, height: image.naturalHeight }, element, layout)
    if (dpi < SOFT_PRINT_DPI) soft.push({ name: element.name, dpi: Math.round(dpi) })
  }
  return soft.sort((left, right) => left.dpi - right.dpi)
}

export async function exportSizes(scene: Scene, projectName: string, sizes: readonly SizePreset[], format: 'png' | 'jpeg', signal: AbortSignal, progress: ProgressListener): Promise<ExportOutcome | null> {
  const choice = await window.desktop.chooseExportFolder(projectName)
  if (choice.cancelled) return null
  const paths: string[] = []
  for (const [index, size] of sizes.entries()) {
    checkAborted(signal)
    progress({ label: `正在导出${size.label} ${size.width}×${size.height}`, done: index, total: sizes.length })
    await breathe()
    const adapted = adaptedScene(scene, size)
    const session = await ArtworkSession.prepare(adapted, signal)
    try {
      const canvas = session.render({ width: size.width, height: size.height, background: format === 'jpeg' && scene.canvas.transparent ? { color: '#FFFFFF' } : 'canvas' })
      checkAborted(signal)
      const result = await window.desktop.writeExportImage({
        target: choice.target,
        fileName: `${projectName}-${size.label}-${size.width}x${size.height}`,
        format,
        width: size.width,
        height: size.height,
        pixels: bytes(canvasPixels(canvas))
      })
      paths.push(result.path)
    } finally {
      session.dispose()
    }
  }
  progress({ label: '已保存', done: sizes.length, total: sizes.length })
  return { paths, notes: [] }
}

/** A small picture of the artwork laid out at this size, for the panel. */
export async function sizePreview(scene: Scene, size: { readonly width: number; readonly height: number }, longEdge: number, signal: AbortSignal): Promise<string> {
  const adapted = adaptedScene(scene, size)
  const fitted = Math.min(1, longEdge / Math.max(size.width, size.height))
  const session = await ArtworkSession.prepare(adapted, signal)
  try {
    const canvas = session.render({ width: Math.max(1, Math.round(size.width * fitted)), height: Math.max(1, Math.round(size.height * fitted)), background: 'canvas' })
    return canvas.toDataURL('image/png')
  } finally {
    session.dispose()
  }
}

// PSD

export interface PsdExportOptions {
  /** Text stays editable in Photoshop; otherwise it is pixels like the rest. */
  readonly editableText: boolean
}

interface Bounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Where a drawn layer has anything, or null when it is empty. */
export function opaqueBounds(image: ImageData): Bounds | null {
  const { width, height, data } = image
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

/** The pixels inside the bounds, RGBA. */
function crop(image: ImageData, bounds: Bounds): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bounds.width * bounds.height * 4)
  for (let y = 0; y < bounds.height; y += 1) {
    const from = ((bounds.top + y) * image.width + bounds.left) * 4
    out.set(image.data.subarray(from, from + bounds.width * 4), y * bounds.width * 4)
  }
  return out
}

/** A drawn picture's transparency, one byte a pixel. */
function alphaOf(image: ImageData): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(image.width * image.height)
  for (let index = 0; index < out.length; index += 1) out[index] = image.data[index * 4 + 3]!
  return out
}

/** How many lines the canvas sets the text in, and so how tall they stand. */
function textHeight(element: Extract<SceneElement, { type: 'text' }>, width: number, height: number): number {
  const metrics = textMetrics(element, width, height, 1)
  const measured = new Konva.Text({
    text: element.orientation === 'vertical' ? [...element.content].join('\n') : element.content,
    width,
    height,
    fontFamily: element.fontFamily,
    fontSize: metrics.fontSize,
    fontStyle: String(element.fontWeight),
    letterSpacing: metrics.letterSpacing,
    lineHeight: element.lineHeight,
    wrap: textWrap(element),
    ellipsis: element.orientation !== 'vertical'
  })
  const lines = measured.textArr.length
  measured.destroy()
  return lines * metrics.fontSize * element.lineHeight
}

/**
 * A CSS colour as the canvas reads it (#fff, white, rgb(), #RRGGBBAA…):
 * its opaque colour and how opaque it is. The browser parses it, so it
 * matches what the canvas draws; one it cannot read draws black there too.
 */
export function cssColor(color: string): { readonly hex: string; readonly alpha: number } {
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return { hex: '#000000', alpha: 1 }
  context.fillStyle = '#000000'
  context.fillStyle = color
  const parsed = String(context.fillStyle)
  if (parsed.startsWith('#')) return { hex: parsed.slice(0, 7).toUpperCase(), alpha: 1 }
  const parts = /rgba?\(([^)]+)\)/.exec(parsed)?.[1]?.split(',').map((part) => Number(part.trim())) ?? []
  const [r = 0, g = 0, b = 0, a = 1] = parts
  const hex = `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  return { hex, alpha: Math.min(1, Math.max(0, a)) }
}

function psdText(element: Extract<SceneElement, { type: 'text' }>, scene: Scene): PsdText {
  const box = { x: element.transform.x * scene.canvas.outputWidth, y: element.transform.y * scene.canvas.outputHeight, width: element.transform.width * scene.canvas.outputWidth, height: element.transform.height * scene.canvas.outputHeight }
  const metrics = textMetrics(element, box.width, box.height, 1)
  const fill = cssColor(element.fill)
  const stroke = element.stroke === null ? null : cssColor(element.stroke)
  const shadow = element.shadowColor === null ? null : cssColor(element.shadowColor)
  return {
    content: element.content,
    orientation: element.orientation,
    fontFamily: element.fontFamily,
    fontWeight: element.fontWeight,
    fontSize: metrics.fontSize,
    color: fill.hex,
    fillOpacity: fill.alpha,
    letterSpacing: metrics.letterSpacing,
    lineHeight: element.lineHeight,
    align: element.align,
    box,
    rotation: element.transform.rotation,
    textHeight: textHeight(element, box.width, box.height),
    stroke: stroke === null || stroke.alpha === 0 || metrics.strokeWidth <= 0 ? null : { color: stroke.hex, width: metrics.strokeWidth, opacity: stroke.alpha },
    shadow: shadow === null || shadow.alpha === 0 || metrics.shadowBlur <= 0 ? null : { color: shadow.hex, blur: metrics.shadowBlur, opacity: TEXT_SHADOW_OPACITY * shadow.alpha }
  }
}

export async function exportPsd(scene: Scene, projectName: string, options: PsdExportOptions, signal: AbortSignal, progress: ProgressListener): Promise<ExportOutcome | null> {
  const choice = await window.desktop.chooseExportFile({ suggestedName: projectName, kind: 'psd' })
  if (choice.cancelled) return null
  const { outputWidth: width, outputHeight: height } = scene.canvas
  const plan = psdPlan(scene)
  const total = countLayers(plan.layers) + 2
  let done = 0
  const notes: string[] = plan.flattened.map((name) => `「${name}」里的图层和组外的图层上下交错，为了不改变画面，PSD 里按原来的顺序平铺，没有建组。`)
  progress({ label: '正在读取图层', done, total })
  const session = await ArtworkSession.prepare(scene, signal, { includeHidden: true })
  // Photoshop's clipping masks are ours: a layer clipped to a base stays clipped to it.
  const clipped = clipBases(scene.elements)
  try {
    const adjustmentOf = (element: Extract<SceneElement, { type: 'adjustment' }>, hidden: boolean): PsdAdjustment => {
      const mask = element.mask ?? null
      const coverage = mask === null ? null : session.adjustmentMaskAt(element.id, width, height)
      done += 1
      return {
        kind: 'adjustment', name: element.name, hidden, opacity: element.opacity, blendMode: resolveBlendMode(element), clipping: clipped.has(element.id), settings: element.settings,
        mask: mask === null || coverage === null ? null : { left: 0, top: 0, width, height, pixels: coverage, disabled: !mask.enabled }
      }
    }
    const nodesFor = async (element: SceneElement, hidden: boolean): Promise<PsdNode[]> => {
      if (element.type === 'adjustment') return [adjustmentOf(element, hidden)]
      // An image's own adjustments become adjustment layers clipped to it, which Photoshop applies to that layer alone.
      // With a shadow drawn into its pixels, or one made in a selection, they are drawn into its pixels instead.
      // Filters live only on smart objects in Photoshop, so a layer with one has it all drawn into its pixels.
      const own = element.type === 'image' ? element.adjustments ?? [] : []
      const filtered = own.some((adjustment) => isFilterSettings(adjustment.settings))
      // A layer clipped to another cannot have adjustments clipped to it alone: in Photoshop they would change its whole clipping mask.
      const inStack = clipped.has(element.id)
      // A styled layer's own adjustments go on before its styles; clipped adjustment layers would go on after them.
      const styled = element.type === 'image' && element.style !== undefined && LAYER_STYLE_KINDS.some((kind) => element.style![kind] !== undefined)
      const asLayers = own.length > 0 && element.type === 'image' && !filtered && !inStack && !styled && !(element.effects?.shadow !== null && element.effects?.shadow !== undefined && element.effects.shadow.opacity > 0)
        && own.every((adjustment) => adjustment.clip === undefined)
      if (own.length > 0 && !asLayers && activeAdjustments(own).length > 0) {
        notes.push(filtered
          ? `「${element.name}」的滤镜${own.some((adjustment) => !isFilterSettings(adjustment.settings)) ? '和调整' : ''}并进了像素：Photoshop 只在智能对象上放滤镜。`
          : inStack ? `「${element.name}」剪贴在下面的图层上，它自己的调整并进了像素。`
            : styled ? `「${element.name}」带图层样式，它自己的调整并进了像素，样式仍是 PS 的图层效果。`
              : `「${element.name}」的调整${own.some((adjustment) => adjustment.clip !== undefined) ? '只作用在选区里' : '和投影在一起'}，并进了像素。`)
      }
      const layer = await layerOf(element, hidden, !asLayers)
      if (!asLayers) return [layer]
      return [layer, ...own.flatMap((adjustment): PsdAdjustment[] => isFilterSettings(adjustment.settings) ? [] : [{
        kind: 'adjustment', name: ADJUSTMENT_LABELS[adjustment.settings.kind], hidden: !adjustment.enabled, opacity: 1, blendMode: 'normal', clipping: true, settings: adjustment.settings, mask: null
      }])]
    }
    const layerOf = async (element: SceneElement, hidden: boolean, adjusted: boolean): Promise<PsdLayer> => {
      checkAborted(signal)
      progress({ label: `正在导出「${element.name}」`, done, total })
      await breathe()
      const text = element.type === 'text' && options.editableText ? psdText(element, scene) : null
      const mask = element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.mask ?? null : null
      // An image whose effects follow its outline (feather, shadow) cannot have its mask apart from it: the mask goes into its pixels.
      const bakeMask = mask !== null && mask.enabled && element.type === 'image' && hasVisibleEffects(element.effects)
      // Drawn over the layer's own area, past the canvas edge too, so nothing outside the canvas is lost.
      const area = layerArea(element, width, height)
      // Its layer styles go to Photoshop as layer effects, so the pixels hold the layer alone.
      const style = element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.style : undefined
      const plainCanvas = session.render({ width, height, area, background: 'none', layer: { id: element.id, mask: mask === null || bakeMask ? 'scene' : 'off', textEffects: text === null, adjustments: adjusted, styles: false } })
      const plain = canvasPixels(plainCanvas)
      const bounds = opaqueBounds(plain)
      let psdMask: PsdLayer['mask'] = null
      if (mask !== null && !bakeMask && bounds !== null) {
        // The mask itself over the layer's whole area, not read back from what is drawn now:
        // text typed in Photoshop where the mask hides stays hidden.
        const alone = canvasPixels(session.render({ width, height, area, background: 'none', layer: { id: element.id, mask: 'only', textEffects: false } }))
        psdMask = { left: area.x, top: area.y, width: alone.width, height: alone.height, pixels: alphaOf(alone), disabled: !mask.enabled }
      }
      if (bakeMask) notes.push(`「${element.name}」带羽化或阴影，蒙版并进了像素。`)
      done += 1
      return {
        kind: 'layer',
        name: element.name,
        hidden,
        opacity: element.opacity,
        blendMode: element.blendMode ?? 'normal',
        left: bounds === null ? 0 : area.x + bounds.left,
        top: bounds === null ? 0 : area.y + bounds.top,
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        pixels: bounds === null ? new Uint8Array(0) : crop(plain, bounds),
        mask: psdMask,
        text,
        ...(clipped.has(element.id) ? { clipping: true } : {}),
        // Switched-off styles go too, so they come back switched off with their settings.
        ...(style !== undefined && LAYER_STYLE_KINDS.some((kind) => style[kind] !== undefined) ? { style } : {})
      }
    }
    const nodesOf = async (plans: readonly LayerPlan[]): Promise<PsdNode[]> => {
      const nodes: PsdNode[] = []
      for (const item of plans) {
        if (item.kind === 'layer') nodes.push(...await nodesFor(item.element, item.hidden))
        else nodes.push({ kind: 'group', name: item.element.name, hidden: item.hidden, opacity: 1, children: await nodesOf(item.children) })
      }
      return nodes
    }
    const children = await nodesOf(plan.layers)
    if (!scene.canvas.transparent) {
      children.unshift({ kind: 'layer', name: '背景色', hidden: false, opacity: 1, blendMode: 'normal', left: 0, top: 0, width, height, pixels: solidColor(scene.canvas.backgroundColor, width, height), mask: null, text: null })
    }
    checkAborted(signal)
    progress({ label: '正在合成预览图', done, total })
    await breathe()
    const composite = bytes(canvasPixels(session.render({ width, height, background: 'canvas' })))
    done += 1
    progress({ label: '正在写入 PSD', done, total })
    // Cancelled while the composite was drawn: nothing has been written yet, so nothing is.
    checkAborted(signal)
    const result = await window.desktop.writeExportPsd({ target: choice.target, document: { width, height, children, composite } })
    progress({ label: '已保存', done: total, total })
    return { paths: [result.path], notes }
  } finally {
    session.dispose()
  }
}

/** The canvas colour over the whole picture, opaque. */
function solidColor(color: string, width: number, height: number): Uint8Array<ArrayBuffer> {
  // Read the way the canvas reads it, transparency included, so the layer matches the picture.
  const { hex, alpha } = cssColor(color)
  const rgba = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), Math.round(alpha * 255)] as const
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index)
  return pixels
}
