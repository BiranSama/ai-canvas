import sharp from 'sharp'
import { z } from 'zod'
import type { NormalizedTransform, Scene, SceneElement } from '../../domain'

/** A pixel rectangle on the canvas at its output size. */
export interface PixelBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where an element is redrawn in place: its own box, and around it a band the
 * model may also paint, so the new content fades into what is below.
 */
export interface LayerRegion {
  readonly canvasWidth: number
  readonly canvasHeight: number
  readonly core: PixelBox
  readonly expanded: PixelBox
}

const pixelBoxSchema = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})

const layerJobSchema = z.object({
  mode: z.literal('layer-in-context'),
  targetElementId: z.string().min(1),
  sourceAssetId: z.string().min(1),
  layerRegion: z.object({
    canvasWidth: z.number().int().positive(),
    canvasHeight: z.number().int().positive(),
    core: pixelBoxSchema,
    expanded: pixelBoxSchema
  })
})

/** What an in-context job recorded at submit time; null for every other job. */
export function inContextLayerJob(parameters: Readonly<Record<string, unknown>>): {
  readonly targetElementId: string
  readonly sourceAssetId: string
  readonly region: LayerRegion
} | null {
  const parsed = layerJobSchema.safeParse(parameters)
  return parsed.success ? { targetElementId: parsed.data.targetElementId, sourceAssetId: parsed.data.sourceAssetId, region: parsed.data.layerRegion } : null
}

const BAND_SHARE = 0.12
const MIN_BAND_PX = 12
const MAX_BAND_SHARE_OF_CANVAS = 0.06
const MAX_GAIN = 1.25
const MAX_OFFSET = 40

function corners(transform: NormalizedTransform): readonly { x: number; y: number }[] {
  const { x, y, width, height, rotation } = transform
  const cx = x + width / 2
  const cy = y + height / 2
  const radians = rotation * Math.PI / 180
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => ({
    x: cx + (px! - cx) * Math.cos(radians) - (py! - cy) * Math.sin(radians),
    y: cy + (px! - cx) * Math.sin(radians) + (py! - cy) * Math.cos(radians)
  }))
}

/** The element's box on the canvas, in pixels, and the band around it; null when it is off the canvas. */
export function layerRegion(scene: Scene, element: SceneElement): LayerRegion | null {
  const width = scene.canvas.outputWidth
  const height = scene.canvas.outputHeight
  const points = corners(element.transform)
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x)) * width))
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y)) * height))
  const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x)) * width))
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y)) * height))
  if (right - left < 8 || bottom - top < 8) return null
  const band = Math.max(1, Math.min(
    Math.round(MAX_BAND_SHARE_OF_CANVAS * Math.min(width, height)),
    Math.max(MIN_BAND_PX, Math.round(BAND_SHARE * Math.min(right - left, bottom - top)))
  ))
  const expandedLeft = Math.max(0, left - band)
  const expandedTop = Math.max(0, top - band)
  return {
    canvasWidth: width,
    canvasHeight: height,
    core: { left, top, width: right - left, height: bottom - top },
    expanded: {
      left: expandedLeft,
      top: expandedTop,
      width: Math.min(width, right + band) - expandedLeft,
      height: Math.min(height, bottom + band) - expandedTop
    }
  }
}

/** The region's band as a normalized transform, for the element that receives the new image. */
export function regionTransform(region: LayerRegion): NormalizedTransform {
  return {
    x: region.expanded.left / region.canvasWidth,
    y: region.expanded.top / region.canvasHeight,
    width: region.expanded.width / region.canvasWidth,
    height: region.expanded.height / region.canvasHeight,
    rotation: 0
  }
}

/** The ids of the layers drawn beneath an element: the picture it has to sit in. */
export function layersBelow(scene: Scene, element: SceneElement): ReadonlySet<string> {
  return new Set(scene.elements.filter((candidate) => candidate.zIndex < element.zIndex).map((candidate) => candidate.id))
}

/** White where the model may paint (the element's box and band), black elsewhere, one channel. */
export async function regionMask(region: LayerRegion): Promise<Buffer> {
  const { canvasWidth: width, canvasHeight: height, expanded } = region
  const pixels = Buffer.alloc(width * height)
  for (let y = expanded.top; y < expanded.top + expanded.height; y += 1) {
    pixels.fill(255, y * width + expanded.left, y * width + expanded.left + expanded.width)
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer()
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

interface ChannelMatch {
  readonly gain: number
  readonly offset: number
}

/**
 * Per channel, the gain and offset that bring the model's band back to the
 * picture that was there: what the model changed outside the element is
 * drift in brightness and colour, and the same correction applies inside.
 */
function bandMatch(result: Buffer, source: Buffer, region: LayerRegion): readonly ChannelMatch[] {
  const { expanded, core } = region
  const sums = [0, 1, 2].map(() => ({ count: 0, result: 0, resultSquares: 0, source: 0, sourceSquares: 0 }))
  for (let y = 0; y < expanded.height; y += 1) {
    const canvasY = expanded.top + y
    for (let x = 0; x < expanded.width; x += 1) {
      const canvasX = expanded.left + x
      const inCore = canvasX >= core.left && canvasX < core.left + core.width && canvasY >= core.top && canvasY < core.top + core.height
      if (inCore) continue
      const index = (y * expanded.width + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const r = result[index + channel]!
        const s = source[index + channel]!
        const sum = sums[channel]!
        sum.count += 1
        sum.result += r
        sum.resultSquares += r * r
        sum.source += s
        sum.sourceSquares += s * s
      }
    }
  }
  return sums.map((sum) => {
    if (sum.count < 16) return { gain: 1, offset: 0 }
    const resultMean = sum.result / sum.count
    const sourceMean = sum.source / sum.count
    const resultDeviation = Math.sqrt(Math.max(0, sum.resultSquares / sum.count - resultMean ** 2))
    const sourceDeviation = Math.sqrt(Math.max(0, sum.sourceSquares / sum.count - sourceMean ** 2))
    const gain = resultDeviation < 2 ? 1 : Math.min(MAX_GAIN, Math.max(1 / MAX_GAIN, sourceDeviation / resultDeviation))
    const offset = Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, sourceMean - gain * resultMean))
    return { gain, offset }
  })
}

/**
 * Cuts the redrawn region out of a whole-canvas result: matched in colour to
 * the picture around it, fully opaque over the element's box and fading to
 * transparent across the band, except on sides where the band meets the
 * canvas edge.
 */
export async function extractLayer(resultBytes: Buffer, sourceBytes: Buffer, region: LayerRegion): Promise<Buffer> {
  const { canvasWidth: width, canvasHeight: height, expanded, core } = region
  const crop = (bytes: Buffer) => sharp(bytes)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .extract({ left: expanded.left, top: expanded.top, width: expanded.width, height: expanded.height })
    .raw()
    .toBuffer()
  const [result, source] = await Promise.all([crop(resultBytes), crop(sourceBytes)])
  const match = bandMatch(result, source, region)
  const bandLeft = core.left - expanded.left
  const bandTop = core.top - expanded.top
  const bandRight = expanded.left + expanded.width - (core.left + core.width)
  const bandBottom = expanded.top + expanded.height - (core.top + core.height)
  const output = Buffer.alloc(expanded.width * expanded.height * 4)
  for (let y = 0; y < expanded.height; y += 1) {
    for (let x = 0; x < expanded.width; x += 1) {
      const ramps = [
        bandLeft > 0 ? (x + 0.5) / bandLeft : 1,
        bandTop > 0 ? (y + 0.5) / bandTop : 1,
        bandRight > 0 ? (expanded.width - x - 0.5) / bandRight : 1,
        bandBottom > 0 ? (expanded.height - y - 0.5) / bandBottom : 1
      ]
      const from = (y * expanded.width + x) * 3
      const to = (y * expanded.width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const { gain, offset } = match[channel]!
        output[to + channel] = Math.max(0, Math.min(255, Math.round(result[from + channel]! * gain + offset)))
      }
      output[to + 3] = Math.round(255 * smoothstep(Math.min(...ramps)))
    }
  }
  return sharp(output, { raw: { width: expanded.width, height: expanded.height, channels: 4 } }).png().toBuffer()
}
