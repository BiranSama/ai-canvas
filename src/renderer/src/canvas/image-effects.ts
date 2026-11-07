import type { SceneElement } from '../../../domain'
import { activeAdjustments, adjustLayerPixels, coverageInBox, hasSpatialFilters } from '../../../shared/adjustments'
import { applyImageEffects, hasVisibleEffects, shadowGeometry, shadowSilhouette } from '../../../shared/layer-effects'
import { imageDrawRect } from '../../../shared/layer-space'

type ImageElement = Extract<SceneElement, { type: 'image' }>

export interface EffectedImage {
  /** The image drawn into its box, effects applied. */
  readonly drawn: HTMLCanvasElement
  /** The blurred shadow and where it sits relative to the box, or null without one. */
  readonly shadow: { readonly canvas: HTMLCanvasElement; readonly x: number; readonly y: number } | null
}

/** Where the cropped image lands in a box of this size, by its fit; cover overflows the box and is clipped. */
export const drawRect = (image: { readonly width: number; readonly height: number }, element: ImageElement, width: number, height: number) => imageDrawRect(image, element, width, height)

function canvas(width: number, height: number): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } | null {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d', { willReadFrequently: true })
  return context === null ? null : { canvas: element, context }
}

/** The selections a layer's adjustments were made in, in the layer's own pixels. */
export interface AdjustmentClips {
  readonly width: number
  readonly height: number
  readonly pixels: ReadonlyMap<string, Uint8Array>
}

/** Whether the image is drawn through renderImageEffects rather than as it is. */
export function hasDrawnEffects(element: ImageElement): boolean {
  return hasVisibleEffects(element.effects) || activeAdjustments(element.adjustments).length > 0
}

/** A clip drawn into the box the way the image is: its coverage at the box's size, read as Main reads it. */
function clipCoverage(clip: Uint8Array, size: { readonly width: number; readonly height: number }, element: ImageElement, w: number, h: number): Uint8Array {
  return coverageInBox({ width: size.width, height: size.height, data: clip }, element, w, h)
}

/** Applies the colour match and feather in place and gives the shadow the result casts, or null without one. */
function effectsWithShadow(pixels: ImageData, w: number, h: number, effects: NonNullable<ImageElement['effects']>): EffectedImage['shadow'] {
  applyImageEffects(pixels.data, w, h, effects)
  return shadowOf(pixels, w, h, effects)
}

/** The shadow the picture casts, blurred, and where it sits relative to the box. */
function shadowOf(pixels: ImageData, w: number, h: number, effects: NonNullable<ImageElement['effects']>): EffectedImage['shadow'] {
  if (effects.shadow === null || effects.shadow.opacity <= 0) return null
  const geometry = shadowGeometry(effects.shadow, w, h)
  const silhouette = canvas(w, h)
  const blurred = canvas(w + geometry.padding * 2, h + geometry.padding * 2)
  if (silhouette === null || blurred === null) return null
  silhouette.context.putImageData(new ImageData(shadowSilhouette(pixels.data, w, h, effects.shadow), w, h), 0, 0)
  if (geometry.sigma >= 0.3) blurred.context.filter = `blur(${geometry.sigma}px)`
  blurred.context.drawImage(silhouette.canvas, geometry.padding, geometry.padding)
  return { canvas: blurred.canvas, x: geometry.offsetX - geometry.padding, y: geometry.offsetY - geometry.padding }
}

/** A layer mask in the image's own pixels, put on after the filters rather than into the source. */
export interface LaterMask {
  readonly width: number
  readonly height: number
  readonly coverage: Uint8Array
}

interface DrawnBase {
  /** The image in its box with its colour match and feather, before its adjustments. */
  readonly pixels: ImageData
  readonly shadow: EffectedImage['shadow']
}

/** The few last bases drawn from each picture, so moving an adjustment's control only adjusts again. */
const bases = new WeakMap<HTMLImageElement | HTMLCanvasElement, Map<string, DrawnBase>>()
const BASES_KEPT = 2

function drawnBase(image: HTMLImageElement | HTMLCanvasElement, element: ImageElement, w: number, h: number, sourceVersion: string | number): DrawnBase | null {
  const effects = element.effects
  const key = `${sourceVersion}|${w}x${h}|${element.crop.x},${element.crop.y},${element.crop.width},${element.crop.height}|${element.fit}|${JSON.stringify(effects ?? null)}`
  let kept = bases.get(image)
  if (kept === undefined) { kept = new Map(); bases.set(image, kept) }
  const found = kept.get(key)
  if (found !== undefined) return found
  const target = canvas(w, h)
  if (target === null) return null
  const { crop, draw } = drawRect(image, element, w, h)
  target.context.drawImage(image, crop.x, crop.y, crop.width, crop.height, draw.x, draw.y, draw.width, draw.height)
  const pixels = target.context.getImageData(0, 0, w, h)
  const shadow = hasVisibleEffects(effects) ? effectsWithShadow(pixels, w, h, effects) : null
  const base = { pixels, shadow }
  kept.set(key, base)
  while (kept.size > BASES_KEPT) kept.delete(kept.keys().next().value!)
  return base
}

/**
 * The image with its layer effects, adjustments and filters, drawn at this
 * size, using the same pixel math as Main's composite renderer. Null when it
 * has none or the browser cannot draw here. Clips must be given for every
 * adjustment made in a selection. sourceVersion marks a source canvas
 * painted on in place, so what was drawn from it before is not reused.
 * scale is how many of the drawn pixels make one output pixel, so filters
 * blur by the same amount at any size. A mask given as laterMask goes on
 * after the filters, as on a smart object; the source must not carry it.
 */
export function renderImageEffects(
  image: HTMLImageElement | HTMLCanvasElement,
  element: ImageElement,
  width: number,
  height: number,
  clips: AdjustmentClips | null = null,
  sourceVersion: string | number = 0,
  scale = 1,
  laterMask: LaterMask | null = null
): EffectedImage | null {
  const adjustments = activeAdjustments(element.adjustments)
  if (!hasVisibleEffects(element.effects) && adjustments.length === 0) return null
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const base = drawnBase(image, element, w, h, sourceVersion)
  const target = canvas(w, h)
  if (base === null || target === null) return null
  // Colour match and feather first (in the base), then the layer's own adjustments and filters, as Main draws it.
  const pixels = new ImageData(new Uint8ClampedArray(base.pixels.data), w, h)
  if (adjustments.length > 0) {
    const coverages = new Map<string, Uint8Array | null>()
    adjustLayerPixels(pixels.data, adjustments, { width: w, height: h, scale: scale * w / Math.max(1e-6, width) }, (clipId) => {
      if (!coverages.has(clipId)) {
        const clip = clips?.pixels.get(clipId)
        coverages.set(clipId, clip === undefined || clips === null ? null : clipCoverage(clip, clips, element, w, h))
      }
      return coverages.get(clipId) ?? null
    })
  }
  if (laterMask !== null) {
    const coverage = clipCoverage(laterMask.coverage, laterMask, element, w, h)
    if (coverage !== null) for (let pixel = 0; pixel < coverage.length; pixel += 1) pixels.data[pixel * 4 + 3] = Math.round(pixels.data[pixel * 4 + 3]! * coverage[pixel]! / 255)
  }
  target.context.putImageData(pixels, 0, 0)
  // A filter that moves pixels, or a mask put on after it, changes the outline the shadow follows.
  const reshaped = laterMask !== null || hasSpatialFilters(adjustments)
  const shadow = reshaped && hasVisibleEffects(element.effects) ? shadowOf(pixels, w, h, element.effects) : base.shadow
  return { drawn: target.canvas, shadow }
}
