import { useMemo } from 'react'
import { Group, Line } from 'react-konva'
import { affineOf, boxWarpMatrix, cornersAreIdentity, cornersDrawnAsMatrix, decomposeAffine, type Corners } from '../../../domain'
import { IsolatedGroup } from './clip-stack'
import { warpedExtent, warpFilter, type WarpAttrs } from './warp-filter'

/*
 * A layer's content through its free-transform corners, inside the layer's
 * own (placed and turned) group. A flip, and a text's skew, is a matrix
 * Konva draws directly; anything else is drawn into a picture first and
 * resampled by the shared warp, so the canvas and the export match what
 * Main renders pixel for pixel. Styles go on around this, after the warp, as in Photoshop.
 */

/** The most pixels a warped layer is drawn into on the canvas. */
const WARP_PIXELS = 16_000_000

export function CornersLayer({ corners, text = false, width, height, ratio, maxPixels = WARP_PIXELS, children }: {
  readonly corners: Corners | null | undefined
  /** A text layer: its skew is drawn as a matrix, so the type stays crisp. */
  readonly text?: boolean
  /** The layer's box in the group's units. */
  readonly width: number
  readonly height: number
  /** Raster pixels per unit, for a distort or a perspective. */
  readonly ratio: number
  readonly maxPixels?: number
  readonly children: React.ReactNode
}): React.JSX.Element {
  const affine = useMemo(() => {
    if (cornersAreIdentity(corners) || !cornersDrawnAsMatrix(corners!, text)) return null
    return decomposeAffine(affineOf(boxWarpMatrix(corners!, width, height)))
  }, [corners, text, width, height])
  if (cornersAreIdentity(corners) || width <= 0 || height <= 0) return <>{children}</>
  if (affine !== null) return <Group {...affine}>{children}</Group>
  const extent = warpedExtent(corners, width, height)
  // The picture covers the box, where the content is drawn, and where the corners take it, with a pixel to spare.
  // On whole units, as Main lays its warped picture, so neither is resampled again where it lies.
  const pad = 1 / Math.max(1e-6, ratio)
  const left = Math.floor(Math.min(0, extent.x) - pad)
  const top = Math.floor(Math.min(0, extent.y) - pad)
  const rect = { x: left, y: top, width: Math.ceil(Math.max(width, extent.x + extent.width) + pad) - left, height: Math.ceil(Math.max(height, extent.y + extent.height) + pad) - top }
  const warp: WarpAttrs = { corners: corners!, boxWidth: width, boxHeight: height, rect }
  const quad = corners!.flatMap(([u, v]) => [u * width, v * height])
  return (
    <Group>
      {/* Clicks land on the shape as it is shown, not on the box it was drawn in. */}
      <Line points={quad} closed fill="rgba(0,0,0,0)" />
      <IsolatedGroup operation="source-over" pixelRatio={ratio} maxPixels={maxPixels} cacheRect={rect} listening={false} attrs={{ warp }} filters={[warpFilter]}>
        {children}
      </IsolatedGroup>
    </Group>
  )
}
