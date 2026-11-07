import { applyMatrix, boxWarpMatrix, cornersExtent, invertMatrix, multiplyMatrices, scaleMatrix, type Corners, type Matrix3 } from '../domain/scene/free-transform'

/*
 * A layer's pixels resampled through its free-transform corners, for a
 * distort or a perspective, which the canvas and SVG cannot draw directly.
 * The canvas, the export stage and Main's renderer all call this on the
 * layer drawn in its own box, so they agree; the layer's styles go on after.
 * Sampling is bilinear in premultiplied colour, so transparent edges do not
 * darken, and what falls outside the source is transparent.
 */

export interface WarpLayout {
  /** Where the warped raster sits, in the box's pixels (it may reach outside the box). */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Its size in raster pixels. */
  readonly rasterWidth: number
  readonly rasterHeight: number
}

/** The most pixels a warped layer is resampled into. */
export const WARP_PIXELS = 36_000_000

/**
 * Where a layer of this box lands after its corners, as a raster at `ratio`
 * raster pixels per box pixel, grown by a pixel each side for the soft edge.
 */
export function warpLayout(corners: Corners, boxWidth: number, boxHeight: number, ratio: number): WarpLayout {
  const extent = cornersExtent(corners)
  const pad = 1 / Math.max(1e-6, ratio)
  // On whole box pixels, so a box on whole canvas pixels is not resampled again where it is laid.
  const x = Math.floor(extent.x * boxWidth - pad)
  const y = Math.floor(extent.y * boxHeight - pad)
  const width = Math.ceil((extent.x + extent.width) * boxWidth + pad) - x
  const height = Math.ceil((extent.y + extent.height) * boxHeight + pad) - y
  const fit = Math.min(ratio, Math.sqrt(WARP_PIXELS / Math.max(1, width * height)))
  return { x, y, width, height, rasterWidth: Math.max(1, Math.ceil(width * fit)), rasterHeight: Math.max(1, Math.ceil(height * fit)) }
}

/**
 * The map from a pixel of the warped raster to the source raster that holds
 * the box's content (pixel centres at +0.5 on both sides).
 */
export function warpSourceMatrix(corners: Corners, boxWidth: number, boxHeight: number, layout: WarpLayout, sourceWidth: number, sourceHeight: number): Matrix3 {
  // Raster pixel → box pixel.
  const toBox = scaleMatrix(layout.width / layout.rasterWidth, layout.height / layout.rasterHeight, layout.x, layout.y)
  // Box pixel (after the corners) → box pixel (before).
  const unwarp = invertMatrix(boxWarpMatrix(corners, boxWidth, boxHeight))
  // Box pixel → source raster pixel.
  const toSource = scaleMatrix(sourceWidth / Math.max(1e-6, boxWidth), sourceHeight / Math.max(1e-6, boxHeight))
  return multiplyMatrices(toSource, multiplyMatrices(unwarp, toBox))
}

/**
 * Resamples `source` (RGBA, straight alpha) into a new raster through
 * `matrix` (warped pixel → source pixel). Each row's numerators step
 * linearly, so only the divide is per pixel.
 */
export function warpPixels(source: Uint8ClampedArray | Uint8Array, sourceWidth: number, sourceHeight: number, rasterWidth: number, rasterHeight: number, matrix: Matrix3): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rasterWidth * rasterHeight * 4)
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix
  const lastX = sourceWidth - 1
  const lastY = sourceHeight - 1
  for (let row = 0; row < rasterHeight; row += 1) {
    const py = row + 0.5
    let nx = m0 * 0.5 + m1 * py + m2
    let ny = m3 * 0.5 + m4 * py + m5
    let nw = m6 * 0.5 + m7 * py + m8
    let at = row * rasterWidth * 4
    for (let column = 0; column < rasterWidth; column += 1, nx += m0, ny += m3, nw += m6, at += 4) {
      if (nw <= 1e-12) continue
      // The source pixel whose centre is at the integer part, on a 1/65536 grid: the canvas and Main reach
      // the same point by slightly different sums, and a coverage right at a half must round the same way in both.
      const fx = Math.round((nx / nw - 0.5) * 65536) / 65536
      const fy = Math.round((ny / nw - 0.5) * 65536) / 65536
      if (fx <= -1 || fy <= -1 || fx >= sourceWidth || fy >= sourceHeight) continue
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const take = (x: number, y: number, weight: number): void => {
        if (weight <= 0 || x < 0 || y < 0 || x > lastX || y > lastY) return
        const index = (y * sourceWidth + x) * 4
        const alpha = source[index + 3]! * weight
        r += source[index]! * alpha
        g += source[index + 1]! * alpha
        b += source[index + 2]! * alpha
        a += alpha
      }
      take(x0, y0, (1 - tx) * (1 - ty))
      take(x0 + 1, y0, tx * (1 - ty))
      take(x0, y0 + 1, (1 - tx) * ty)
      take(x0 + 1, y0 + 1, tx * ty)
      if (a <= 0) continue
      out[at] = r / a
      out[at + 1] = g / a
      out[at + 2] = b / a
      out[at + 3] = a
    }
  }
  return out
}

/** A layer's box content (RGBA at sourceWidth × sourceHeight over the box) warped through its corners. */
export function warpLayerPixels(source: Uint8ClampedArray | Uint8Array, sourceWidth: number, sourceHeight: number, corners: Corners, boxWidth: number, boxHeight: number, ratio: number): { readonly layout: WarpLayout; readonly pixels: Uint8ClampedArray<ArrayBuffer> } {
  const layout = warpLayout(corners, boxWidth, boxHeight, ratio)
  const matrix = warpSourceMatrix(corners, boxWidth, boxHeight, layout, sourceWidth, sourceHeight)
  return { layout, pixels: warpPixels(source, sourceWidth, sourceHeight, layout.rasterWidth, layout.rasterHeight, matrix) }
}

/** Where a point of the box's content lands after its corners, in box pixels. */
export function warpedBoxPoint(corners: Corners, boxWidth: number, boxHeight: number, x: number, y: number): readonly [number, number] {
  return applyMatrix(boxWarpMatrix(corners, boxWidth, boxHeight), x, y)
}
