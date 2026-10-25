import type { PaintOp } from '../domain'

/*
 * The pixel math of painting on an image layer, shared by the canvas (live
 * strokes and replays) and Main (references, baking), so what is painted is
 * what is exported. Pixels are straight-alpha RGBA in the layer's own pixel
 * space. Everything here is deterministic: the same operations over the
 * same pixels give the same bytes in the Renderer and in Main.
 */

type Pixels = Uint8Array | Uint8ClampedArray
type StrokeOp = Extract<PaintOp, { kind: 'stroke' }>
/** One coverage value per pixel, 0–255: how much of an operation reaches that pixel. */
export type ClipPixels = ArrayLike<number>
/** The clips the operations refer to, by asset id. */
export type ClipLookup = ReadonlyMap<string, ClipPixels>
type Rgb = readonly [number, number, number]

export interface PixelRect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

const TILE = 64

function hexRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function clampByte(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
}

/** Source-over of a colour at alpha a onto the pixel at index, or with lockAlpha only its colour moves. */
function paintPixel(pixels: Pixels, index: number, orig: Pixels, origIndex: number, rgb: Rgb, a: number, lockAlpha: boolean): void {
  const dr = orig[origIndex]!
  const dg = orig[origIndex + 1]!
  const db = orig[origIndex + 2]!
  const da = orig[origIndex + 3]! / 255
  if (lockAlpha) {
    if (da <= 0) {
      pixels[index] = dr; pixels[index + 1] = dg; pixels[index + 2] = db; pixels[index + 3] = 0
      return
    }
    pixels[index] = clampByte(dr + (rgb[0] - dr) * a)
    pixels[index + 1] = clampByte(dg + (rgb[1] - dg) * a)
    pixels[index + 2] = clampByte(db + (rgb[2] - db) * a)
    pixels[index + 3] = orig[origIndex + 3]!
    return
  }
  const outA = a + da * (1 - a)
  if (outA <= 0) {
    pixels[index] = dr; pixels[index + 1] = dg; pixels[index + 2] = db; pixels[index + 3] = 0
    return
  }
  const keep = da * (1 - a)
  pixels[index] = clampByte((rgb[0] * a + dr * keep) / outA)
  pixels[index + 1] = clampByte((rgb[1] * a + dg * keep) / outA)
  pixels[index + 2] = clampByte((rgb[2] * a + db * keep) / outA)
  pixels[index + 3] = clampByte(outA * 255)
}

interface Tile {
  /** The pixels as they were before the stroke reached this tile. */
  readonly orig: Uint8ClampedArray
  /** How much of the stroke has built up on each pixel, 0–1. */
  readonly coverage: Float32Array
}

/**
 * One brush or eraser stroke, built dab by dab. Flow builds up coverage on a
 * pixel with every dab that passes; opacity caps what the whole stroke can
 * reach, as in Photoshop. The pixels a stroke has touched keep their
 * original value in tiles, so the result can be recomposited as the stroke
 * grows. Feeding the same points gives the same pixels whether it is drawn
 * live or replayed.
 */
export class StrokeRasterizer {
  readonly #pixels: Pixels
  readonly #width: number
  readonly #height: number
  readonly #op: Omit<StrokeOp, 'points' | 'id'>
  readonly #rgb: Rgb
  readonly #clip: ClipPixels | null
  readonly #tiles = new Map<number, Tile>()
  #last: { x: number, y: number, p: number } | null = null
  /** Distance travelled since the last dab, carried across points. */
  #carry = 0

  /** clip limits the stroke to a selection, as Photoshop's painting tools are. */
  constructor(pixels: Pixels, width: number, height: number, op: Omit<StrokeOp, 'points' | 'id'>, clip: ClipPixels | null = null) {
    this.#pixels = pixels
    this.#width = width
    this.#height = height
    this.#op = op
    this.#rgb = hexRgb(op.color)
    this.#clip = clip
  }

  #tile(tx: number, ty: number): Tile {
    const key = ty * 1_000_000 + tx
    let tile = this.#tiles.get(key)
    if (tile !== undefined) return tile
    const orig = new Uint8ClampedArray(TILE * TILE * 4)
    for (let row = 0; row < TILE; row += 1) {
      const y = ty * TILE + row
      if (y >= this.#height) break
      const width = Math.min(TILE, this.#width - tx * TILE)
      const start = (y * this.#width + tx * TILE) * 4
      orig.set(this.#pixels.subarray(start, start + width * 4), row * TILE * 4)
    }
    tile = { orig, coverage: new Float32Array(TILE * TILE) }
    this.#tiles.set(key, tile)
    return tile
  }

  #radius(pressure: number): number {
    const size = this.#op.pressure ? this.#op.size * Math.max(0.05, pressure) : this.#op.size
    return Math.max(0.25, size / 2)
  }

  /** Lays one dab and recomposites the pixels under it; returns what changed. */
  #dab(cx: number, cy: number, pressure: number): PixelRect | null {
    const radius = this.#radius(pressure)
    const flow = this.#op.flow * (this.#op.pressure ? Math.max(0, Math.min(1, pressure)) : 1)
    const x0 = Math.max(0, Math.floor(cx - radius - 1))
    const y0 = Math.max(0, Math.floor(cy - radius - 1))
    const x1 = Math.min(this.#width, Math.ceil(cx + radius + 1))
    const y1 = Math.min(this.#height, Math.ceil(cy + radius + 1))
    if (x0 >= x1 || y0 >= y1 || flow <= 0) return null
    const inner = radius * this.#op.hardness
    const softWidth = radius - inner
    for (let y = y0; y < y1; y += 1) {
      const dy = y + 0.5 - cy
      for (let x = x0; x < x1; x += 1) {
        const dx = x + 0.5 - cx
        const distance = Math.sqrt(dx * dx + dy * dy)
        // A one-pixel antialiased rim, softened inwards by (1 − hardness) of the radius.
        let falloff = Math.min(1, Math.max(0, radius - distance + 0.5))
        if (falloff <= 0) continue
        if (softWidth > 0 && distance > inner) {
          const t = Math.min(1, (distance - inner) / softWidth)
          falloff = Math.min(falloff, 1 - t * t * (3 - 2 * t))
        }
        const amount = falloff * flow
        if (amount <= 0) continue
        const tile = this.#tile(x >> 6, y >> 6)
        const local = (y & 63) * TILE + (x & 63)
        const current = tile.coverage[local]!
        tile.coverage[local] = current + amount * (1 - current)
      }
    }
    const rect = { x0, y0, x1, y1 }
    this.#composite(rect)
    return rect
  }

  #composite(rect: PixelRect): void {
    const { tool, opacity, lockAlpha } = this.#op
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        const tile = this.#tiles.get((y >> 6) * 1_000_000 + (x >> 6))
        if (tile === undefined) continue
        const local = (y & 63) * TILE + (x & 63)
        const coverage = tile.coverage[local]!
        if (coverage <= 0) continue
        const a = Math.min(1, coverage) * opacity * (this.#clip === null ? 1 : this.#clip[y * this.#width + x]! / 255)
        const index = (y * this.#width + x) * 4
        const origIndex = local * 4
        if (tool === 'eraser' && !lockAlpha) {
          this.#pixels[index] = tile.orig[origIndex]!
          this.#pixels[index + 1] = tile.orig[origIndex + 1]!
          this.#pixels[index + 2] = tile.orig[origIndex + 2]!
          this.#pixels[index + 3] = clampByte(tile.orig[origIndex + 3]! * (1 - a))
        } else {
          // An eraser on a transparency-locked layer paints its colour, the background colour, as in Photoshop.
          paintPixel(this.#pixels, index, tile.orig, origIndex, this.#rgb, a, lockAlpha)
        }
      }
    }
  }

  /**
   * Continues the stroke to this point, laying dabs every quarter of the
   * brush diameter along the way. Returns the rectangle of pixels that
   * changed, or null.
   */
  addPoint(x: number, y: number, pressure = 1): PixelRect | null {
    let changed: PixelRect | null = null
    const grow = (rect: PixelRect | null): void => {
      if (rect === null) return
      changed = changed === null ? rect : { x0: Math.min(changed.x0, rect.x0), y0: Math.min(changed.y0, rect.y0), x1: Math.max(changed.x1, rect.x1), y1: Math.max(changed.y1, rect.y1) }
    }
    const last = this.#last
    if (last === null) {
      grow(this.#dab(x, y, pressure))
      this.#last = { x, y, p: pressure }
      return changed
    }
    const dx = x - last.x
    const dy = y - last.y
    const length = Math.sqrt(dx * dx + dy * dy)
    let travelled = 0
    while (length > 0) {
      const t = Math.min(1, travelled / length)
      const p = last.p + (pressure - last.p) * t
      const spacing = Math.max(0.5, this.#radius(p) * 2 * 0.25)
      const next = spacing - this.#carry
      if (travelled + next > length) {
        this.#carry += length - travelled
        break
      }
      travelled += next
      this.#carry = 0
      const at = travelled / length
      grow(this.#dab(last.x + dx * at, last.y + dy * at, last.p + (pressure - last.p) * at))
    }
    this.#last = { x, y, p: pressure }
    return changed
  }
}

function reach(clip: ClipPixels | null, pixel: number): number {
  return clip === null ? 1 : clip[pixel]! / 255
}

function fillAll(pixels: Pixels, op: Extract<PaintOp, { kind: 'fill-all' }>, clip: ClipPixels | null): void {
  const rgb = hexRgb(op.color)
  for (let index = 0; index < pixels.length; index += 4) {
    const a = op.opacity * reach(clip, index >> 2)
    if (a > 0) paintPixel(pixels, index, pixels, index, rgb, a, op.lockAlpha)
  }
}

/** The selected pixels made transparent, as Photoshop's Delete does; a soft selection clears in part. */
function clear(pixels: Pixels, clip: ClipPixels | null): void {
  for (let index = 3; index < pixels.length; index += 4) {
    const a = reach(clip, index >> 2)
    if (a > 0) pixels[index] = clampByte(pixels[index]! * (1 - a))
  }
}

/** The paint bucket: pixels within tolerance of the one clicked, joined to it (4-connected) or anywhere. */
function fill(pixels: Pixels, width: number, height: number, op: Extract<PaintOp, { kind: 'fill' }>, clip: ClipPixels | null): void {
  const sx = Math.floor(op.x)
  const sy = Math.floor(op.y)
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return
  const seed = (sy * width + sx) * 4
  const target = [pixels[seed]!, pixels[seed + 1]!, pixels[seed + 2]!, pixels[seed + 3]!]
  const matches = (index: number): boolean => Math.abs(pixels[index]! - target[0]!) <= op.tolerance
    && Math.abs(pixels[index + 1]! - target[1]!) <= op.tolerance
    && Math.abs(pixels[index + 2]! - target[2]!) <= op.tolerance
    && Math.abs(pixels[index + 3]! - target[3]!) <= op.tolerance
  const selected = new Uint8Array(width * height)
  if (op.contiguous) {
    const stack = [sy * width + sx]
    selected[sy * width + sx] = 1
    while (stack.length > 0) {
      const at = stack.pop()!
      const x = at % width
      const y = (at - x) / width
      const neighbours = [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1]
      for (const next of neighbours) {
        if (next < 0 || selected[next] === 1 || !matches(next * 4)) continue
        selected[next] = 1
        stack.push(next)
      }
    }
  } else {
    for (let at = 0; at < selected.length; at += 1) if (matches(at * 4)) selected[at] = 1
  }
  const rgb = hexRgb(op.color)
  for (let at = 0; at < selected.length; at += 1) {
    if (selected[at] !== 1) continue
    const a = op.opacity * reach(clip, at)
    if (a > 0) paintPixel(pixels, at * 4, pixels, at * 4, rgb, a, op.lockAlpha)
  }
}

/** Foreground to background across the drag; before the start and past the end the end colours hold. */
function gradient(pixels: Pixels, width: number, height: number, op: Extract<PaintOp, { kind: 'gradient' }>, clip: ClipPixels | null): void {
  const [fx, fy] = op.from
  const [tx, ty] = op.to
  const dx = tx - fx
  const dy = ty - fy
  const lengthSquared = dx * dx + dy * dy
  const start = hexRgb(op.colors[0])
  const end = hexRgb(op.colors[1])
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5 - fx
      const py = y + 0.5 - fy
      const raw = lengthSquared === 0 ? 1
        : op.shape === 'linear' ? (px * dx + py * dy) / lengthSquared
          : Math.sqrt((px * px + py * py) / lengthSquared)
      const t = Math.min(1, Math.max(0, raw))
      const rgb: Rgb = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t]
      const index = (y * width + x) * 4
      const a = op.opacity * reach(clip, y * width + x)
      if (a > 0) paintPixel(pixels, index, pixels, index, rgb, a, op.lockAlpha)
    }
  }
}

/**
 * Replays one operation over the pixels, in place, limited to its clip. An
 * operation whose clip is not at hand is left out rather than painted
 * beyond its selection.
 */
export function applyPaintOp(pixels: Pixels, width: number, height: number, op: PaintOp, clips: ClipLookup = new Map()): void {
  const clip = op.clip === undefined ? null : clips.get(op.clip) ?? undefined
  if (clip === undefined || (clip !== null && clip.length < width * height)) return
  switch (op.kind) {
    case 'stroke': {
      const stroke = new StrokeRasterizer(pixels, width, height, op, clip)
      for (let index = 0; index < op.points.length; index += 3) stroke.addPoint(op.points[index]!, op.points[index + 1]!, op.points[index + 2]!)
      return
    }
    case 'fill': fill(pixels, width, height, op, clip); return
    case 'fill-all': fillAll(pixels, op, clip); return
    case 'gradient': gradient(pixels, width, height, op, clip); return
    case 'clear': clear(pixels, clip)
  }
}

/** Replays the operations over the pixels, oldest first, in place. */
export function applyPaintOps(pixels: Pixels, width: number, height: number, ops: readonly PaintOp[], clips: ClipLookup = new Map()): void {
  for (const op of ops) applyPaintOp(pixels, width, height, op, clips)
}

/** The clip assets the operations refer to. */
export function paintClipIds(ops: readonly PaintOp[] | undefined): string[] {
  return [...new Set((ops ?? []).flatMap((op) => op.clip === undefined ? [] : [op.clip]))]
}

/**
 * A layer mask's coverage after its paint: the mask image as opaque gray
 * RGBA with the operations replayed over it, read from the red channel.
 */
export function maskCoverage(gray: ClipPixels, width: number, height: number, ops: readonly PaintOp[] | undefined, clips: ClipLookup = new Map()): Uint8Array {
  const coverage = new Uint8Array(width * height)
  if (ops === undefined || ops.length === 0) {
    for (let index = 0; index < coverage.length; index += 1) coverage[index] = gray[index]!
    return coverage
  }
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < coverage.length; index += 1) {
    const value = gray[index]!
    rgba[index * 4] = value; rgba[index * 4 + 1] = value; rgba[index * 4 + 2] = value; rgba[index * 4 + 3] = 255
  }
  applyPaintOps(rgba, width, height, ops, clips)
  for (let index = 0; index < coverage.length; index += 1) coverage[index] = rgba[index * 4]!
  return coverage
}

/**
 * The layer mask applied: target takes source's pixels with each pixel's
 * transparency scaled by the mask, over the whole layer or one rectangle of
 * it. Source and target may be the same pixels.
 */
export function applyMaskAlpha(source: Pixels, target: Pixels, coverage: ClipPixels, width: number, rect: PixelRect | null = null): void {
  const height = Math.floor(source.length / 4 / width)
  const x0 = Math.max(0, rect?.x0 ?? 0)
  const y0 = Math.max(0, rect?.y0 ?? 0)
  const x1 = Math.min(width, rect?.x1 ?? width)
  const y1 = Math.min(height, rect?.y1 ?? height)
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = y * width + x
      const index = pixel * 4
      target[index] = source[index]!
      target[index + 1] = source[index + 1]!
      target[index + 2] = source[index + 2]!
      target[index + 3] = Math.round(source[index + 3]! * coverage[pixel]! / 255)
    }
  }
}

/** A mask colour on the canvas: Photoshop paints a mask in the gray of the colour's luminosity. */
export function maskGray(hex: string): string {
  const [r, g, b] = hexRgb(hex)
  const value = clampByte(0.299 * r + 0.587 * g + 0.114 * b).toString(16).padStart(2, '0').toUpperCase()
  return `#${value}${value}${value}`
}
