import type { BlendMode, LayerStyle, LayerStyleKind, SceneElement } from '../domain'
import { blendColor } from './blend-mode'
import { blurChannel } from './filters'
import { hasVisibleEffects, shadowGeometry } from './layer-effects'

/*
 * Photoshop's layer styles in pixels, shared by the canvas, the offscreen
 * export renderer and Main's composite renderer. A layer is drawn alone into
 * a padded raster first (its content: pixels, text or shape, through its
 * mask); the styles then work from that raster's transparency. Pixels are
 * RGBA, not premultiplied. Sizes are output pixels; scale is how many raster
 * pixels make one, so the canvas can work at the screen's resolution.
 *
 * As in Photoshop: the stroke and the inner effects are part of the layer
 * (drawn in its blend mode); the drop shadow and outer glow lie under it,
 * each laid over the picture below in its own blend mode, and are cast by
 * the layer with its stroke. The layer knocks out its own shadow, so a
 * half-transparent layer does not show its shadow through itself.
 */

type Pixels = Uint8Array | Uint8ClampedArray

export const LAYER_STYLE_LABELS: Readonly<Record<LayerStyleKind, string>> = {
  dropShadow: '投影',
  innerShadow: '内阴影',
  outerGlow: '外发光',
  stroke: '描边',
  colorOverlay: '颜色叠加',
  gradientOverlay: '渐变叠加'
}

/** Photoshop's order in the layer style dialog. */
export const LAYER_STYLE_ORDER: readonly LayerStyleKind[] = ['stroke', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'outerGlow', 'dropShadow']

/** Each style as it opens, close to Photoshop's own defaults; the colours of stroke and overlay come from the caller. */
export function defaultLayerStyle<K extends LayerStyleKind>(kind: K, color = '#000000'): NonNullable<LayerStyle[K]> {
  const styles: { readonly [P in LayerStyleKind]-?: NonNullable<LayerStyle[P]> } = {
    dropShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 0.35, angle: 120, distance: 5, spread: 0, size: 5 },
    innerShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 0.35, angle: 120, distance: 5, choke: 0, size: 5 },
    outerGlow: { enabled: true, blendMode: 'screen', color: '#FFFFBE', opacity: 0.75, spread: 0, size: 5 },
    stroke: { enabled: true, size: 3, position: 'outside', color, opacity: 1 },
    colorOverlay: { enabled: true, blendMode: 'normal', color, opacity: 1 },
    gradientOverlay: { enabled: true, blendMode: 'normal', opacity: 1, style: 'linear', angle: 90, scale: 100, reverse: false, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#FFFFFF' }] }
  }
  return styles[kind] as NonNullable<LayerStyle[K]>
}

/** The styles that are switched on. */
export function activeLayerStyles(style: LayerStyle | undefined): LayerStyleKind[] {
  if (style === undefined) return []
  return LAYER_STYLE_ORDER.filter((kind) => {
    const entry = style[kind]
    return entry !== undefined && entry.enabled && ('opacity' in entry ? entry.opacity > 0 : true)
  })
}

export function hasLayerStyles(style: LayerStyle | undefined): style is LayerStyle {
  return activeLayerStyles(style).length > 0
}

/** A short description of the styles that are on, such as 投影、描边 3 像素. */
export function describeLayerStyle(style: LayerStyle | undefined): string {
  return activeLayerStyles(style).map((kind) => {
    const entry = style![kind]!
    if (kind === 'stroke' && 'position' in entry) return `描边 ${entry.size} 像素（${entry.position === 'outside' ? '外部' : entry.position === 'inside' ? '内部' : '居中'}）`
    if ((kind === 'dropShadow' || kind === 'innerShadow') && 'distance' in entry) return `${LAYER_STYLE_LABELS[kind]}（距离 ${entry.distance}、大小 ${entry.size}）`
    return LAYER_STYLE_LABELS[kind]
  }).join('、')
}

/**
 * How far past the layer's box its styles reach, in output pixels, so the
 * raster they are worked out in can hold them.
 */
export function layerStyleReach(style: LayerStyle | undefined): number {
  const kinds = activeLayerStyles(style)
  const stroke = kinds.includes('stroke') && style!.stroke!.position !== 'inside' ? (style!.stroke!.position === 'center' ? style!.stroke!.size / 2 : style!.stroke!.size) : 0
  // The stroke is part of what casts the shadow and the glow, so they reach past it.
  let reach = stroke
  if (kinds.includes('outerGlow')) reach = Math.max(reach, stroke + style!.outerGlow!.size * 1.6)
  if (kinds.includes('dropShadow')) reach = Math.max(reach, stroke + style!.dropShadow!.distance + style!.dropShadow!.size * 1.6)
  return Math.ceil(reach) + 2
}

/**
 * How far past its box a styled layer's raster must reach, in output
 * pixels, for this box size: its styles, and what it draws past its box
 * itself (an image's own shadow, a text's stroke and glow), which the
 * styles must not cut off.
 */
export function styledLayerReach(element: Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>, boxWidth: number, boxHeight: number): number {
  let own = 0
  if (element.type === 'image' && hasVisibleEffects(element.effects) && element.effects.shadow !== null && element.effects.shadow.opacity > 0) {
    const geometry = shadowGeometry(element.effects.shadow, boxWidth, boxHeight)
    own = geometry.padding + Math.max(Math.abs(geometry.offsetX), Math.abs(geometry.offsetY))
  }
  if (element.type === 'text') own = (element.stroke === null ? 0 : element.strokeWidth) + (element.shadowColor === null ? 0 : element.shadowBlur * 2)
  if (element.type === 'shape' && element.stroke !== null) own = element.strokeWidth * Math.min(boxWidth, boxHeight)
  return layerStyleReach(element.style) + Math.ceil(own)
}

// ---- Distances ----

const FAR = 1e12

/** Felzenszwalb's squared distance transform along one line. */
function line(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q += 1) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
    while (s <= z[k]!) {
      k -= 1
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
    }
    k += 1
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1]! < q) k += 1
    out[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!
  }
}

/** For each pixel, how far its centre is from the centre of the nearest pixel of the set, in pixels. */
export function distanceToSet(inSet: Uint8Array, width: number, height: number): Float32Array {
  const size = Math.max(width, height)
  const f = new Float64Array(size)
  const out = new Float64Array(size)
  const v = new Int32Array(size)
  const z = new Float64Array(size + 1)
  const grid = new Float64Array(width * height)
  for (let index = 0; index < grid.length; index += 1) grid[index] = inSet[index] === 1 ? 0 : FAR
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) f[y] = grid[y * width + x]!
    line(f, height, out, v, z)
    for (let y = 0; y < height; y += 1) grid[y * width + x] = out[y]!
  }
  const result = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) f[x] = grid[y * width + x]!
    line(f, width, out, v, z)
    for (let x = 0; x < width; x += 1) result[y * width + x] = Math.sqrt(out[x]!)
  }
  return result
}

// ---- Shapes from the layer's transparency ----

function alphaOf(data: Pixels): Float32Array {
  const alpha = new Float32Array(data.length / 4)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = data[pixel * 4 + 3]! / 255
  return alpha
}

function threshold(alpha: Float32Array, inside: boolean): Uint8Array {
  const set = new Uint8Array(alpha.length)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) set[pixel] = (alpha[pixel]! >= 0.5) === inside ? 1 : 0
  return set
}

/** The shape grown outwards by this many pixels, its edge kept soft. */
function grown(alpha: Float32Array, width: number, height: number, by: number): Float32Array {
  if (by <= 0) return alpha
  const distance = distanceToSet(threshold(alpha, true), width, height)
  const result = new Float32Array(alpha.length)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) result[pixel] = Math.max(alpha[pixel]!, Math.min(1, Math.max(0, by + 1 - distance[pixel]!)))
  return result
}

/** The picture moved by (dx, dy) pixels, sampled between pixels; what comes in from past the edges is `beyond`. */
function moved(alpha: Float32Array, width: number, height: number, dx: number, dy: number, beyond = 0): Float32Array {
  if (dx === 0 && dy === 0) return alpha
  const result = new Float32Array(alpha.length)
  const value = (x: number, y: number): number => x < 0 || y < 0 || x >= width || y >= height ? beyond : alpha[y * width + x]!
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x - dx
      const sy = y - dy
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const fx = sx - x0
      const fy = sy - y0
      result[y * width + x] = (value(x0, y0) * (1 - fx) + value(x0 + 1, y0) * fx) * (1 - fy) + (value(x0, y0 + 1) * (1 - fx) + value(x0 + 1, y0 + 1) * fx) * fy
    }
  }
  return result
}

/**
 * A soft copy of the shape as Photoshop's size and spread (or choke) make
 * it: grown by spread% of the size, then blurred over the rest.
 */
function softened(alpha: Float32Array, width: number, height: number, size: number, spread: number): Float32Array {
  const hard = size * spread / 100
  const result = grown(alpha, width, height, hard)
  const soft = new Float32Array(result)
  blurChannel(soft, width, height, (size - hard) / 2)
  return soft
}

/** The direction light comes from, turned into the layer's own frame, as a shift away from it in raster pixels. */
function offsetFor(angle: number, distance: number, rotation: number, scale: number): readonly [number, number] {
  const radians = (angle + rotation) * Math.PI / 180
  return [-Math.cos(radians) * distance * scale, Math.sin(radians) * distance * scale]
}

function hex(color: string): readonly [number, number, number] {
  const value = Number.parseInt(color.slice(1, 7), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** A colour at this coverage, as RGBA. */
function solid(alpha: Float32Array, color: string, opacity: number): Uint8ClampedArray<ArrayBuffer> {
  const [r, g, b] = hex(color)
  const out = new Uint8ClampedArray(alpha.length * 4)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    out[pixel * 4] = r
    out[pixel * 4 + 1] = g
    out[pixel * 4 + 2] = b
    out[pixel * 4 + 3] = Math.round(Math.min(1, alpha[pixel]! * opacity) * 255)
  }
  return out
}

/** Lays a colour over the layer's own pixels in a mode, by coverage, keeping their transparency, as an inner effect does. */
function layOver(data: Pixels, coverage: (pixel: number) => number, colorAt: (pixel: number, out: Float64Array) => void, mode: BlendMode): void {
  const blended = new Float64Array(3)
  const color = new Float64Array(3)
  for (let pixel = 0, index = 0; index < data.length; pixel += 1, index += 4) {
    if (data[index + 3] === 0) continue
    const weight = coverage(pixel)
    if (weight <= 0) continue
    colorAt(pixel, color)
    blendColor(mode, data[index]! / 255, data[index + 1]! / 255, data[index + 2]! / 255, color[0]!, color[1]!, color[2]!, blended)
    for (let channel = 0; channel < 3; channel += 1) {
      const original = data[index + channel]!
      const value = Math.max(0, Math.min(1, blended[channel]!)) * 255
      data[index + channel] = Math.round(original + (value - original) * Math.min(1, weight))
    }
  }
}

/** Puts one picture over another, normal blend, in place. */
function over(below: Pixels, above: Uint8ClampedArray): void {
  for (let index = 0; index < below.length; index += 4) {
    const a = above[index + 3]! / 255
    if (a <= 0) continue
    const b = below[index + 3]! / 255
    const out = a + b * (1 - a)
    for (let channel = 0; channel < 3; channel += 1) below[index + channel] = Math.round((above[index + channel]! * a + below[index + channel]! * b * (1 - a)) / out)
    below[index + 3] = Math.round(out * 255)
  }
}

/** The gradient's colour at a point of the box, its stops spread along it as Photoshop's align-with-layer does. */
function gradientColor(gradient: NonNullable<LayerStyle['gradientOverlay']>, box: StyleBox): (pixel: number, out: Float64Array) => void {
  const stops = [...gradient.stops].sort((a, b) => a.offset - b.offset).map((stop) => ({ offset: stop.offset, rgb: hex(stop.color) }))
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const radians = gradient.angle * Math.PI / 180
  const ux = Math.cos(radians)
  const uy = -Math.sin(radians)
  const half = (Math.abs(ux) * box.width + Math.abs(uy) * box.height) / 2 * gradient.scale / 100
  const radius = Math.max(box.width, box.height) / 2 * gradient.scale / 100
  return (pixel, out) => {
    const x = pixel % box.rasterWidth + 0.5
    const y = Math.floor(pixel / box.rasterWidth) + 0.5
    let t = gradient.style === 'radial'
      ? Math.hypot(x - cx, y - cy) / Math.max(1e-6, radius)
      : ((x - cx) * ux + (y - cy) * uy) / Math.max(1e-6, 2 * half) + 0.5
    if (gradient.reverse) t = 1 - t
    t = Math.min(1, Math.max(0, t))
    let index = 0
    while (index < stops.length - 1 && stops[index + 1]!.offset < t) index += 1
    const from = stops[index]!
    const to = stops[Math.min(stops.length - 1, index + 1)]!
    const span = to.offset - from.offset
    const mix = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - from.offset) / span))
    for (let channel = 0; channel < 3; channel += 1) out[channel] = (from.rgb[channel]! + (to.rgb[channel]! - from.rgb[channel]!) * mix) / 255
  }
}

/** Where the layer's box lies in the raster its styles are worked out in, in raster pixels. */
export interface StyleBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rasterWidth: number
  readonly rasterHeight: number
}

export interface StyledLayer {
  /** Drop shadow and outer glow, bottom first, each laid over the picture below in its own mode. */
  readonly under: readonly { readonly kind: 'dropShadow' | 'outerGlow'; readonly pixels: Uint8ClampedArray<ArrayBuffer>; readonly blendMode: BlendMode }[]
}

/**
 * Works out the layer's styles from its raster: the content is changed in
 * place to carry its stroke and inner effects, and what lies under it is
 * returned. rotation is the layer's turn in degrees (clockwise on screen),
 * so its shadow still falls the picture's way.
 */
export function applyLayerStyles(data: Pixels, box: StyleBox, style: LayerStyle, scale: number, rotation = 0): StyledLayer {
  const width = box.rasterWidth
  const height = box.rasterHeight
  const alpha = alphaOf(data)

  // Inside the layer: overlays (gradient under colour, as in Photoshop), then the inner shadow.
  const gradient = style.gradientOverlay
  if (gradient !== undefined && gradient.enabled && gradient.opacity > 0) {
    layOver(data, () => gradient.opacity, gradientColor(gradient, box), gradient.blendMode)
  }
  const color = style.colorOverlay
  if (color !== undefined && color.enabled && color.opacity > 0) {
    const rgb = hex(color.color).map((value) => value / 255)
    layOver(data, () => color.opacity, (_pixel, out) => { out[0] = rgb[0]!; out[1] = rgb[1]!; out[2] = rgb[2]! }, color.blendMode)
  }
  const inner = style.innerShadow
  if (inner !== undefined && inner.enabled && inner.opacity > 0) {
    const outside = new Float32Array(alpha.length)
    for (let pixel = 0; pixel < alpha.length; pixel += 1) outside[pixel] = 1 - alpha[pixel]!
    const [dx, dy] = offsetFor(inner.angle, inner.distance, rotation, scale)
    // Past the raster is outside the layer too, so what moves in from there shades the edge.
    const shade = moved(softened(outside, width, height, inner.size * scale, inner.choke), width, height, dx, dy, 1)
    const rgb = hex(inner.color).map((value) => value / 255)
    layOver(data, (pixel) => shade[pixel]! * inner.opacity, (_pixel, out) => { out[0] = rgb[0]!; out[1] = rgb[1]!; out[2] = rgb[2]! }, inner.blendMode)
  }

  // The stroke: inside it covers the layer's edge, outside it lies under it, centred both.
  const stroke = style.stroke
  if (stroke !== undefined && stroke.enabled && stroke.opacity > 0) {
    const size = stroke.size * scale
    const outward = stroke.position === 'outside' ? size : stroke.position === 'center' ? size / 2 : 0
    const inward = stroke.position === 'inside' ? size : stroke.position === 'center' ? size / 2 : 0
    if (inward > 0) {
      const toOutside = distanceToSet(threshold(alpha, false), width, height)
      const band = new Float32Array(alpha.length)
      for (let pixel = 0; pixel < alpha.length; pixel += 1) band[pixel] = Math.min(1, Math.max(0, inward + 1 - toOutside[pixel]!)) * alpha[pixel]!
      over(data, solid(band, stroke.color, stroke.opacity))
    }
    if (outward > 0) {
      const toInside = distanceToSet(threshold(alpha, true), width, height)
      const band = new Float32Array(alpha.length)
      for (let pixel = 0; pixel < alpha.length; pixel += 1) band[pixel] = alpha[pixel]! >= 0.5 ? 1 : Math.min(1, Math.max(0, outward + 1 - toInside[pixel]!))
      // The layer goes over its outside stroke.
      const below = solid(band, stroke.color, stroke.opacity)
      over(below, data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data))
      data.set(below)
    }
  }

  // Under the layer: cast by the layer with its stroke, knocked out where the layer is.
  const cast = alphaOf(data)
  const under: { kind: 'dropShadow' | 'outerGlow'; pixels: Uint8ClampedArray<ArrayBuffer>; blendMode: BlendMode }[] = []
  const knockOut = (shape: Float32Array): Float32Array => {
    for (let pixel = 0; pixel < shape.length; pixel += 1) shape[pixel] = shape[pixel]! * (1 - cast[pixel]!)
    return shape
  }
  const shadow = style.dropShadow
  if (shadow !== undefined && shadow.enabled && shadow.opacity > 0) {
    const [dx, dy] = offsetFor(shadow.angle, shadow.distance, rotation, scale)
    under.push({ kind: 'dropShadow', blendMode: shadow.blendMode, pixels: solid(knockOut(moved(softened(cast, width, height, shadow.size * scale, shadow.spread), width, height, dx, dy)), shadow.color, shadow.opacity) })
  }
  const glow = style.outerGlow
  if (glow !== undefined && glow.enabled && glow.opacity > 0) {
    under.push({ kind: 'outerGlow', blendMode: glow.blendMode, pixels: solid(knockOut(softened(cast, width, height, glow.size * scale, glow.spread)), glow.color, glow.opacity) })
  }
  return { under }
}
