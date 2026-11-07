import type { BlendMode, SceneElement } from '../domain'

/** Photoshop's blend modes that the canvas draws natively, in Photoshop's order. */
export const BLEND_MODES = [
  'normal',
  'darken', 'multiply', 'color-burn',
  'lighten', 'screen', 'color-dodge',
  'overlay', 'soft-light', 'hard-light',
  'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity'
] as const satisfies readonly BlendMode[]

/** The modes in Photoshop's groups, for menus that separate them. */
export const BLEND_MODE_GROUPS: readonly (readonly BlendMode[])[] = [
  ['normal'],
  ['darken', 'multiply', 'color-burn'],
  ['lighten', 'screen', 'color-dodge'],
  ['overlay', 'soft-light', 'hard-light'],
  ['difference', 'exclusion'],
  ['hue', 'saturation', 'color', 'luminosity']
]

const BLEND_MODE_LABELS: Readonly<Record<BlendMode, string>> = {
  normal: '正常',
  darken: '变暗',
  multiply: '正片叠底',
  'color-burn': '颜色加深',
  lighten: '变亮',
  screen: '滤色',
  'color-dodge': '颜色减淡',
  overlay: '叠加',
  'soft-light': '柔光',
  'hard-light': '强光',
  difference: '差值',
  exclusion: '排除',
  hue: '色相',
  saturation: '饱和度',
  color: '颜色',
  luminosity: '明度'
}

export function resolveBlendMode(element: Pick<SceneElement, 'blendMode'> | { readonly blendMode?: BlendMode }): BlendMode {
  return element.blendMode ?? 'normal'
}

export function blendModeLabel(blendMode: BlendMode): string {
  const label = BLEND_MODE_LABELS[blendMode]
  if (label === undefined) throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  return label
}

export type BlendCanvasOperation = 'source-over' | Exclude<BlendMode, 'normal'>

export function blendModeToCanvasOperation(blendMode: BlendMode): BlendCanvasOperation {
  if (BLEND_MODE_LABELS[blendMode] === undefined) throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  return blendMode === 'normal' ? 'source-over' : blendMode
}

export function blendModeToSvgStyle(blendMode: BlendMode): string {
  if (BLEND_MODE_LABELS[blendMode] === undefined) throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  return blendMode === 'normal' ? '' : ` style="mix-blend-mode:${blendMode}"`
}

export function elementSupportsBlendMode(type: SceneElement['type']): boolean {
  return type === 'text' || type === 'image' || type === 'shape' || type === 'sketch' || type === 'light' || type === 'adjustment'
}

const BLEND_MODE_INTENTS: Readonly<Record<BlendMode, string>> = {
  normal: '',
  darken: '以变暗融入下方层，只留下两者中更暗的部分',
  multiply: '以正片叠底融入下方层，适合压入阴影、纸张或纹理',
  'color-burn': '以颜色加深压暗下方层，加强暗部的颜色和对比',
  lighten: '以变亮融入下方层，只留下两者中更亮的部分',
  screen: '以滤色叠加到下方层，形成轻盈的发光或背光',
  'color-dodge': '以颜色减淡提亮下方层，形成强烈的高光',
  overlay: '以叠加增强明暗对比，同时保留下方层结构',
  'soft-light': '以柔光温和塑形，保留下方层的色调与层次',
  'hard-light': '以强光强烈塑形，按本层的明暗压暗或提亮下方层',
  difference: '以差值和下方层相减，形成反差强烈的颜色',
  exclusion: '以排除和下方层相减，效果比差值柔和',
  hue: '只把本层的色相带到下方层，保留下方层的明暗和饱和度',
  saturation: '只把本层的饱和度带到下方层',
  color: '把本层的色相和饱和度带到下方层，保留下方层的明暗，适合上色',
  luminosity: '只把本层的明暗带到下方层，保留下方层的颜色'
}

export function blendModeIntent(blendMode: BlendMode): string {
  const intent = BLEND_MODE_INTENTS[blendMode]
  if (intent === undefined) throw new Error(`Unsupported blend mode: ${String(blendMode)}`)
  return intent
}

// ---- The blend formulas, as the W3C compositing spec gives them and browsers and librsvg draw them ----

function separable(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply': return cb * cs
    case 'screen': return cb + cs - cb * cs
    case 'overlay': return separable('hard-light', cs, cb)
    case 'darken': return Math.min(cb, cs)
    case 'lighten': return Math.max(cb, cs)
    case 'color-dodge': return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))
    case 'color-burn': return cb >= 1 ? 1 : cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)
    case 'hard-light': return cs <= 0.5 ? cb * 2 * cs : separable('screen', cb, 2 * cs - 1)
    case 'soft-light': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb)
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)
      return cb + (2 * cs - 1) * (d - cb)
    }
    case 'difference': return Math.abs(cb - cs)
    case 'exclusion': return cb + cs - 2 * cb * cs
    default: return cs
  }
}

const lum = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b

function setLum(r: number, g: number, b: number, l: number, out: Float64Array): void {
  const d = l - lum(r, g, b)
  r += d
  g += d
  b += d
  // Clip the colour back into range keeping its luminosity.
  const lightness = lum(r, g, b)
  const low = Math.min(r, g, b)
  const high = Math.max(r, g, b)
  if (low < 0) {
    const scale = lightness / (lightness - low)
    r = lightness + (r - lightness) * scale
    g = lightness + (g - lightness) * scale
    b = lightness + (b - lightness) * scale
  }
  if (high > 1) {
    const scale = (1 - lightness) / (high - lightness)
    r = lightness + (r - lightness) * scale
    g = lightness + (g - lightness) * scale
    b = lightness + (b - lightness) * scale
  }
  out[0] = r
  out[1] = g
  out[2] = b
}

function setSat(r: number, g: number, b: number, s: number, out: Float64Array): void {
  const high = Math.max(r, g, b)
  const low = Math.min(r, g, b)
  const range = high - low
  const scale = (value: number): number => range > 0 ? (value - low) * s / range : 0
  out[0] = scale(r)
  out[1] = scale(g)
  out[2] = scale(b)
}

const sat = (r: number, g: number, b: number): number => Math.max(r, g, b) - Math.min(r, g, b)

/**
 * The colour a source colour over a backdrop colour gives in this mode,
 * channels 0–1, before it is mixed by the source's coverage. out takes
 * three numbers.
 */
export function blendColor(mode: BlendMode, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: Float64Array): void {
  switch (mode) {
    case 'hue':
      setSat(sr, sg, sb, sat(br, bg, bb), out)
      setLum(out[0]!, out[1]!, out[2]!, lum(br, bg, bb), out)
      return
    case 'saturation':
      setSat(br, bg, bb, sat(sr, sg, sb), out)
      setLum(out[0]!, out[1]!, out[2]!, lum(br, bg, bb), out)
      return
    case 'color':
      setLum(sr, sg, sb, lum(br, bg, bb), out)
      return
    case 'luminosity':
      setLum(br, bg, bb, lum(sr, sg, sb), out)
      return
    default:
      out[0] = separable(mode, br, sr)
      out[1] = separable(mode, bg, sg)
      out[2] = separable(mode, bb, sb)
  }
}

/**
 * Lays new colours over the pixels in this mode without changing their
 * transparency, as an adjustment layer's result is laid over what it
 * adjusts: each pixel takes the blend of its own colour and the new one,
 * weighted by the coverage (0–255, a pixel each) and the amount.
 */
export function blendInPlace(
  data: Uint8Array | Uint8ClampedArray,
  colors: Uint8Array | Uint8ClampedArray,
  mode: BlendMode,
  options: { readonly coverage?: Uint8Array | Uint8ClampedArray | null; readonly amount?: number } = {}
): void {
  const amount = options.amount ?? 1
  const coverage = options.coverage ?? null
  if (amount <= 0) return
  const out = new Float64Array(3)
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] === 0) continue
    const weight = coverage === null ? amount : amount * coverage[pixel]! / 255
    if (weight <= 0) continue
    const r = data[index]!
    const g = data[index + 1]!
    const b = data[index + 2]!
    blendColor(mode, r / 255, g / 255, b / 255, colors[index]! / 255, colors[index + 1]! / 255, colors[index + 2]! / 255, out)
    const mix = (original: number, value: number): number => {
      const blended = value <= 0 ? 0 : value >= 1 ? 255 : value * 255
      return Math.round(weight >= 1 ? blended : original + (blended - original) * weight)
    }
    data[index] = mix(r, out[0]!)
    data[index + 1] = mix(g, out[1]!)
    data[index + 2] = mix(b, out[2]!)
  }
}

/**
 * Lays one picture over another in a blend mode, as the canvas's
 * globalCompositeOperation and SVG's mix-blend-mode do (W3C source-over
 * with blending), in place. Pixels are RGBA, not premultiplied.
 */
export function compositeOver(below: Uint8Array | Uint8ClampedArray, above: Uint8Array | Uint8ClampedArray, mode: BlendMode): void {
  const out = new Float64Array(3)
  for (let index = 0; index < below.length; index += 4) {
    const as = above[index + 3]! / 255
    if (as <= 0) continue
    const ab = below[index + 3]! / 255
    const alpha = as + ab * (1 - as)
    const br = below[index]! / 255
    const bg = below[index + 1]! / 255
    const bb = below[index + 2]! / 255
    const sr = above[index]! / 255
    const sg = above[index + 1]! / 255
    const sb = above[index + 2]! / 255
    blendColor(mode, br, bg, bb, sr, sg, sb, out)
    const mix = (backdrop: number, source: number, blended: number): number => {
      const value = (1 - ab) * source + ab * Math.max(0, Math.min(1, blended))
      return Math.round(Math.max(0, Math.min(1, (as * value + ab * (1 - as) * backdrop) / alpha)) * 255)
    }
    below[index] = mix(br, sr, out[0]!)
    below[index + 1] = mix(bg, sg, out[1]!)
    below[index + 2] = mix(bb, sb, out[2]!)
    below[index + 3] = Math.round(alpha * 255)
  }
}
