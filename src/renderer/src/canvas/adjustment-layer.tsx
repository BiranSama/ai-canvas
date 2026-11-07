import type Konva from 'konva'
import { Shape } from 'react-konva'
import type { AdjustmentSettings, BlendMode } from '../../../domain'
import { adjustPixels, sampleCoverage } from '../../../shared/adjustments'

/*
 * An adjustment layer as Konva draws it: when its turn comes, everything
 * below it is already on the canvas, so it reads those pixels back, adjusts
 * them through its mask and opacity with the shared pixel math, and puts
 * them back. The canvas, the offscreen export stage and merges all draw it
 * this way, so they agree with Main's renderer, which adjusts the picture
 * drawn so far in the same way.
 */

export interface AdjustmentCoverage {
  readonly width: number
  readonly height: number
  /** One byte a pixel over the whole canvas: white applies the adjustment, black leaves the pixels. */
  readonly coverage: Uint8Array | Uint8ClampedArray
}

/** Draws nothing of its own; adjusts what is beneath it over a box of this size (the whole canvas). */
export function AdjustmentBackdrop({ width, height, settings, opacity, blend, mask }: {
  readonly width: number
  readonly height: number
  readonly settings: AdjustmentSettings
  readonly opacity: number
  /** How the adjusted colours are laid over the originals, as an adjustment layer's blend mode does in Photoshop. */
  readonly blend: BlendMode
  readonly mask: AdjustmentCoverage | null
}): React.JSX.Element {
  return (
    <Shape
      name="adjustment-backdrop"
      width={width}
      height={height}
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(context: Konva.Context) => {
        const native = (context as unknown as { readonly _context: CanvasRenderingContext2D })._context
        const matrix = native.getTransform()
        // The box in the canvas's own pixels; the stage only scales and moves, never turns it.
        const xs = [matrix.e, matrix.a * width + matrix.e, matrix.c * height + matrix.e, matrix.a * width + matrix.c * height + matrix.e]
        const ys = [matrix.f, matrix.b * width + matrix.f, matrix.d * height + matrix.f, matrix.b * width + matrix.d * height + matrix.f]
        const left = Math.max(0, Math.floor(Math.min(...xs) + 1e-6))
        const top = Math.max(0, Math.floor(Math.min(...ys) + 1e-6))
        const right = Math.min(native.canvas.width, Math.ceil(Math.max(...xs) - 1e-6))
        const bottom = Math.min(native.canvas.height, Math.ceil(Math.max(...ys) - 1e-6))
        const regionWidth = right - left
        const regionHeight = bottom - top
        if (regionWidth <= 0 || regionHeight <= 0 || matrix.a === 0 || matrix.d === 0) return
        const pixels = native.getImageData(left, top, regionWidth, regionHeight)
        let coverage: Uint8Array | null = null
        if (mask !== null) {
          const scaleX = mask.width / (width * matrix.a)
          const scaleY = mask.height / (height * matrix.d)
          coverage = sampleCoverage({ width: mask.width, height: mask.height, data: mask.coverage }, regionWidth, regionHeight, {
            scaleX, scaleY, offsetX: (left - matrix.e) * scaleX, offsetY: (top - matrix.f) * scaleY
          })
        }
        adjustPixels(pixels.data, settings, { coverage, amount: opacity, blend })
        native.putImageData(pixels, left, top)
      }}
    />
  )
}
