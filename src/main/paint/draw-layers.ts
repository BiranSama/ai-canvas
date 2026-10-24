import sharp from 'sharp'
import type { NormalizedTransform, Scene } from '../../domain'
import { CompositeReferenceRenderer, type ReferenceAssetResolver } from '../reference/composite-reference-renderer'

export interface DrawnLayers {
  /** PNG of what the layers cover, cut to the pixels that are not fully transparent. */
  readonly bytes: Buffer
  /** Where those pixels sit on the canvas. */
  readonly transform: NormalizedTransform
}

/**
 * Some layers drawn as the final picture shows them, alone on a
 * transparent canvas, for merging and rasterizing from the agent. The base
 * layer, if any, is drawn at full opacity and normal blend, because the
 * result keeps its own opacity and blend.
 */
export async function drawLayers(scene: Scene, elementIds: readonly string[], base: string | undefined, resolveAsset: ReferenceAssetResolver): Promise<DrawnLayers> {
  const keep = new Set(elementIds)
  const elements = scene.elements
    .filter((element) => keep.has(element.id))
    .map((element, index) => ({
      ...element,
      zIndex: index,
      groupId: null,
      visible: true,
      ...(element.id === base ? { opacity: 1, blendMode: 'normal' as const } : {})
    }))
  const alone: Scene = { ...scene, canvas: { ...scene.canvas, transparent: true }, elements, relations: [] }
  const rendered = await new CompositeReferenceRenderer(resolveAsset).render(alone, 'final')
  const { data, info } = await sharp(rendered.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let right = -1
  let top = info.height
  let bottom = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      bottom = y
    }
  }
  // Nothing drawn keeps the whole canvas, as a blank layer does.
  const area = right < 0 ? { left: 0, top: 0, width: info.width, height: info.height } : { left, top, width: right - left + 1, height: bottom - top + 1 }
  const bytes = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract(area).png().toBuffer()
  return {
    bytes,
    transform: { x: area.left / info.width, y: area.top / info.height, width: area.width / info.width, height: area.height / info.height, rotation: 0 }
  }
}

/** A fully transparent PNG, for a new layer to paint on. */
export function blankLayerBytes(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
}
