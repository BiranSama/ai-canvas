import type Konva from 'konva'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Group, Image as KonvaImage } from 'react-konva'
import type { BlendMode, SceneElement } from '../../../domain'
import { blendModeToCanvasOperation } from '../../../shared/blend-mode'
import { applyLayerStyles, hasLayerStyles, styledLayerReach } from '../../../shared/layer-styles'
import { assetPixelsVersion, subscribeAssetPixels } from './asset-pixels'
import { pixelLayerVersion, subscribePixelLayers } from './pixel-layers'

/*
 * A layer with its layer styles, as the canvas and the export stage draw it:
 * its content is cached into a raster padded for the styles' reach, the
 * shared style math changes that raster in place (stroke, overlays, inner
 * shadow) and gives what lies under it (drop shadow, outer glow), which are
 * drawn beneath in their own blend modes. The content keeps the layer's own
 * blend mode, so the layer's group must not set one itself.
 */

/** The most pixels a styled layer is worked out at. */
const STYLE_PIXELS = 16_000_000

interface CacheEntry {
  readonly scene: { readonly _canvas: HTMLCanvasElement }
}

/** Konva's cached picture of a group: its own canvas, which the styles are drawn into. */
function cachedCanvas(group: Konva.Group): HTMLCanvasElement | null {
  const cache = (group as unknown as { readonly _cache: Map<string, CacheEntry | undefined> })._cache.get('canvas')
  return cache?.scene._canvas ?? null
}

function sized(canvas: HTMLCanvasElement | null, width: number, height: number): HTMLCanvasElement {
  const target = canvas ?? document.createElement('canvas')
  target.width = width
  target.height = height
  return target
}

export function StyledLayer({ element, width, height, unit, ratio, rotation, blend, contentKey, children }: {
  readonly element: Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>
  /** The layer's box in its own units. */
  readonly width: number
  readonly height: number
  /** Box units in one output pixel: 1 on the canvas, the export's scale on the export stage. */
  readonly unit: number
  /** Raster pixels per box unit: the screen's resolution on the canvas, 1 for an export. */
  readonly ratio: number
  /** The layer's turn, so its shadow falls the picture's way. */
  readonly rotation: number
  /** The layer's own blend mode, for its content. */
  readonly blend: BlendMode
  /** Changes whenever what the children draw changes, so the styles are worked out again. */
  readonly contentKey: unknown
  readonly children: React.ReactNode
}): React.JSX.Element {
  const content = useRef<Konva.Group>(null)
  const shadow = useRef<Konva.Image>(null)
  const glow = useRef<Konva.Image>(null)
  const canvases = useRef<{ dropShadow: HTMLCanvasElement | null; outerGlow: HTMLCanvasElement | null }>({ dropShadow: null, outerGlow: null })
  // Paint on a mask and pixels read later change the content without a new element.
  const elementId = element.id
  const style = element.style ?? {}
  const paintVersion = useSyncExternalStore(subscribePixelLayers, () => pixelLayerVersion(elementId), () => pixelLayerVersion(elementId))
  const pixelsVersion = useSyncExternalStore(subscribeAssetPixels, assetPixelsVersion, assetPixelsVersion)
  const active = hasLayerStyles(style)
  const reach = active ? styledLayerReach(element, width / unit, height / unit) * unit : 0
  const fit = Math.min(ratio, Math.sqrt(STYLE_PIXELS / Math.max(1, (width + reach * 2) * (height + reach * 2))))
  const styleKey = JSON.stringify(style)

  useLayoutEffect(() => {
    const group = content.current
    if (group === null) return
    group.clearCache()
    shadow.current?.visible(false)
    glow.current?.visible(false)
    if (!active || width <= 0 || height <= 0) { group.getLayer()?.batchDraw(); return }
    group.cache({ x: -reach, y: -reach, width: width + reach * 2, height: height + reach * 2, pixelRatio: fit })
    const raster = cachedCanvas(group)
    const context = raster?.getContext('2d', { willReadFrequently: true }) ?? null
    if (raster === null || context === null || raster.width === 0 || raster.height === 0) return
    const pixels = context.getImageData(0, 0, raster.width, raster.height)
    // The raster may hold a pixel or two more than asked for; the box sits at the padding.
    const scaleX = raster.width / (width + reach * 2)
    const scaleY = raster.height / (height + reach * 2)
    const box = { x: reach * scaleX, y: reach * scaleY, width: width * scaleX, height: height * scaleY, rasterWidth: raster.width, rasterHeight: raster.height }
    const result = applyLayerStyles(pixels.data, box, style, scaleX * unit, rotation)
    context.putImageData(pixels, 0, 0)
    for (const under of result.under) {
      const node = under.kind === 'dropShadow' ? shadow.current : glow.current
      if (node === null) continue
      const canvas = sized(canvases.current[under.kind], raster.width, raster.height)
      canvases.current[under.kind] = canvas
      canvas.getContext('2d')?.putImageData(new ImageData(under.pixels, raster.width, raster.height), 0, 0)
      node.image(canvas)
      node.position({ x: -reach, y: -reach })
      node.size({ width: width + reach * 2, height: height + reach * 2 })
      node.globalCompositeOperation(blendModeToCanvasOperation(under.blendMode))
      node.visible(true)
    }
    group.getLayer()?.batchDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- worked out again only when what it draws or how it is styled changes
  }, [contentKey, styleKey, width, height, reach, fit, unit, rotation, paintVersion, pixelsVersion, active])

  const operation = blendModeToCanvasOperation(blend)
  return (
    <Group>
      <KonvaImage ref={shadow} image={undefined} visible={false} listening={false} />
      <KonvaImage ref={glow} image={undefined} visible={false} listening={false} />
      <Group ref={content} {...(operation === 'source-over' ? {} : { globalCompositeOperation: operation })}>{children}</Group>
    </Group>
  )
}
