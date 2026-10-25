import type { LayerMask, PaintOp } from '../../../domain'
import { applyMaskAlpha, applyPaintOp, maskCoverage, StrokeRasterizer, type ClipLookup, type ClipPixels, type PixelRect } from '../../../shared/paint-ops'
import type { MaskView } from './mask-state'

/*
 * The canvas an image layer is drawn from once something has been painted
 * on it or it has a mask: its asset at full size with the recorded
 * operations replayed, shown through its mask. New operations are applied
 * on top of what is already there; anything else (an undo, a new asset)
 * replays from the asset. A live stroke paints into the same pixels, so
 * the layer shows it as it is drawn, and the operation it records is marked
 * as applied, so committing it costs nothing more. Layer masks are kept the
 * same way, for image layers and for text and shapes.
 */

interface PaintedLayer {
  readonly source: HTMLImageElement
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  /** The layer's own pixels with its paint. */
  readonly pixels: ImageData
  /** What the canvas shows when a mask is on or being looked at; null when it shows the pixels themselves. */
  shown: ImageData | null
  /** The ids of the operations in the pixels, oldest first. */
  readonly applied: string[]
  /** Counts changes to the pixels, so the shown pixels are rebuilt only when they are out of date. */
  revision: number
  composed: string
  display: Display
}

interface MaskPixels {
  readonly assetId: string
  readonly width: number
  readonly height: number
  /** The mask as opaque gray, with its paint replayed. */
  readonly rgba: Uint8ClampedArray
  /** The red channel of rgba: how much of the layer shows. */
  readonly coverage: Uint8Array
  readonly applied: string[]
  revision: number
  /** For text and shapes: the coverage as transparency, which their group is masked with. */
  alpha: { readonly canvas: HTMLCanvasElement; readonly image: ImageData; revision: number } | null
}

interface Display {
  readonly mask: MaskPixels | null
  readonly enabled: boolean
  readonly view: MaskView
}

const NO_DISPLAY: Display = { mask: null, enabled: false, view: 'normal' }

const layers = new Map<string, PaintedLayer>()
const masks = new Map<string, MaskPixels>()
/** Each image layer's asset as last drawn, for the painting tools to start from. */
const sources = new Map<string, HTMLImageElement>()
/** Layers being painted on right now; their canvas stands even before the scene records anything. */
const live = new Set<string>()
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

/** Tells the layer's visual to draw from its canvas again; each layer counts on its own, so only it re-renders. */
function notify(elementId: string): void {
  versions.set(elementId, (versions.get(elementId) ?? 0) + 1)
  for (const listener of listeners) listener()
}

export function subscribePixelLayers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function pixelLayerVersion(elementId: string): number {
  return versions.get(elementId) ?? 0
}

function rebuild(elementId: string, image: HTMLImageElement): PaintedLayer | null {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.naturalWidth)
  canvas.height = Math.max(1, image.naturalHeight)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.drawImage(image, 0, 0)
  const layer: PaintedLayer = { source: image, canvas, context, pixels: context.getImageData(0, 0, canvas.width, canvas.height), shown: null, applied: [], revision: 0, composed: '', display: NO_DISPLAY }
  layers.set(elementId, layer)
  return layer
}

function isPrefix(applied: readonly string[], ops: readonly PaintOp[]): boolean {
  if (applied.length > ops.length) return false
  for (let index = 0; index < applied.length; index += 1) if (applied[index] !== ops[index]!.id) return false
  return true
}

/** Brings the layer's pixels up to these operations, painting only what is new when it can. */
function ensure(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[], clips: ClipLookup): PaintedLayer | null {
  let layer = layers.get(elementId)
  if (layer === undefined || layer.source !== image || !isPrefix(layer.applied, ops)) layer = rebuild(elementId, image) ?? undefined
  if (layer === undefined) return null
  if (layer.applied.length < ops.length) {
    for (const op of ops.slice(layer.applied.length)) {
      applyPaintOp(layer.pixels.data, layer.canvas.width, layer.canvas.height, op, clips)
      layer.applied.push(op.id)
    }
    layer.revision += 1
  }
  return layer
}

function rebuildMask(elementId: string, mask: LayerMask, gray: ClipPixels, width: number, height: number): MaskPixels {
  const coverage = maskCoverage(gray, width, height, undefined)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < coverage.length; index += 1) {
    const value = coverage[index]!
    rgba[index * 4] = value; rgba[index * 4 + 1] = value; rgba[index * 4 + 2] = value; rgba[index * 4 + 3] = 255
  }
  const pixels: MaskPixels = { assetId: mask.assetId, width, height, rgba, coverage, applied: [], revision: 0, alpha: null }
  masks.set(elementId, pixels)
  return pixels
}

/** Brings a layer mask up to its operations, the same way. */
function ensureMask(elementId: string, mask: LayerMask, gray: ClipPixels, width: number, height: number, clips: ClipLookup): MaskPixels {
  const ops = mask.paint ?? []
  let pixels = masks.get(elementId)
  if (pixels === undefined || pixels.assetId !== mask.assetId || pixels.width !== width || pixels.height !== height || !isPrefix(pixels.applied, ops)) {
    pixels = rebuildMask(elementId, mask, gray, width, height)
  }
  if (pixels.applied.length < ops.length) {
    for (const op of ops.slice(pixels.applied.length)) {
      applyPaintOp(pixels.rgba, width, height, op, clips)
      pixels.applied.push(op.id)
    }
    readCoverage(pixels, null)
    pixels.revision += 1
  }
  return pixels
}

function readCoverage(mask: MaskPixels, rect: PixelRect | null): void {
  const x0 = rect?.x0 ?? 0
  const y0 = rect?.y0 ?? 0
  const x1 = rect?.x1 ?? mask.width
  const y1 = rect?.y1 ?? mask.height
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask.coverage[y * mask.width + x] = mask.rgba[(y * mask.width + x) * 4]!
}

/** Rebuilds what the canvas shows from the pixels, over the whole layer or one rectangle. */
function compose(layer: PaintedLayer, rect: PixelRect | null): void {
  const { mask, enabled, view } = layer.display
  const width = layer.canvas.width
  const height = layer.canvas.height
  if (mask === null || (!enabled && view === 'normal')) {
    layer.shown = null
    return
  }
  if (layer.shown === null) layer.shown = new ImageData(width, height)
  const source = layer.pixels.data
  const target = layer.shown.data
  if (view === 'normal') {
    applyMaskAlpha(source, target, mask.coverage, width, rect)
    return
  }
  const x0 = rect?.x0 ?? 0
  const y0 = rect?.y0 ?? 0
  const x1 = rect?.x1 ?? width
  const y1 = rect?.y1 ?? height
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = y * width + x
      const index = pixel * 4
      const value = mask.coverage[pixel]!
      if (view === 'alone') {
        // Alt+click on the mask: the mask itself in gray, as Photoshop shows it.
        target[index] = value; target[index + 1] = value; target[index + 2] = value; target[index + 3] = 255
        continue
      }
      // Backslash: the layer unmasked, with the hidden parts under half-strength red.
      const red = (255 - value) / 255 * 0.5
      const alpha = source[index + 3]! / 255
      const out = red + alpha * (1 - red)
      if (out <= 0) { target[index + 3] = 0; continue }
      target[index] = Math.round((255 * red + source[index]! * alpha * (1 - red)) / out)
      target[index + 1] = Math.round((source[index + 1]! * alpha * (1 - red)) / out)
      target[index + 2] = Math.round((source[index + 2]! * alpha * (1 - red)) / out)
      target[index + 3] = Math.round(out * 255)
    }
  }
}

function put(layer: PaintedLayer, rect: PixelRect | null): void {
  const image = layer.shown ?? layer.pixels
  if (rect === null) layer.context.putImageData(image, 0, 0)
  else layer.context.putImageData(image, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
}

/** The mask an image layer is shown through: its asset's pixels at the layer's size, and how to show it. */
export interface MaskSource {
  readonly mask: LayerMask
  readonly gray: ClipPixels
  readonly clips: ClipLookup
  readonly view: MaskView
}

/** What the layer should be drawn from: the asset itself when nothing is painted on it and no mask applies. */
export function paintedSource(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[] | undefined, clips: ClipLookup = new Map(), maskSource: MaskSource | null = null): HTMLImageElement | HTMLCanvasElement {
  sources.set(elementId, image)
  const masked = maskSource !== null && (maskSource.mask.enabled || maskSource.view !== 'normal')
  if ((ops === undefined || ops.length === 0) && !live.has(elementId) && !masked) {
    layers.delete(elementId)
    if (maskSource === null) masks.delete(elementId)
    return image
  }
  const layer = ensure(elementId, image, ops ?? [], clips)
  if (layer === null) return image
  const mask = maskSource === null ? null : ensureMask(elementId, maskSource.mask, maskSource.gray, layer.canvas.width, layer.canvas.height, maskSource.clips)
  if (maskSource === null) masks.delete(elementId)
  layer.display = { mask, enabled: maskSource?.mask.enabled ?? false, view: maskSource?.view ?? 'normal' }
  const key = `${layer.revision}|${mask === null ? '' : `${mask.assetId}:${mask.revision}`}|${layer.display.enabled}|${layer.display.view}`
  if (key !== layer.composed) {
    compose(layer, null)
    put(layer, null)
    layer.composed = key
  }
  return layer.canvas
}

/** A text or shape layer's mask as transparency over its box, or null without one; also its coverage for viewing. */
export function maskedBoxSource(elementId: string, mask: LayerMask, gray: { readonly width: number; readonly height: number; readonly data: ClipPixels }, clips: ClipLookup): { readonly alpha: HTMLCanvasElement; readonly mask: MaskPixels } {
  const pixels = ensureMask(elementId, mask, gray.data, gray.width, gray.height, clips)
  if (pixels.alpha === null || pixels.alpha.revision !== pixels.revision) {
    const canvas = pixels.alpha?.canvas ?? document.createElement('canvas')
    canvas.width = pixels.width
    canvas.height = pixels.height
    const image = new ImageData(pixels.width, pixels.height)
    for (let index = 0; index < pixels.coverage.length; index += 1) image.data[index * 4 + 3] = pixels.coverage[index]!
    canvas.getContext('2d')?.putImageData(image, 0, 0)
    pixels.alpha = { canvas, image, revision: pixels.revision }
  }
  return { alpha: pixels.alpha.canvas, mask: pixels }
}

/** A layer mask's current coverage and size, for the thumbnail, loading it as a selection and applying it. */
export function layerMaskPixels(elementId: string): { readonly width: number; readonly height: number; readonly coverage: Uint8Array } | null {
  const mask = masks.get(elementId)
  return mask === undefined ? null : { width: mask.width, height: mask.height, coverage: mask.coverage }
}

/** The canvas a painted layer is drawn from, for its thumbnail; null when nothing is painted on it or it has not been drawn yet. */
export function pixelLayerCanvas(elementId: string): HTMLCanvasElement | null {
  return layers.get(elementId)?.canvas ?? null
}

/** The layer's current pixels (its paint, without its mask) and size. */
export function layerPixels(elementId: string): ImageData | null {
  return layers.get(elementId)?.pixels ?? null
}

export interface LiveStroke {
  /** Continues the stroke; returns whether pixels changed, for the caller to redraw the layer. */
  addPoint(x: number, y: number, pressure: number): boolean
  /** The stroke went into the scene as this operation; its pixels are already in place. */
  commit(op: PaintOp): void
  /** Drops the stroke and puts the layer back as the scene has it. */
  cancel(): void
}

/**
 * Starts painting on a layer that the scene has with these operations,
 * limited to clip (a selection in the layer's pixels) when there is one.
 */
export function beginLiveStroke(
  elementId: string,
  image: HTMLImageElement,
  ops: readonly PaintOp[],
  clips: ClipLookup,
  brush: Omit<Extract<PaintOp, { kind: 'stroke' }>, 'points' | 'id'>,
  clip: ClipPixels | null
): LiveStroke | null {
  const layer = ensure(elementId, image, ops, clips)
  if (layer === null) return null
  live.add(elementId)
  if (layer.composed === '') { compose(layer, null); put(layer, null) }
  notify(elementId)
  const rasterizer = new StrokeRasterizer(layer.pixels.data, layer.canvas.width, layer.canvas.height, brush, clip)
  return {
    addPoint: (x, y, pressure) => {
      const rect = rasterizer.addPoint(x, y, pressure)
      if (rect === null) return false
      compose(layer, rect)
      put(layer, rect)
      return true
    },
    commit: (op) => { layer.applied.push(op.id); live.delete(elementId) },
    cancel: () => { live.delete(elementId); layers.delete(elementId); notify(elementId) }
  }
}

/** Applies a one-shot operation (bucket, gradient, fill, clear) at once, before the scene has it, and marks it applied. */
export function applyLiveOp(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[], clips: ClipLookup, op: PaintOp, clip: ClipPixels | null): boolean {
  const layer = ensure(elementId, image, ops, clips)
  if (layer === null) return false
  const withClip: ClipLookup = op.clip === undefined || clip === null ? clips : new Map([...clips, [op.clip, clip]])
  applyPaintOp(layer.pixels.data, layer.canvas.width, layer.canvas.height, op, withClip)
  layer.applied.push(op.id)
  compose(layer, null)
  put(layer, null)
  notify(elementId)
  return true
}

/** Starts painting on a layer's mask, which its visual has already drawn. */
export function beginLiveMaskStroke(elementId: string, brush: Omit<Extract<PaintOp, { kind: 'stroke' }>, 'points' | 'id'>, clip: ClipPixels | null): LiveStroke | null {
  const mask = masks.get(elementId)
  if (mask === undefined) return null
  live.add(elementId)
  const rasterizer = new StrokeRasterizer(mask.rgba, mask.width, mask.height, brush, clip)
  return {
    addPoint: (x, y, pressure) => {
      const rect = rasterizer.addPoint(x, y, pressure)
      if (rect === null) return false
      maskChanged(elementId, mask, rect)
      return true
    },
    commit: (op) => { mask.applied.push(op.id); live.delete(elementId) },
    cancel: () => { live.delete(elementId); masks.delete(elementId); layers.delete(elementId); notify(elementId) }
  }
}

/** A one-shot operation on a layer's mask. */
export function applyLiveMaskOp(elementId: string, op: PaintOp, clip: ClipPixels | null): boolean {
  const mask = masks.get(elementId)
  if (mask === undefined) return false
  applyPaintOp(mask.rgba, mask.width, mask.height, op, op.clip === undefined || clip === null ? new Map() : new Map([[op.clip, clip]]))
  mask.applied.push(op.id)
  maskChanged(elementId, mask, null)
  return true
}

/** The mask's pixels changed in rect: what shows through it follows at once. */
function maskChanged(elementId: string, mask: MaskPixels, rect: PixelRect | null): void {
  readCoverage(mask, rect)
  mask.revision += 1
  const layer = layers.get(elementId)
  if (layer !== undefined && layer.display.mask === mask) {
    compose(layer, rect)
    put(layer, rect)
    layer.composed = `${layer.revision}|${mask.assetId}:${mask.revision}|${layer.display.enabled}|${layer.display.view}`
  }
  if (mask.alpha !== null) {
    const x0 = rect?.x0 ?? 0
    const y0 = rect?.y0 ?? 0
    const x1 = rect?.x1 ?? mask.width
    const y1 = rect?.y1 ?? mask.height
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask.alpha.image.data[(y * mask.width + x) * 4 + 3] = mask.coverage[y * mask.width + x]!
    mask.alpha.canvas.getContext('2d')?.putImageData(mask.alpha.image, 0, 0, x0, y0, x1 - x0, y1 - y0)
    mask.alpha.revision = mask.revision
  }
  notify(elementId)
}

/** Forgets a layer whose painting did not reach the scene, so it is drawn from the scene again. */
export function discardPixelLayer(elementId: string): void {
  live.delete(elementId)
  const dropped = layers.delete(elementId)
  if (masks.delete(elementId) || dropped) notify(elementId)
}

/** For a layer with effects or a masked text or shape layer, whose shown image is a copy: asks its visual to redraw. */
export function refreshPixelLayer(elementId: string): void {
  notify(elementId)
}

/** The loaded asset an image layer is drawn from, or null before it has loaded. */
export function layerSourceImage(elementId: string): HTMLImageElement | null {
  return sources.get(elementId) ?? null
}

/** The mask's size, for painting on it: the layer's pixels for an image, its own for text and shapes. */
export function maskSize(elementId: string): { readonly width: number; readonly height: number } | null {
  const mask = masks.get(elementId)
  return mask === undefined ? null : { width: mask.width, height: mask.height }
}
