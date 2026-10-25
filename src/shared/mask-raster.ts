/*
 * Grayscale masks: selections on the canvas, the clip a painting operation
 * records, and layer masks. A mask holds one coverage value per pixel, 0
 * outside to 255 inside, row by row. Everything here is plain arithmetic
 * on arrays, so the canvas and Main draw the same masks.
 */

export interface GrayMask {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export interface MaskRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type MaskCombine = 'replace' | 'add' | 'subtract' | 'intersect'

export function createMask(width: number, height: number, fill = 0): GrayMask {
  const data = new Uint8Array(Math.max(0, width * height))
  if (fill !== 0) data.fill(fill)
  return { width, height, data }
}

/** A rectangle snapped to whole pixels, as Photoshop's rectangular marquee is. */
export function rectMask(width: number, height: number, rect: MaskRect): GrayMask {
  const mask = createMask(width, height)
  const x0 = Math.max(0, Math.round(Math.min(rect.x, rect.x + rect.width)))
  const x1 = Math.min(width, Math.round(Math.max(rect.x, rect.x + rect.width)))
  const y0 = Math.max(0, Math.round(Math.min(rect.y, rect.y + rect.height)))
  const y1 = Math.min(height, Math.round(Math.max(rect.y, rect.y + rect.height)))
  for (let y = y0; y < y1; y += 1) mask.data.fill(255, y * width + x0, y * width + x1)
  return mask
}

const SUBSAMPLES = 4

/**
 * A closed polygon, points as x, y pairs in pixels, filled by the nonzero
 * rule with antialiased edges: exact coverage across each row and four
 * samples down each pixel.
 */
export function polygonMask(width: number, height: number, points: ArrayLike<number>): GrayMask {
  const mask = createMask(width, height)
  const count = Math.floor(points.length / 2)
  if (count < 3 || width <= 0 || height <= 0) return mask
  interface Edge { readonly x0: number; readonly y0: number; readonly slope: number; readonly yMin: number; readonly yMax: number; readonly dir: number }
  const edges: Edge[] = []
  for (let index = 0; index < count; index += 1) {
    const ax = points[index * 2]!
    const ay = points[index * 2 + 1]!
    const bx = points[((index + 1) % count) * 2]!
    const by = points[((index + 1) % count) * 2 + 1]!
    if (ay === by) continue
    edges.push({ x0: ax, y0: ay, slope: (bx - ax) / (by - ay), yMin: Math.min(ay, by), yMax: Math.max(ay, by), dir: by > ay ? 1 : -1 })
  }
  edges.sort((left, right) => left.yMin - right.yMin)
  const coverage = new Float32Array(width + 1)
  const active: Edge[] = []
  const crossings: { x: number; dir: number }[] = []
  let next = 0
  const top = Math.max(0, Math.floor(edges[0]?.yMin ?? 0))
  let lowest = 0
  for (const edge of edges) if (edge.yMax > lowest) lowest = edge.yMax
  const bottom = Math.min(height, Math.ceil(lowest))
  for (let y = top; y < bottom; y += 1) {
    coverage.fill(0)
    let touched = false
    for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
      const sy = y + (sample + 0.5) / SUBSAMPLES
      while (next < edges.length && edges[next]!.yMin <= sy) active.push(edges[next++]!)
      crossings.length = 0
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const edge = active[index]!
        if (edge.yMax <= sy) { active.splice(index, 1); continue }
        if (edge.yMin > sy) continue
        crossings.push({ x: edge.x0 + (sy - edge.y0) * edge.slope, dir: edge.dir })
      }
      if (crossings.length < 2) continue
      crossings.sort((left, right) => left.x - right.x)
      let winding = 0
      for (let index = 0; index < crossings.length - 1; index += 1) {
        winding += crossings[index]!.dir
        if (winding === 0) continue
        const from = Math.max(0, crossings[index]!.x)
        const to = Math.min(width, crossings[index + 1]!.x)
        if (to <= from) continue
        touched = true
        const first = Math.floor(from)
        const last = Math.floor(to)
        if (first === last) {
          coverage[first]! += (to - from) / SUBSAMPLES
          continue
        }
        coverage[first]! += (first + 1 - from) / SUBSAMPLES
        for (let x = first + 1; x < last; x += 1) coverage[x]! += 1 / SUBSAMPLES
        if (last < width) coverage[last]! += (to - last) / SUBSAMPLES
      }
    }
    if (!touched) continue
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const value = coverage[x]!
      if (value > 0) mask.data[row + x] = Math.min(255, Math.round(value * 255))
    }
  }
  return mask
}

/** An ellipse inside the rectangle, antialiased. */
export function ellipseMask(width: number, height: number, rect: MaskRect): GrayMask {
  const rx = Math.abs(rect.width) / 2
  const ry = Math.abs(rect.height) / 2
  const cx = Math.min(rect.x, rect.x + rect.width) + rx
  const cy = Math.min(rect.y, rect.y + rect.height) + ry
  if (rx < 0.5 || ry < 0.5) return createMask(width, height)
  // Chords of about a pixel and a half keep the outline within a hundredth of a pixel of the curve.
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
  const steps = Math.max(32, Math.min(8192, Math.ceil(perimeter / 1.5)))
  const points = new Float64Array(steps * 2)
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2
    points[index * 2] = cx + rx * Math.cos(angle)
    points[index * 2 + 1] = cy + ry * Math.sin(angle)
  }
  return polygonMask(width, height, points)
}

/** A new selection drawn with Shift adds, with Alt subtracts, with both intersects, as in Photoshop. */
export function combineMasks(base: GrayMask | null, shape: GrayMask, mode: MaskCombine): GrayMask {
  if (mode === 'replace' || base === null) {
    if (mode === 'subtract' || mode === 'intersect') return createMask(shape.width, shape.height)
    return shape
  }
  const out = createMask(base.width, base.height)
  const a = base.data
  const b = shape.data
  const length = Math.min(a.length, b.length)
  if (mode === 'add') for (let index = 0; index < length; index += 1) out.data[index] = a[index]! > b[index]! ? a[index]! : b[index]!
  else if (mode === 'intersect') for (let index = 0; index < length; index += 1) out.data[index] = a[index]! < b[index]! ? a[index]! : b[index]!
  else for (let index = 0; index < length; index += 1) { const keep = 255 - b[index]!; out.data[index] = a[index]! < keep ? a[index]! : keep }
  return out
}

export function invertMask(mask: GrayMask): GrayMask {
  const out = createMask(mask.width, mask.height)
  for (let index = 0; index < mask.data.length; index += 1) out.data[index] = 255 - mask.data[index]!
  return out
}

/** Three box sizes whose blurs in turn approximate a Gaussian of this sigma. */
function boxesForGauss(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma / 3) + 1)
  let lower = Math.floor(ideal)
  if (lower % 2 === 0) lower -= 1
  const upper = lower + 2
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4))
  return [0, 1, 2].map((index) => index < m ? lower : upper)
}

function boxBlurPass(source: Float32Array, target: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? height : width
  const length = horizontal ? width : height
  const stride = horizontal ? 1 : width
  const scale = 1 / (radius * 2 + 1)
  for (let line = 0; line < lines; line += 1) {
    const start = horizontal ? line * width : line
    const first = source[start]!
    const last = source[start + (length - 1) * stride]!
    // Pixels beyond the edge repeat the edge, so a selection touching it stays solid there.
    let sum = first * (radius + 1)
    for (let index = 0; index < radius; index += 1) sum += source[start + Math.min(index, length - 1) * stride]!
    for (let index = 0; index < length; index += 1) {
      const enter = index + radius
      const leave = index - radius - 1
      sum += (enter < length ? source[start + enter * stride]! : last) - (leave >= 0 ? source[start + leave * stride]! : first)
      target[start + index * stride] = sum * scale
    }
  }
}

/** Photoshop's feather (Shift+F6): the edge softened over about this many pixels either side. */
export function featherMask(mask: GrayMask, radius: number): GrayMask {
  if (radius < 0.5 || mask.width === 0 || mask.height === 0) return mask
  const sigma = radius / 2
  let a = Float32Array.from(mask.data)
  let b = new Float32Array(a.length)
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) / 2
    if (r < 1) continue
    boxBlurPass(a, b, mask.width, mask.height, r, true);
    [a, b] = [b, a]
    boxBlurPass(a, b, mask.width, mask.height, r, false);
    [a, b] = [b, a]
  }
  const out = createMask(mask.width, mask.height)
  for (let index = 0; index < a.length; index += 1) out.data[index] = Math.max(0, Math.min(255, Math.round(a[index]!)))
  return out
}

/** The mask moved by whole pixels; what moves off the canvas is lost, as with Photoshop's selection. */
export function translateMask(mask: GrayMask, dx: number, dy: number): GrayMask {
  const out = createMask(mask.width, mask.height)
  const ox = Math.round(dx)
  const oy = Math.round(dy)
  const x0 = Math.max(0, ox)
  const x1 = Math.min(mask.width, mask.width + ox)
  if (x1 <= x0) return out
  for (let y = Math.max(0, oy); y < Math.min(mask.height, mask.height + oy); y += 1) {
    const from = (y - oy) * mask.width + (x0 - ox)
    out.data.set(mask.data.subarray(from, from + (x1 - x0)), y * mask.width + x0)
  }
  return out
}

/** The smallest rectangle of pixels with any coverage, or null for an empty mask. */
export function maskBounds(mask: GrayMask): MaskRect | null {
  let left = mask.width
  let right = -1
  let top = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width
    let first = -1
    for (let x = 0; x < mask.width; x += 1) if (mask.data[row + x] !== 0) { first = x; break }
    if (first < 0) continue
    let last = first
    for (let x = mask.width - 1; x > first; x -= 1) if (mask.data[row + x] !== 0) { last = x; break }
    if (top < 0) top = y
    bottom = y
    if (first < left) left = first
    if (last > right) right = last
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

export function isMaskEmpty(mask: GrayMask): boolean {
  for (let index = 0; index < mask.data.length; index += 1) if (mask.data[index] !== 0) return false
  return true
}

export function isMaskFull(mask: GrayMask): boolean {
  for (let index = 0; index < mask.data.length; index += 1) if (mask.data[index] !== 255) return false
  return true
}

/** Run-length bytes for keeping old selections cheaply: each run is a value and a 24-bit length. */
export function encodeMask(mask: GrayMask): Uint32Array {
  const runs: number[] = []
  const data = mask.data
  let index = 0
  while (index < data.length) {
    const value = data[index]!
    let end = index + 1
    while (end < data.length && data[end] === value && end - index < 0xFFFFFF) end += 1
    runs.push((value << 24 | (end - index)) >>> 0)
    index = end
  }
  return Uint32Array.from(runs)
}

export function decodeMask(width: number, height: number, runs: Uint32Array): GrayMask {
  const mask = createMask(width, height)
  let at = 0
  for (const run of runs) {
    const length = run & 0xFFFFFF
    const value = run >>> 24
    if (value !== 0) mask.data.fill(value, at, at + length)
    at += length
  }
  return mask
}

/**
 * The outline of the mask at half coverage, as closed polylines through
 * pixel space (x, y pairs), for drawing marching ants. Traced by marching
 * squares between pixel centres; straight runs collapse to their ends.
 */
export function traceMaskOutline(mask: GrayMask, threshold = 128): Float32Array[] {
  const { width, height, data } = mask
  const bounds = maskBounds(mask)
  if (bounds === null) return []
  const at = (x: number, y: number): number => x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x]!
  // Edge ids: horizontal edges between (x, y) and (x+1, y), vertical ones between (x, y) and (x, y+1), on a grid padded by one.
  const gridWidth = width + 2
  const horizontalId = (x: number, y: number): number => ((y + 1) * gridWidth + (x + 1)) * 2
  const verticalId = (x: number, y: number): number => ((y + 1) * gridWidth + (x + 1)) * 2 + 1
  const position = new Map<number, [number, number]>()
  const links = new Map<number, number[]>()
  const crossing = (a: number, b: number): number => a === b ? 0.5 : (threshold - a) / (b - a)
  const vertex = (id: number, x: number, y: number): number => {
    if (!position.has(id)) position.set(id, [x + 0.5, y + 0.5])
    return id
  }
  const link = (a: number, b: number): void => {
    const left = links.get(a)
    if (left === undefined) links.set(a, [b]); else left.push(b)
    const right = links.get(b)
    if (right === undefined) links.set(b, [a]); else right.push(a)
  }
  for (let y = bounds.y - 1; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x - 1; x < bounds.x + bounds.width; x += 1) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      const code = (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0)
      if (code === 0 || code === 15) continue
      const top = (): number => vertex(horizontalId(x, y), x + crossing(tl, tr), y)
      const bottom = (): number => vertex(horizontalId(x, y + 1), x + crossing(bl, br), y + 1)
      const left = (): number => vertex(verticalId(x, y), x, y + crossing(tl, bl))
      const right = (): number => vertex(verticalId(x + 1, y), x + 1, y + crossing(tr, br))
      switch (code) {
        case 1: case 14: link(left(), bottom()); break
        case 2: case 13: link(bottom(), right()); break
        case 3: case 12: link(left(), right()); break
        case 4: case 11: link(top(), right()); break
        case 6: case 9: link(top(), bottom()); break
        case 7: case 8: link(left(), top()); break
        case 5: case 10: {
          // A saddle: the centre decides whether the two inside corners join.
          const joined = (tl + tr + br + bl) / 4 >= threshold
          if ((code === 5) === joined) { link(left(), top()); link(bottom(), right()) } else { link(left(), bottom()); link(top(), right()) }
          break
        }
      }
    }
  }
  const visited = new Set<number>()
  const outlines: Float32Array[] = []
  for (const start of links.keys()) {
    if (visited.has(start)) continue
    const chain: number[] = []
    let previous = -1
    let current = start
    for (;;) {
      visited.add(current)
      chain.push(current)
      const next = (links.get(current) ?? []).find((candidate) => candidate !== previous && !visited.has(candidate))
      if (next === undefined) break
      previous = current
      current = next
    }
    if (chain.length < 2) continue
    const points: number[] = []
    for (let index = 0; index < chain.length; index += 1) {
      const [px, py] = position.get(chain[index]!)!
      const before = position.get(chain[(index - 1 + chain.length) % chain.length]!)!
      const after = position.get(chain[(index + 1) % chain.length]!)!
      // Keep a point only where the outline turns.
      const cross = (px - before[0]) * (after[1] - py) - (py - before[1]) * (after[0] - px)
      if (Math.abs(cross) > 1e-6 || chain.length <= 4) points.push(px, py)
    }
    if (points.length >= 4) outlines.push(Float32Array.from(points))
  }
  return outlines
}

/** Ramer–Douglas–Peucker: the outline with points closer than tolerance to the line between their neighbours left out. */
export function simplifyOutline(points: Float32Array, tolerance: number): Float32Array {
  const count = points.length / 2
  if (count <= 3) return points
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1
  const stack: Array<[number, number]> = [[0, count - 1]]
  while (stack.length > 0) {
    const [from, to] = stack.pop()!
    const ax = points[from * 2]!
    const ay = points[from * 2 + 1]!
    const bx = points[to * 2]!
    const by = points[to * 2 + 1]!
    const length = Math.hypot(bx - ax, by - ay) || 1
    let farthest = -1
    let distance = tolerance
    for (let index = from + 1; index < to; index += 1) {
      const d = Math.abs((bx - ax) * (ay - points[index * 2 + 1]!) - (ax - points[index * 2]!) * (by - ay)) / length
      if (d > distance) { distance = d; farthest = index }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    stack.push([from, farthest], [farthest, to])
  }
  let kept = 0
  for (let index = 0; index < count; index += 1) kept += keep[index]!
  const out = new Float32Array(kept * 2)
  for (let index = 0, at = 0; index < count; index += 1) {
    if (keep[index] !== 1) continue
    out[at++] = points[index * 2]!
    out[at++] = points[index * 2 + 1]!
  }
  return out
}

/**
 * Photoshop's magic wand: pixels within tolerance of the one clicked in
 * every channel, joined to it (4-connected) or anywhere, from straight
 * RGBA pixels. Antialiasing softens the edge by a pixel.
 */
export function magicWandMask(rgba: ArrayLike<number>, width: number, height: number, x: number, y: number, tolerance: number, contiguous: boolean, antialias: boolean): GrayMask {
  const mask = createMask(width, height)
  const sx = Math.floor(x)
  const sy = Math.floor(y)
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask
  const seed = (sy * width + sx) * 4
  const r = rgba[seed]!
  const g = rgba[seed + 1]!
  const b = rgba[seed + 2]!
  const a = rgba[seed + 3]!
  const matches = (pixel: number): boolean => {
    const index = pixel * 4
    // Fully transparent pixels match each other whatever colour they hold.
    if (a === 0 && rgba[index + 3] === 0) return true
    return Math.abs(rgba[index]! - r) <= tolerance && Math.abs(rgba[index + 1]! - g) <= tolerance
      && Math.abs(rgba[index + 2]! - b) <= tolerance && Math.abs(rgba[index + 3]! - a) <= tolerance
  }
  if (contiguous) {
    const stack = [sy * width + sx]
    mask.data[sy * width + sx] = 255
    while (stack.length > 0) {
      const pixel = stack.pop()!
      const px = pixel % width
      const neighbours = [px > 0 ? pixel - 1 : -1, px < width - 1 ? pixel + 1 : -1, pixel >= width ? pixel - width : -1, pixel < width * (height - 1) ? pixel + width : -1]
      for (const next of neighbours) {
        if (next < 0 || mask.data[next] === 255 || !matches(next)) continue
        mask.data[next] = 255
        stack.push(next)
      }
    }
  } else {
    for (let pixel = 0; pixel < width * height; pixel += 1) if (matches(pixel)) mask.data[pixel] = 255
  }
  return antialias ? softenEdge(mask) : mask
}

/** Each pixel on the boundary of a hard mask takes the mean of its 3×3 neighbourhood. */
function softenEdge(mask: GrayMask): GrayMask {
  const { width, height, data } = mask
  const out = createMask(width, height)
  out.data.set(data)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centre = data[y * width + x]!
      let sum = 0
      let differs = false
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = Math.min(width - 1, Math.max(0, x + dx))
          const ny = Math.min(height - 1, Math.max(0, y + dy))
          const value = data[ny * width + nx]!
          if (value !== centre) differs = true
          sum += value
        }
      }
      if (differs) out.data[y * width + x] = Math.round(sum / 9)
    }
  }
  return out
}

/** Intersection over union of two masks at half coverage, for checking a selection against a reference. */
export function maskIoU(left: GrayMask, right: GrayMask): number {
  let both = 0
  let either = 0
  const length = Math.min(left.data.length, right.data.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.data[index]! >= 128
    const b = right.data[index]! >= 128
    if (a && b) both += 1
    if (a || b) either += 1
  }
  return either === 0 ? 1 : both / either
}

/** Bilinear sample of the mask at a point in pixel space (pixel centres at +0.5), 0 outside. */
export function sampleMask(mask: GrayMask, x: number, y: number): number {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (px: number, py: number): number => px < 0 || py < 0 || px >= mask.width || py >= mask.height ? 0 : mask.data[py * mask.width + px]!
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx
  return top * (1 - ty) + bottom * ty
}
