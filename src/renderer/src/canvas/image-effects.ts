import type { SceneElement } from '../../../domain'
import { applyImageEffects, hasVisibleEffects, shadowGeometry, shadowSilhouette } from '../../../shared/layer-effects'

type ImageElement = Extract<SceneElement, { type: 'image' }>

export interface EffectedImage {
  /** The image drawn into its box, effects applied. */
  readonly drawn: HTMLCanvasElement
  /** The blurred shadow and where it sits relative to the box, or null without one. */
  readonly shadow: { readonly canvas: HTMLCanvasElement; readonly x: number; readonly y: number } | null
}

/** Where the cropped image lands in a box of this size, by its fit; cover overflows the box and is clipped. */
export function drawRect(image: { readonly width: number; readonly height: number }, element: ImageElement, width: number, height: number) {
  const crop = {
    x: image.width * element.crop.x,
    y: image.height * element.crop.y,
    width: image.width * element.crop.width,
    height: image.height * element.crop.height
  }
  const sourceRatio = crop.width / crop.height
  const targetRatio = width / height
  let draw = { x: 0, y: 0, width, height }
  if (element.fit !== 'fill') {
    const contain = element.fit === 'contain'
    const useWidth = contain ? sourceRatio > targetRatio : sourceRatio < targetRatio
    draw = useWidth
      ? { x: 0, y: (height - width / sourceRatio) / 2, width, height: width / sourceRatio }
      : { x: (width - height * sourceRatio) / 2, y: 0, width: height * sourceRatio, height }
  }
  return { crop, draw }
}

function canvas(width: number, height: number): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } | null {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d', { willReadFrequently: true })
  return context === null ? null : { canvas: element, context }
}

/**
 * The image with its layer effects, drawn at the size it is shown, using the
 * same pixel math as Main's composite renderer. Null when it has no visible
 * effects or the browser cannot draw here.
 */
export function renderImageEffects(image: HTMLImageElement | HTMLCanvasElement, element: ImageElement, width: number, height: number): EffectedImage | null {
  const effects = element.effects
  if (!hasVisibleEffects(effects)) return null
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const target = canvas(w, h)
  if (target === null) return null
  const { crop, draw } = drawRect(image, element, w, h)
  target.context.drawImage(image, crop.x, crop.y, crop.width, crop.height, draw.x, draw.y, draw.width, draw.height)
  const pixels = target.context.getImageData(0, 0, w, h)
  applyImageEffects(pixels.data, w, h, effects)
  target.context.putImageData(pixels, 0, 0)
  if (effects.shadow === null || effects.shadow.opacity <= 0) return { drawn: target.canvas, shadow: null }

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
