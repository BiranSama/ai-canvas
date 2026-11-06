import type { SceneElement } from '../../../domain'
import { activeAdjustments, adjustLayerPixels } from '../../../shared/adjustments'
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

/** A clip drawn into the box the way the image is: its coverage at the box's size. */
function clipCoverage(clip: Uint8Array, size: { readonly width: number; readonly height: number }, element: ImageElement, w: number, h: number): Uint8Array | null {
  const source = canvas(size.width, size.height)
  const target = canvas(w, h)
  if (source === null || target === null) return null
  const gray = source.context.createImageData(size.width, size.height)
  for (let index = 0; index < clip.length; index += 1) gray.data.set([clip[index]!, 0, 0, 255], index * 4)
  source.context.putImageData(gray, 0, 0)
  const { crop, draw } = drawRect(size, element, w, h)
  target.context.drawImage(source.canvas, crop.x, crop.y, crop.width, crop.height, draw.x, draw.y, draw.width, draw.height)
  const drawn = target.context.getImageData(0, 0, w, h).data
  const coverage = new Uint8Array(w * h)
  // Outside the drawn picture nothing was selected; alpha carries that at the edges.
  for (let index = 0; index < coverage.length; index += 1) coverage[index] = Math.round(drawn[index * 4]! * drawn[index * 4 + 3]! / 255)
  return coverage
}

/**
 * The image with its layer effects and adjustments, drawn at this size,
 * using the same pixel math as Main's composite renderer. Null when it has
 * neither or the browser cannot draw here. Clips must be given for every
 * adjustment made in a selection.
 */
export function renderImageEffects(image: HTMLImageElement | HTMLCanvasElement, element: ImageElement, width: number, height: number, clips: AdjustmentClips | null = null): EffectedImage | null {
  const effects = element.effects
  const adjustments = activeAdjustments(element.adjustments)
  const visibleEffects = hasVisibleEffects(effects)
  if (!visibleEffects && adjustments.length === 0) return null
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const target = canvas(w, h)
  if (target === null) return null
  const { crop, draw } = drawRect(image, element, w, h)
  target.context.drawImage(image, crop.x, crop.y, crop.width, crop.height, draw.x, draw.y, draw.width, draw.height)
  const pixels = target.context.getImageData(0, 0, w, h)
  // Colour match and feather first, then the layer's own adjustments, as Main draws it.
  if (visibleEffects) applyImageEffects(pixels.data, w, h, effects)
  if (adjustments.length > 0) {
    const coverages = new Map<string, Uint8Array | null>()
    adjustLayerPixels(pixels.data, adjustments, (clipId) => {
      if (!coverages.has(clipId)) {
        const clip = clips?.pixels.get(clipId)
        coverages.set(clipId, clip === undefined || clips === null ? null : clipCoverage(clip, clips, element, w, h))
      }
      return coverages.get(clipId) ?? null
    })
  }
  target.context.putImageData(pixels, 0, 0)
  if (!visibleEffects || effects.shadow === null || effects.shadow.opacity <= 0) return { drawn: target.canvas, shadow: null }

  const geometry = shadowGeometry(effects.shadow, w, h)
  const silhouette = canvas(w, h)
  const blurred = canvas(w + geometry.padding * 2, h + geometry.padding * 2)
  if (silhouette === null || blurred === null) return { drawn: target.canvas, shadow: null }
  silhouette.context.putImageData(new ImageData(shadowSilhouette(pixels.data, w, h, effects.shadow), w, h), 0, 0)
  if (geometry.sigma >= 0.3) blurred.context.filter = `blur(${geometry.sigma}px)`
  blurred.context.drawImage(silhouette.canvas, geometry.padding, geometry.padding)
  return {
    drawn: target.canvas,
    shadow: { canvas: blurred.canvas, x: geometry.offsetX - geometry.padding, y: geometry.offsetY - geometry.padding }
  }
}
