import type { FilterFunction } from 'konva/lib/Node'
import { boxWarpMatrix, cornersAreIdentity, invertMatrix, multiplyMatrices, scaleMatrix, type Corners, type SceneElement } from '../../../domain'
import { warpedBounds, warpPixels } from '../../../shared/warp'

/** What a warped group's filter needs: the corners, the box and the area its picture covers, in the group's units. */
export interface WarpAttrs {
  readonly corners: Corners
  readonly boxWidth: number
  readonly boxHeight: number
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/**
 * Resamples a group's cached picture through its free-transform corners, in
 * place: the picture covers both the box, where the content was drawn, and
 * where the corners take it. The same shared warp as the export and Main.
 */
export const warpFilter: FilterFunction = function (this: { getAttr(name: string): unknown }, imageData: ImageData): void {
  const warp = this.getAttr('warp') as WarpAttrs | undefined
  if (warp === undefined) return
  const { width, height, data } = imageData
  const sx = width / warp.rect.width
  const sy = height / warp.rect.height
  // Raster pixel → group units → before the corners → raster pixel.
  const toUnits = scaleMatrix(1 / sx, 1 / sy, warp.rect.x, warp.rect.y)
  const unwarp = invertMatrix(boxWarpMatrix(warp.corners, warp.boxWidth, warp.boxHeight))
  const toRaster = scaleMatrix(sx, sy, -warp.rect.x * sx, -warp.rect.y * sy)
  const warped = warpPixels(data.slice(), width, height, width, height, multiplyMatrices(toRaster, multiplyMatrices(unwarp, toUnits)))
  data.set(warped)
}

/** The content's extent after its corners, in the box's units, with `margin` units drawn past the box (a stroke's outer half); or the box itself. */
export function warpedExtent(corners: Corners | null | undefined, width: number, height: number, margin = 0): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  if (cornersAreIdentity(corners)) return { x: 0, y: 0, width, height }
  return warpedBounds(corners!, width, height, margin)
}

/**
 * How far a layer is drawn past its box, in the box's units: half a shape's
 * stroke, which is centred on its outline, and a pixel for its soft edge (as
 * ElementVisual draws it). Nothing for other layers.
 */
export function drawnMargin(element: SceneElement, width: number, height: number): number {
  if (element.type !== 'shape') return 0
  const stroke = element.strokeWidth * Math.min(width, height)
  const drawn = element.shape === 'line' ? Math.max(1, stroke) : element.stroke === null ? 0 : stroke
  return drawn > 0 ? Math.ceil(drawn / 2) + 1 : 0
}
