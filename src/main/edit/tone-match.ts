import sharp from 'sharp'
import type { ImageEffects, Scene, SceneElement } from '../../domain'
import { CompositeReferenceRenderer, type ReferenceAssetResolver } from '../reference/composite-reference-renderer'
import { subScene } from '../reference/sub-scene'
import { layersBelow } from './layer-in-context'
import { imageBytes } from '../storage/image-file'
import { paintedImageBytes } from '../paint/painted-image'

type ImageElement = Extract<SceneElement, { type: 'image' }>

/** How far around the image the picture beneath it is sampled, as a share of its size. */
const SURROUNDING = 0.25
const SAMPLE_EDGE = 256
const MAX_GAIN_CHANGE = 0.15
const MAX_OFFSET = 60

interface ChannelStats {
  readonly mean: readonly [number, number, number]
  readonly deviation: readonly [number, number, number]
}

function stats(data: Buffer, channels: number, weight: (index: number) => number): ChannelStats | null {
  const sums = [0, 0, 0]
  const squares = [0, 0, 0]
  let total = 0
  for (let index = 0; index < data.length; index += channels) {
    const w = weight(index)
    if (w <= 0) continue
    total += w
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[index + channel]!
      sums[channel]! += value * w
      squares[channel]! += value * value * w
    }
  }
  if (total < 16) return null
  const mean = sums.map((sum) => sum / total) as [number, number, number]
  const deviation = squares.map((square, channel) => Math.sqrt(Math.max(0, square / total - mean[channel]! ** 2))) as [number, number, number]
  return { mean, deviation }
}

export interface ToneMeasurement {
  readonly colorMatch: NonNullable<ImageEffects['colorMatch']>
  /** True when the image has no transparent pixels, such as a photo or a full-frame result. */
  readonly opaque: boolean
}

/**
 * The colour shift that moves an image part of the way towards the picture
 * around it: its average colour, and a little of its contrast. A strength of
 * 0 keeps the image as it is, 1 matches the averages fully; the image keeps
 * its own colours either way, only their cast and brightness move.
 */
export async function measureToneMatch(scene: Scene, element: ImageElement, resolveAsset: ReferenceAssetResolver, strength: number): Promise<ToneMeasurement | null> {
  const path = await resolveAsset(element.assetId)
  if (path === null) return null
  // Measured as it shows: with its paint, and only where its mask lets it through.
  const masked = element.mask !== null && element.mask !== undefined && element.mask.enabled
  const bytes = (element.paint?.length ?? 0) > 0 || masked ? await paintedImageBytes(path, element.paint, resolveAsset, element.mask ?? null) : await imageBytes(path)
  const metadata = await sharp(bytes).metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const layer = await sharp(bytes)
    .extract({
      left: Math.min(width - 1, Math.round(element.crop.x * width)),
      top: Math.min(height - 1, Math.round(element.crop.y * height)),
      width: Math.max(1, Math.min(width - Math.round(element.crop.x * width), Math.round(element.crop.width * width))),
      height: Math.max(1, Math.min(height - Math.round(element.crop.y * height), Math.round(element.crop.height * height)))
    })
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer()
  let opaque = true
  const layerStats = stats(layer, 4, (index) => {
    const alpha = layer[index + 3]! / 255
    if (alpha < 1) opaque = false
    return alpha < 0.1 ? 0 : alpha
  })

  const below = subScene(scene, layersBelow(scene, element))
  const rendered = await new CompositeReferenceRenderer(resolveAsset).render({ ...below, canvas: { ...below.canvas, transparent: false } }, 'final')
  const { outputWidth, outputHeight } = scene.canvas
  const t = element.transform
  const left = Math.max(0, Math.floor((t.x - t.width * SURROUNDING) * outputWidth))
  const top = Math.max(0, Math.floor((t.y - t.height * SURROUNDING) * outputHeight))
  const right = Math.min(outputWidth, Math.ceil((t.x + t.width * (1 + SURROUNDING)) * outputWidth))
  const bottom = Math.min(outputHeight, Math.ceil((t.y + t.height * (1 + SURROUNDING)) * outputHeight))
  if (layerStats === null || right - left < 4 || bottom - top < 4) return null
  const around = await sharp(rendered.buffer)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const aroundStats = stats(around, 3, () => 1)
  if (aroundStats === null) return null

  const gain = [0, 1, 2].map((channel) => {
    const own = layerStats.deviation[channel]!
    const ratio = own < 2 ? 1 : aroundStats.deviation[channel]! / own
    return Math.min(1 + MAX_GAIN_CHANGE, Math.max(1 - MAX_GAIN_CHANGE, 1 + strength * (ratio - 1)))
  }) as [number, number, number]
  const offset = [0, 1, 2].map((channel) => {
    const own = layerStats.mean[channel]!
    const target = own + strength * (aroundStats.mean[channel]! - own)
    return Math.round(Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, target - gain[channel]! * own)) * 10) / 10
  }) as [number, number, number]
  return { colorMatch: { gain: gain.map((value) => Math.round(value * 1000) / 1000) as [number, number, number], offset }, opaque }
}
