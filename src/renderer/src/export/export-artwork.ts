import Konva from 'konva'
import { adaptedScene, hiddenByGroups, type Scene, type SceneElement } from '../../../domain'
import { hasVisibleEffects } from '../../../shared/layer-effects'
import type { ExportImageFormat, PsdLayer, PsdNode, PsdText } from '../../../shared/artwork-export'
import { pdfLayout, printedResolution, scaledSize, SOFT_PRINT_DPI, type PdfPageChoice, type SizePreset } from '../../../shared/export-presets'
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
    const size = scaledSize(scene.canvas.outputWidth, scene.canvas.outputHeight, options.scale)
    const canvas = session.render({ width: size.width, height: size.height, background: options.format === 'jpeg' ? { color: scene.canvas.transparent ? options.jpegBackground : scene.canvas.backgroundColor } : 'canvas' })
    progress({ label: '正在保存', done: 1, total: 2 })
    const result = await window.desktop.writeExportImage({ target: choice.target, format: options.format, width: size.width, height: size.height, pixels: bytes(canvasPixels(canvas)) })
    progress({ label: '已保存', done: 2, total: 2 })
    return { paths: [result.path], notes: size.scale < options.scale ? [`超过每边 ${16_384} 像素的上限，按 ${size.width}×${size.height} 导出。`] : [] }
  } finally {
    session.dispose()
  }
}

export async function exportPdf(scene: Scene, projectName: string, page: PdfPageChoice, signal: AbortSignal, progress: ProgressListener): Promise<ExportOutcome | null> {
  const choice = await window.desktop.chooseExportFile({ suggestedName: projectName, kind: 'pdf' })
  if (choice.cancelled) return null
  progress({ label: '正在画图', done: 0, total: 2 })
  const layout = pdfLayout(scene.canvas, page)
  const session = await ArtworkSession.prepare(scene, signal)
  try {
    checkAborted(signal)
    const canvas = session.render({ width: layout.width, height: layout.height, background: 'canvas' })
    progress({ label: '正在保存', done: 1, total: 2 })
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
      const canvas = session.render({ width: size.width, height: size.height, background: format === 'jpeg' ? { color: scene.canvas.transparent ? '#FFFFFF' : scene.canvas.backgroundColor } : 'canvas' })
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

/**
 * How much of the layer its mask lets through at each pixel, read from the
 * layer drawn with and without it, so the mask lands exactly where the
 * canvas puts it; where the layer has nothing, the mask shows.
 */
export function maskFrom(plain: ImageData, masked: ImageData, bounds: Bounds): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bounds.width * bounds.height)
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const index = ((bounds.top + y) * plain.width + bounds.left + x) * 4 + 3
      const alpha = plain.data[index]!
      out[y * bounds.width + x] = alpha === 0 ? 255 : Math.min(255, Math.round(masked.data[index]! * 255 / alpha))
    }
  }
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

function psdText(element: Extract<SceneElement, { type: 'text' }>, scene: Scene): PsdText {
  const box = { x: element.transform.x * scene.canvas.outputWidth, y: element.transform.y * scene.canvas.outputHeight, width: element.transform.width * scene.canvas.outputWidth, height: element.transform.height * scene.canvas.outputHeight }
  const metrics = textMetrics(element, box.width, box.height, 1)
  const solid = (color: string): string => /^#[0-9a-fA-F]{6}/.test(color) ? color.slice(0, 7).toUpperCase() : '#000000'
  return {
    content: element.content,
    orientation: element.orientation,
    fontFamily: element.fontFamily,
    fontWeight: element.fontWeight,
    fontSize: metrics.fontSize,
    color: solid(element.fill),
    letterSpacing: metrics.letterSpacing,
    lineHeight: element.lineHeight,
    align: element.align,
    box,
    rotation: element.transform.rotation,
    textHeight: textHeight(element, box.width, box.height),
    stroke: element.stroke === null || metrics.strokeWidth <= 0 ? null : { color: solid(element.stroke), width: metrics.strokeWidth },
    shadow: element.shadowColor === null || metrics.shadowBlur <= 0 ? null : { color: solid(element.shadowColor), blur: metrics.shadowBlur, opacity: TEXT_SHADOW_OPACITY }
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
  try {
    const layerOf = async (element: SceneElement): Promise<PsdLayer> => {
      checkAborted(signal)
      progress({ label: `正在导出「${element.name}」`, done, total })
      await breathe()
      const text = element.type === 'text' && options.editableText ? psdText(element, scene) : null
      const mask = element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.mask ?? null : null
      // An image whose effects follow its outline (feather, shadow) cannot have its mask apart from it: the mask goes into its pixels.
      const bakeMask = mask !== null && mask.enabled && element.type === 'image' && hasVisibleEffects(element.effects)
      // Drawn over the layer's own area, past the canvas edge too, so nothing outside the canvas is lost.
      const area = layerArea(element, width, height)
      const plainCanvas = session.render({ width, height, area, background: 'none', layer: { id: element.id, mask: mask === null || bakeMask ? 'scene' : 'off', textEffects: text === null } })
      const plain = canvasPixels(plainCanvas)
      const bounds = opaqueBounds(plain)
      let psdMask: PsdLayer['mask'] = null
      if (mask !== null && !bakeMask && bounds !== null) {
        const masked = canvasPixels(session.render({ width, height, area, background: 'none', layer: { id: element.id, mask: 'on', textEffects: text === null } }))
        psdMask = { left: area.x + bounds.left, top: area.y + bounds.top, width: bounds.width, height: bounds.height, pixels: maskFrom(plain, masked, bounds), disabled: !mask.enabled }
      }
      if (bakeMask) notes.push(`「${element.name}」带羽化或阴影，蒙版并进了像素。`)
      done += 1
      return {
        kind: 'layer',
        name: element.name,
        hidden: !element.visible,
        opacity: element.opacity,
        blendMode: element.blendMode ?? 'normal',
        left: bounds === null ? 0 : area.x + bounds.left,
        top: bounds === null ? 0 : area.y + bounds.top,
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        pixels: bounds === null ? new Uint8Array(0) : crop(plain, bounds),
        mask: psdMask,
        text
      }
    }
    const nodesOf = async (plans: readonly LayerPlan[]): Promise<PsdNode[]> => {
      const nodes: PsdNode[] = []
      for (const item of plans) {
        if (item.kind === 'layer') nodes.push(await layerOf(item.element))
        else nodes.push({ kind: 'group', name: item.element.name, hidden: !item.element.visible, opacity: 1, children: await nodesOf(item.children) })
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
    const result = await window.desktop.writeExportPsd({ target: choice.target, document: { width, height, children, composite } })
    progress({ label: '已保存', done: total, total })
    return { paths: [result.path], notes }
  } finally {
    session.dispose()
  }
}

/** The canvas colour over the whole picture, opaque. */
function solidColor(color: string, width: number, height: number): Uint8Array<ArrayBuffer> {
  const probe = document.createElement('canvas').getContext('2d')
  let rgb: readonly [number, number, number] = [255, 255, 255]
  if (probe !== null) {
    probe.fillStyle = color
    const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(probe.fillStyle)
    if (parsed !== null) rgb = [parseInt(parsed[1]!, 16), parseInt(parsed[2]!, 16), parseInt(parsed[3]!, 16)]
  }
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = rgb[0]
    pixels[index + 1] = rgb[1]
    pixels[index + 2] = rgb[2]
    pixels[index + 3] = 255
  }
  return pixels
}
