import type { PaintOp } from '../../../domain'
import { applyPaintOp, StrokeRasterizer, type PixelRect } from '../../../shared/paint-ops'

/*
 * The canvas an image layer is drawn from once something has been painted
 * on it: its asset at full size with the recorded operations replayed. New
 * operations are applied on top of what is already there; anything else
 * (an undo, a new asset) replays from the asset. A live stroke paints into
 * the same canvas, so the layer shows it as it is drawn, and the operation
 * it records is marked as applied, so committing it costs nothing more.
 */

interface PaintedLayer {
  readonly source: HTMLImageElement
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  readonly pixels: ImageData
  /** The ids of the operations in the canvas, oldest first. */
  readonly applied: string[]
}

const layers = new Map<string, PaintedLayer>()
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
  const layer: PaintedLayer = { source: image, canvas, context, pixels: context.getImageData(0, 0, canvas.width, canvas.height), applied: [] }
  layers.set(elementId, layer)
  return layer
}

function isPrefix(applied: readonly string[], ops: readonly PaintOp[]): boolean {
  if (applied.length > ops.length) return false
  for (let index = 0; index < applied.length; index += 1) if (applied[index] !== ops[index]!.id) return false
  return true
}

/** Brings the layer's canvas up to these operations, painting only what is new when it can. */
function ensure(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[]): PaintedLayer | null {
  let layer = layers.get(elementId)
  if (layer === undefined || layer.source !== image || !isPrefix(layer.applied, ops)) layer = rebuild(elementId, image) ?? undefined
  if (layer === undefined) return null
  if (layer.applied.length < ops.length) {
    for (const op of ops.slice(layer.applied.length)) {
      applyPaintOp(layer.pixels.data, layer.canvas.width, layer.canvas.height, op)
      layer.applied.push(op.id)
    }
    layer.context.putImageData(layer.pixels, 0, 0)
  }
  return layer
}

/** What the layer should be drawn from: the asset itself when nothing is painted on it. */
export function paintedSource(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[] | undefined): HTMLImageElement | HTMLCanvasElement {
  sources.set(elementId, image)
  if ((ops === undefined || ops.length === 0) && !live.has(elementId)) {
    layers.delete(elementId)
    return image
  }
  return ensure(elementId, image, ops ?? [])?.canvas ?? image
}

/** The canvas a painted layer is drawn from, for its thumbnail; null when nothing is painted on it or it has not been drawn yet. */
export function pixelLayerCanvas(elementId: string): HTMLCanvasElement | null {
  return layers.get(elementId)?.canvas ?? null
}

/** The layer's current pixels and size, for the eyedropper and the paint bucket preview. */
export function layerPixels(elementId: string): ImageData | null {
  return layers.get(elementId)?.pixels ?? null
}

export interface LiveStroke {
  /** Continues the stroke into the canvas; returns whether pixels changed, for the caller to redraw the layer. */
  addPoint(x: number, y: number, pressure: number): boolean
  /** The stroke went into the scene as this operation; its pixels are already in the canvas. */
  commit(op: PaintOp): void
  /** Drops the stroke and puts the layer back as the scene has it. */
  cancel(): void
}

/**
 * Starts painting on a layer that the scene has with these operations.
 * Returns the canvas the layer is now drawn from, which the stroke paints
 * into, and the stroke.
 */
export function beginLiveStroke(
  elementId: string,
  image: HTMLImageElement,
  ops: readonly PaintOp[],
  brush: Omit<Extract<PaintOp, { kind: 'stroke' }>, 'points' | 'id'>
): { readonly canvas: HTMLCanvasElement, readonly stroke: LiveStroke } | null {
  const layer = ensure(elementId, image, ops)
  if (layer === null) return null
  live.add(elementId)
  notify(elementId)
  const rasterizer = new StrokeRasterizer(layer.pixels.data, layer.canvas.width, layer.canvas.height, brush)
  const put = (rect: PixelRect | null): boolean => {
    if (rect === null) return false
    layer.context.putImageData(layer.pixels, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
    return true
  }
  return {
    canvas: layer.canvas,
    stroke: {
      addPoint: (x, y, pressure) => put(rasterizer.addPoint(x, y, pressure)),
      commit: (op) => { layer.applied.push(op.id); live.delete(elementId) },
      cancel: () => { live.delete(elementId); layers.delete(elementId); notify(elementId) }
    }
  }
}

/** Applies a one-shot operation (bucket, gradient, fill) at once, before the scene has it, and marks it applied. */
export function applyLiveOp(elementId: string, image: HTMLImageElement, ops: readonly PaintOp[], op: PaintOp): HTMLCanvasElement | null {
  const layer = ensure(elementId, image, ops)
  if (layer === null) return null
  applyPaintOp(layer.pixels.data, layer.canvas.width, layer.canvas.height, op)
  layer.applied.push(op.id)
  layer.context.putImageData(layer.pixels, 0, 0)
  notify(elementId)
  return layer.canvas
}

/** Forgets a layer whose painting did not reach the scene, so it is drawn from the scene again. */
export function discardPixelLayer(elementId: string): void {
  live.delete(elementId)
  if (layers.delete(elementId)) notify(elementId)
}

/** For a layer with effects, whose shown image is a copy: asks its visual to redraw from the canvas. */
export function refreshPixelLayer(elementId: string): void {
  notify(elementId)
}

/** The loaded asset an image layer is drawn from, or null before it has loaded. */
export function layerSourceImage(elementId: string): HTMLImageElement | null {
  return sources.get(elementId) ?? null
}
