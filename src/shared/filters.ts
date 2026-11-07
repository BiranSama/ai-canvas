import type { FilterKind, FilterSettings } from '../domain'

/*
 * The pixel math of the filters a layer can carry, shared by the canvas,
 * the offscreen export renderer and Main's composite renderer. Pixels are
 * RGBA, not premultiplied. Sizes are given in output pixels; scale says how
 * many of the pixels being worked on make one output pixel, so the canvas
 * can work at the screen's resolution and still blur by the same amount.
 * Past the layer's box the picture is taken to go on as its edge pixels, so
 * a blur never fades the box's edges to transparent.
 */

type Pixels = Uint8Array | Uint8ClampedArray

export const FILTER_LABELS: Readonly<Record<FilterKind, string>> = {
  'gaussian-blur': '高斯模糊',
  'unsharp-mask': 'USM 锐化',
  'add-noise': '添加杂色',
  'motion-blur': '动感模糊'
}

export function defaultFilter(kind: FilterKind): FilterSettings {
  switch (kind) {
    case 'gaussian-blur': return { kind, radius: 5 }
    case 'unsharp-mask': return { kind, amount: 100, radius: 1, threshold: 0 }
    case 'add-noise': return { kind, amount: 10, distribution: 'gaussian', monochromatic: false, seed: 1 }
    case 'motion-blur': return { kind, angle: 0, distance: 10 }
  }
}

/** A short description of the settings, such as 高斯模糊（半径 5 像素）. */
export function describeFilter(settings: FilterSettings): string {
  switch (settings.kind) {
    case 'gaussian-blur': return `高斯模糊（半径 ${settings.radius} 像素）`
    case 'unsharp-mask': return `USM 锐化（数量 ${settings.amount}%，半径 ${settings.radius} 像素，阈值 ${settings.threshold}）`
    case 'add-noise': return `添加杂色（${settings.amount}%，${settings.distribution === 'gaussian' ? '高斯分布' : '平均分布'}${settings.monochromatic ? '，单色' : ''}）`
    case 'motion-blur': return `动感模糊（角度 ${settings.angle}°，距离 ${settings.distance} 像素）`
  }
}

/** Whether the filter changes nothing at these settings. */
export function isNeutralFilter(settings: FilterSettings): boolean {
  switch (settings.kind) {
    case 'gaussian-blur': return settings.radius <= 0
    case 'unsharp-mask': return settings.amount <= 0 || settings.radius <= 0
    case 'add-noise': return settings.amount <= 0
    case 'motion-blur': return settings.distance < 1
  }
}

/** Whether the filter looks at neighbouring pixels, so a mask must come after it rather than before. */
export function isSpatialFilter(settings: FilterSettings): boolean {
  return settings.kind !== 'add-noise'
}

// ---- Blurs ----

/** Three box widths whose passes together blur like a Gaussian of this sigma. */
function boxesForGauss(sigma: number): readonly number[] {
  const ideal = Math.sqrt(12 * sigma * sigma / 3 + 1)
  let lower = Math.floor(ideal)
  if (lower % 2 === 0) lower -= 1
  const upper = lower + 2
  const count = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4))
  return [0, 1, 2].map((index) => (index < count ? lower : upper))
}

/** One box pass along rows (or columns, with the strides swapped), edges extended. */
function boxPass(source: Float32Array, target: Float32Array, length: number, lines: number, step: number, lineStep: number, radius: number): void {
  const span = radius * 2 + 1
  for (let line = 0; line < lines; line += 1) {
    const start = line * lineStep
    const at = (index: number): number => source[start + Math.min(length - 1, Math.max(0, index)) * step]!
    let sum = 0
    for (let index = -radius; index <= radius; index += 1) sum += at(index)
    for (let index = 0; index < length; index += 1) {
      target[start + index * step] = sum / span
      sum += at(index + radius + 1) - at(index - radius)
    }
  }
}

/** Blurs one channel of floats in place, Gaussian of this sigma in pixels, edges extended. */
export function blurChannel(channel: Float32Array, width: number, height: number, sigma: number): void {
  if (sigma < 0.2 || width === 0 || height === 0) return
  const temp = new Float32Array(channel.length)
  for (const box of boxesForGauss(sigma)) {
    const radius = Math.max(0, (box - 1) / 2)
    if (radius === 0) continue
    boxPass(channel, temp, width, height, 1, width, radius)
    boxPass(temp, channel, height, width, width, 1, radius)
  }
}

/** The four channels premultiplied by alpha, one array each, so colour does not bleed out of transparent pixels. */
function premultiplied(data: Pixels, pixels: number): Float32Array[] {
  const channels = [0, 1, 2, 3].map(() => new Float32Array(pixels))
  for (let pixel = 0, index = 0; pixel < pixels; pixel += 1, index += 4) {
    const alpha = data[index + 3]!
    channels[3]![pixel] = alpha
    channels[0]![pixel] = data[index]! * alpha / 255
    channels[1]![pixel] = data[index + 1]! * alpha / 255
    channels[2]![pixel] = data[index + 2]! * alpha / 255
  }
  return channels
}

function unpremultiply(channels: readonly Float32Array[], target: Pixels): void {
  const [red, green, blue, alpha] = channels as [Float32Array, Float32Array, Float32Array, Float32Array]
  for (let pixel = 0, index = 0; pixel < alpha.length; pixel += 1, index += 4) {
    const a = alpha[pixel]!
    if (a <= 0.01) { target[index] = 0; target[index + 1] = 0; target[index + 2] = 0; target[index + 3] = 0; continue }
    target[index] = Math.round(Math.min(255, red[pixel]! * 255 / a))
    target[index + 1] = Math.round(Math.min(255, green[pixel]! * 255 / a))
    target[index + 2] = Math.round(Math.min(255, blue[pixel]! * 255 / a))
    target[index + 3] = Math.round(Math.min(255, a))
  }
}

/** A Gaussian blur of the picture, sigma in pixels, written to target. */
function gaussianBlur(data: Pixels, width: number, height: number, sigma: number, target: Pixels): void {
  const channels = premultiplied(data, width * height)
  for (const channel of channels) blurChannel(channel, width, height, sigma)
  unpremultiply(channels, target)
}

/** One channel sampled between pixels, bilinearly, edges extended. */
function sample(channel: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(width - 1, Math.max(0, x))
  const cy = Math.min(height - 1, Math.max(0, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const top = channel[y0 * width + x0]! * (1 - fx) + channel[y0 * width + x1]! * fx
  const bottom = channel[y1 * width + x0]! * (1 - fx) + channel[y1 * width + x1]! * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * Averages along a line through each pixel, this long in pixels, at this
 * angle (degrees, counter-clockwise from the x axis as Photoshop's dialog
 * has it). Done by halving: each pass averages two copies a doubling step
 * apart, so after k passes each pixel is the mean of 2^k points spread over
 * the line, at a cost that grows with the log of its length.
 */
function motionBlur(data: Pixels, width: number, height: number, angle: number, length: number, target: Pixels): void {
  const channels = premultiplied(data, width * height)
  const passes = Math.max(1, Math.ceil(Math.log2(length)))
  const step = length / 2 ** passes
  const dx = Math.cos(angle * Math.PI / 180)
  const dy = -Math.sin(angle * Math.PI / 180)
  const next = new Float32Array(width * height)
  for (const channel of channels) {
    for (let pass = 0; pass < passes; pass += 1) {
      const half = step * 2 ** pass / 2
      const ox = dx * half
      const oy = dy * half
      for (let y = 0, pixel = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1, pixel += 1) {
          next[pixel] = (sample(channel, width, height, x - ox, y - oy) + sample(channel, width, height, x + ox, y + oy)) / 2
        }
      }
      channel.set(next)
    }
  }
  unpremultiply(channels, target)
}

// ---- Sharpening and noise ----

function unsharpMask(data: Pixels, width: number, height: number, settings: Extract<FilterSettings, { kind: 'unsharp-mask' }>, sigma: number, target: Pixels): void {
  const blurred = new Uint8ClampedArray(data.length)
  gaussianBlur(data, width, height, sigma, blurred)
  const amount = settings.amount / 100
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const original = data[index + channel]!
      const difference = original - blurred[index + channel]!
      target[index + channel] = Math.abs(difference) >= settings.threshold && difference !== 0 ? Math.max(0, Math.min(255, Math.round(original + difference * amount))) : original
    }
    target[index + 3] = data[index + 3]!
  }
}

/** A number in [0, 1) fixed by the pixel, the channel and the seed, so the grain is the same wherever it is drawn. */
function hash(x: number, y: number, channel: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(channel + 1, 0x9e3779b9) ^ Math.imul(seed, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4_294_967_296
}

function noise(x: number, y: number, channel: number, settings: Extract<FilterSettings, { kind: 'add-noise' }>): number {
  const spread = settings.amount / 100 * 127.5
  if (settings.distribution === 'uniform') return (hash(x, y, channel, settings.seed) * 2 - 1) * spread
  // Box–Muller from two numbers fixed by the pixel.
  const u = Math.max(1e-7, hash(x, y, channel, settings.seed))
  const v = hash(x, y, channel + 7, settings.seed)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * spread / 2
}

function addNoise(data: Pixels, width: number, height: number, settings: Extract<FilterSettings, { kind: 'add-noise' }>, scale: number, target: Pixels): void {
  for (let y = 0, index = 0; y < height; y += 1) {
    // The grain belongs to the output pixel this pixel lies in.
    const oy = Math.floor((y + 0.5) / scale)
    for (let x = 0; x < width; x += 1, index += 4) {
      target[index + 3] = data[index + 3]!
      if (data[index + 3] === 0) { target[index] = data[index]!; target[index + 1] = data[index + 1]!; target[index + 2] = data[index + 2]!; continue }
      const ox = Math.floor((x + 0.5) / scale)
      for (let channel = 0; channel < 3; channel += 1) {
        const offset = noise(ox, oy, settings.monochromatic ? 0 : channel, settings)
        target[index + channel] = Math.max(0, Math.min(255, Math.round(data[index + channel]! + offset)))
      }
    }
  }
}

export interface FilterOptions {
  /** Pixels worked on per output pixel; 1 at the export's own size. */
  readonly scale?: number
  /** How much of the filter each pixel takes, one byte a pixel: the selection it was made in. */
  readonly coverage?: Uint8Array | Uint8ClampedArray | null
}

/** Applies one filter to the picture in place. */
export function applyFilter(data: Pixels, width: number, height: number, settings: FilterSettings, options: FilterOptions = {}): void {
  if (isNeutralFilter(settings) || width === 0 || height === 0) return
  const scale = options.scale ?? 1
  const result = new Uint8ClampedArray(data.length)
  switch (settings.kind) {
    case 'gaussian-blur': gaussianBlur(data, width, height, settings.radius * scale, result); break
    case 'unsharp-mask': unsharpMask(data, width, height, settings, settings.radius * scale, result); break
    case 'add-noise': addNoise(data, width, height, settings, scale, result); break
    case 'motion-blur': {
      const length = settings.distance * scale
      if (length < 1) return
      motionBlur(data, width, height, settings.angle, length, result)
      break
    }
  }
  const coverage = options.coverage ?? null
  if (coverage === null) { data.set(result); return }
  for (let pixel = 0, index = 0; pixel < coverage.length; pixel += 1, index += 4) {
    const weight = coverage[pixel]! / 255
    if (weight <= 0) continue
    for (let channel = 0; channel < 4; channel += 1) {
      const original = data[index + channel]!
      data[index + channel] = Math.round(original + (result[index + channel]! - original) * weight)
    }
  }
}
