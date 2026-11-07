import type { AdjustmentKind, AdjustmentSettings, BlendMode, CurvePoints, LayerAdjustment, LevelsChannel } from '../domain'
import { blendInPlace } from './blend-mode'

/*
 * The pixel math of Photoshop's adjustments, shared by the canvas, the
 * offscreen export renderer and Main's composite renderer, so what people
 * see, what they export and what a model receives match. Pixels are RGBA,
 * not premultiplied; alpha is never changed.
 *
 * Levels, curves and exposure follow Photoshop's published formulas;
 * brightness/contrast, vibrance, colour balance and black & white are not
 * published, so they are close, well-known approximations.
 */

type Pixels = Uint8Array | Uint8ClampedArray

export const ADJUSTMENT_LABELS: Readonly<Record<AdjustmentKind, string>> = {
  'brightness-contrast': '亮度/对比度',
  levels: '色阶',
  curves: '曲线',
  exposure: '曝光度',
  vibrance: '自然饱和度',
  'hue-saturation': '色相/饱和度',
  'color-balance': '色彩平衡',
  'black-white': '黑白',
  invert: '反相',
  desaturate: '去色'
}

const IDENTITY_LEVELS: LevelsChannel = { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }
const IDENTITY_CURVE: CurvePoints = [[0, 0], [255, 255]]

/** Each adjustment as Photoshop opens it: changing nothing, except black & white's own mix. */
export function defaultAdjustment(kind: AdjustmentKind): AdjustmentSettings {
  switch (kind) {
    case 'brightness-contrast': return { kind, brightness: 0, contrast: 0 }
    case 'levels': return { kind, channels: { rgb: IDENTITY_LEVELS, red: IDENTITY_LEVELS, green: IDENTITY_LEVELS, blue: IDENTITY_LEVELS } }
    case 'curves': return { kind, channels: { rgb: IDENTITY_CURVE, red: IDENTITY_CURVE, green: IDENTITY_CURVE, blue: IDENTITY_CURVE } }
    case 'exposure': return { kind, exposure: 0, offset: 0, gamma: 1 }
    case 'vibrance': return { kind, vibrance: 0, saturation: 0 }
    case 'hue-saturation': return { kind, hue: 0, saturation: 0, lightness: 0, colorize: null }
    case 'color-balance': return { kind, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }
    case 'black-white': return { kind, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }
    case 'invert': return { kind }
    case 'desaturate': return { kind }
  }
}

function clampByte(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

// ---- Tone curves, one lookup table per channel ----

function levelsCurve(channel: LevelsChannel): Float64Array {
  const table = new Float64Array(256)
  const span = channel.inputWhite - channel.inputBlack
  for (let value = 0; value < 256; value += 1) {
    const unit = clampUnit((value - channel.inputBlack) / span)
    const toned = Math.pow(unit, 1 / channel.gamma)
    table[value] = channel.outputBlack + toned * (channel.outputWhite - channel.outputBlack)
  }
  return table
}

/** A natural cubic spline through the points, flat past the first and last, as Photoshop draws a curve. */
export function curveTable(points: CurvePoints): Float64Array {
  const table = new Float64Array(256)
  const n = points.length
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const second = new Float64Array(n)
  if (n > 2) {
    // Solve for the second derivatives with natural ends (Thomas algorithm).
    const u = new Float64Array(n)
    for (let i = 1; i < n - 1; i += 1) {
      const sig = (xs[i]! - xs[i - 1]!) / (xs[i + 1]! - xs[i - 1]!)
      const p = sig * second[i - 1]! + 2
      second[i] = (sig - 1) / p
      const slope = (ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!) - (ys[i]! - ys[i - 1]!) / (xs[i]! - xs[i - 1]!)
      u[i] = (6 * slope / (xs[i + 1]! - xs[i - 1]!) - sig * u[i - 1]!) / p
    }
    for (let i = n - 2; i >= 0; i -= 1) second[i] = second[i]! * second[i + 1]! + u[i]!
  }
  let segment = 0
  for (let value = 0; value < 256; value += 1) {
    if (value <= xs[0]!) { table[value] = ys[0]!; continue }
    if (value >= xs[n - 1]!) { table[value] = ys[n - 1]!; continue }
    while (value > xs[segment + 1]!) segment += 1
    const x0 = xs[segment]!
    const x1 = xs[segment + 1]!
    const h = x1 - x0
    const a = (x1 - value) / h
    const b = (value - x0) / h
    table[value] = a * ys[segment]! + b * ys[segment + 1]! + ((a * a * a - a) * second[segment]! + (b * b * b - b) * second[segment + 1]!) * h * h / 6
  }
  return table
}

function brightnessContrastCurve(brightness: number, contrast: number): Float64Array {
  const table = new Float64Array(256)
  // Brightness bends the midtones and keeps black and white, as Photoshop's (non-legacy) one does.
  const gamma = Math.pow(2, -brightness / 100)
  // Contrast pivots about middle grey: 100 doubles the slope, −50 halves it.
  const slope = 1 + contrast / 100
  const pivot = 127 / 255
  for (let value = 0; value < 256; value += 1) {
    const bright = Math.pow(value / 255, gamma)
    table[value] = 255 * clampUnit(pivot + (bright - pivot) * slope)
  }
  return table
}

function toLinear(unit: number): number {
  return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4)
}

function toGamma(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
}

/** Photoshop's 曝光度 works in linear light: scale by 2^exposure, add the offset, then the gamma. */
function exposureCurve(exposure: number, offset: number, gamma: number): Float64Array {
  const table = new Float64Array(256)
  const gain = Math.pow(2, exposure)
  for (let value = 0; value < 256; value += 1) {
    const linear = Math.max(0, toLinear(value / 255) * gain + offset)
    table[value] = 255 * clampUnit(toGamma(clampUnit(Math.pow(linear, 1 / gamma))))
  }
  return table
}

function compose(first: Float64Array, then: Float64Array): Uint8Array {
  const table = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) table[value] = clampByte(then[clampByte(first[value]!)]!)
  return table
}

function rounded(curve: Float64Array): Uint8Array {
  const table = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) table[value] = clampByte(curve[value]!)
  return table
}

type ChannelTables = readonly [Uint8Array, Uint8Array, Uint8Array]

/** The tables of an adjustment that changes each channel on its own, or null for one that mixes them. */
function channelTables(settings: AdjustmentSettings): ChannelTables | null {
  switch (settings.kind) {
    case 'levels': {
      // Each channel's own levels first, then the composite RGB, as in Photoshop.
      const master = levelsCurve(settings.channels.rgb)
      return [compose(levelsCurve(settings.channels.red), master), compose(levelsCurve(settings.channels.green), master), compose(levelsCurve(settings.channels.blue), master)]
    }
    case 'curves': {
      const master = curveTable(settings.channels.rgb)
      return [compose(curveTable(settings.channels.red), master), compose(curveTable(settings.channels.green), master), compose(curveTable(settings.channels.blue), master)]
    }
    case 'brightness-contrast': {
      const table = rounded(brightnessContrastCurve(settings.brightness, settings.contrast))
      return [table, table, table]
    }
    case 'exposure': {
      const table = rounded(exposureCurve(settings.exposure, settings.offset, settings.gamma))
      return [table, table, table]
    }
    case 'invert': {
      const table = new Uint8Array(256)
      for (let value = 0; value < 256; value += 1) table[value] = 255 - value
      return [table, table, table]
    }
    default:
      return null
  }
}

// ---- Adjustments that mix the channels ----

/** Hue in degrees, saturation and lightness 0–1, as HSL. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 510
  if (max === min) return [0, 0, lightness]
  const delta = (max - min) / 255
  const saturation = lightness < 0.5 ? delta / ((max + min) / 255) : delta / (2 - (max + min) / 255)
  let hue: number
  if (max === r) hue = ((g - b) / (max - min)) % 6
  else if (max === g) hue = (b - r) / (max - min) + 2
  else hue = (r - g) / (max - min) + 4
  hue *= 60
  if (hue < 0) hue += 360
  return [hue, saturation, lightness]
}

function hueChannel(p: number, q: number, t: number): number {
  let hue = t
  if (hue < 0) hue += 1
  if (hue > 1) hue -= 1
  if (hue < 1 / 6) return p + (q - p) * 6 * hue
  if (hue < 1 / 2) return q
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6
  return p
}

/** RGB 0–255 (unrounded) for a hue in degrees and saturation and lightness 0–1. */
function hslToRgb(hue: number, saturation: number, lightness: number, out: Float64Array): void {
  if (saturation <= 0) { out[0] = out[1] = out[2] = lightness * 255; return }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const h = (((hue % 360) + 360) % 360) / 360
  out[0] = hueChannel(p, q, h + 1 / 3) * 255
  out[1] = hueChannel(p, q, h) * 255
  out[2] = hueChannel(p, q, h - 1 / 3) * 255
}

function hexRgb(color: string): readonly [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)]
}

/** Photoshop's lightness slider: towards white above 0, towards black below. */
function lighten(value: number, amount: number): number {
  return amount >= 0 ? value + (255 - value) * amount : value * (1 + amount)
}

type PixelFunction = (r: number, g: number, b: number, out: Float64Array) => void

function pixelFunction(settings: AdjustmentSettings): PixelFunction | null {
  switch (settings.kind) {
    case 'hue-saturation': {
      const colorize = settings.colorize
      if (colorize !== null) {
        const amount = colorize.lightness / 100
        const saturation = colorize.saturation / 100
        return (r, g, b, out) => {
          const lightness = lighten((Math.max(r, g, b) + Math.min(r, g, b)) / 2, amount) / 255
          hslToRgb(colorize.hue, saturation, lightness, out)
        }
      }
      const hue = settings.hue
      const increment = settings.saturation / 100
      const light = settings.lightness / 100
      return (r, g, b, out) => {
        let nr = r
        let ng = g
        let nb = b
        if (hue !== 0) {
          const [h, s, l] = rgbToHsl(r, g, b)
          hslToRgb(h + hue, s, l, out)
          nr = out[0]!; ng = out[1]!; nb = out[2]!
        }
        if (increment !== 0) {
          // The widely used reconstruction of Photoshop's saturation: −100 leaves the HSL lightness.
          const max = Math.max(nr, ng, nb)
          const min = Math.min(nr, ng, nb)
          const delta = (max - min) / 255
          if (delta > 0) {
            const value = (max + min) / 255
            const lightness = value / 2 * 255
            const saturation = value / 2 < 0.5 ? delta / value : delta / (2 - value)
            if (increment >= 0) {
              const alpha = 1 / (increment + saturation >= 1 ? saturation : 1 - increment) - 1
              nr += (nr - lightness) * alpha; ng += (ng - lightness) * alpha; nb += (nb - lightness) * alpha
            } else {
              nr = lightness + (nr - lightness) * (1 + increment); ng = lightness + (ng - lightness) * (1 + increment); nb = lightness + (nb - lightness) * (1 + increment)
            }
          }
        }
        if (light !== 0) { nr = lighten(nr, light); ng = lighten(ng, light); nb = lighten(nb, light) }
        out[0] = nr; out[1] = ng; out[2] = nb
      }
    }
    case 'vibrance': {
      const vibrance = settings.vibrance / 100
      const saturation = settings.saturation / 100
      return (r, g, b, out) => {
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        // Vibrance does most to the dullest colours and little to those already strong.
        const strength = max === 0 ? 0 : (max - min) / max
        const factor = (1 + (vibrance >= 0 ? vibrance * (1 - strength) : vibrance)) * (1 + saturation * 0.6)
        const luma = 0.299 * r + 0.587 * g + 0.114 * b
        out[0] = luma + (r - luma) * factor
        out[1] = luma + (g - luma) * factor
        out[2] = luma + (b - luma) * factor
      }
    }
    case 'color-balance': {
      // GIMP's colour balance, made to behave like Photoshop's: each range's push fades in and out with lightness.
      const ranges = [settings.shadows, settings.midtones, settings.highlights].map((range) => range.map((value) => value / 100))
      const preserve = settings.preserveLuminosity
      const ramp = 0.25
      const edge = 0.333
      const scale = 0.7
      return (r, g, b, out) => {
        const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 510
        const shadows = clampUnit((lightness - edge) / -ramp + 0.5) * scale
        const midtones = clampUnit((lightness - edge) / ramp + 0.5) * clampUnit((lightness + edge - 1) / -ramp + 0.5) * scale
        const highlights = clampUnit((lightness + edge - 1) / ramp + 0.5) * scale
        const channel = (value: number, index: number): number => 255 * clampUnit(value / 255 + ranges[0]![index]! * shadows + ranges[1]![index]! * midtones + ranges[2]![index]! * highlights)
        const nr = channel(r, 0)
        const ng = channel(g, 1)
        const nb = channel(b, 2)
        if (!preserve) { out[0] = nr; out[1] = ng; out[2] = nb; return }
        const [h, s] = rgbToHsl(nr, ng, nb)
        hslToRgb(h, s, lightness, out)
      }
    }
    case 'black-white': {
      const weights = { reds: settings.reds / 100, yellows: settings.yellows / 100, greens: settings.greens / 100, cyans: settings.cyans / 100, blues: settings.blues / 100, magentas: settings.magentas / 100 }
      const tint = settings.tint === null ? null : rgbToHsl(...hexRgb(settings.tint))
      return (r, g, b, out) => {
        // The grey is the lowest channel, plus the gap to the middle one weighted by the
        // secondary colour between the two highest, plus the gap to the highest weighted by its primary.
        let gray: number
        if (r >= g && r >= b) {
          gray = g >= b ? b + (g - b) * weights.yellows + (r - g) * weights.reds : g + (b - g) * weights.magentas + (r - b) * weights.reds
        } else if (g >= r && g >= b) {
          gray = r >= b ? b + (r - b) * weights.yellows + (g - r) * weights.greens : r + (b - r) * weights.cyans + (g - b) * weights.greens
        } else {
          gray = r >= g ? g + (r - g) * weights.magentas + (b - r) * weights.blues : r + (g - r) * weights.cyans + (b - g) * weights.blues
        }
        const value = clampByte(gray)
        if (tint === null) { out[0] = out[1] = out[2] = value; return }
        hslToRgb(tint[0], tint[1], value / 255, out)
      }
    }
    case 'desaturate':
      return (r, g, b, out) => { out[0] = out[1] = out[2] = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 }
    default:
      return null
  }
}

/**
 * A curve that changes nothing: from black to white along the diagonal. Points
 * on the diagonal with the ends moved in still change the picture, since the
 * curve is flat past them.
 */
function isStraightCurve(points: CurvePoints): boolean {
  const first = points[0]!
  const last = points[points.length - 1]!
  return first[0] === 0 && first[1] === 0 && last[0] === 255 && last[1] === 255 && points.every(([input, output]) => input === output)
}

/** Whether the adjustment leaves every pixel as it is. */
export function isNeutralAdjustment(settings: AdjustmentSettings): boolean {
  switch (settings.kind) {
    case 'brightness-contrast': return settings.brightness === 0 && settings.contrast === 0
    case 'exposure': return settings.exposure === 0 && settings.offset === 0 && settings.gamma === 1
    case 'vibrance': return settings.vibrance === 0 && settings.saturation === 0
    case 'hue-saturation': return settings.colorize === null && settings.hue === 0 && settings.saturation === 0 && settings.lightness === 0
    case 'color-balance': return [...settings.shadows, ...settings.midtones, ...settings.highlights].every((value) => value === 0)
    case 'levels': return Object.values(settings.channels).every((channel) => channel.inputBlack === 0 && channel.inputWhite === 255 && channel.gamma === 1 && channel.outputBlack === 0 && channel.outputWhite === 255)
    case 'curves': return Object.values(settings.channels).every(isStraightCurve)
    default: return false
  }
}

export interface AdjustOptions {
  /** How much of the adjustment each pixel takes, one byte a pixel (a mask or a selection). */
  readonly coverage?: Uint8Array | Uint8ClampedArray | null
  /** The layer's opacity: how much of the adjustment shows at full coverage. */
  readonly amount?: number
  /** An adjustment layer's blend mode: the adjusted colours are laid over the originals in it. */
  readonly blend?: BlendMode
}

/**
 * Applies one adjustment in place. With coverage or an amount below 1 the
 * result is mixed back with the original, as an adjustment layer's mask and
 * opacity do.
 */
export function adjustPixels(data: Pixels, settings: AdjustmentSettings, options: AdjustOptions = {}): void {
  const amount = options.amount ?? 1
  const coverage = options.coverage ?? null
  if (amount <= 0 || isNeutralAdjustment(settings)) return
  if (options.blend !== undefined && options.blend !== 'normal') {
    const adjusted = data.slice()
    adjustPixels(adjusted, settings)
    blendInPlace(data, adjusted, options.blend, { coverage, amount })
    return
  }
  const tables = channelTables(settings)
  // The adjusted picture is mixed with the original, so a value past the range is cut first, as the picture would have it.
  const mix = (pixel: number, value: number, original: number): number => {
    let weight = amount
    if (coverage !== null) weight *= coverage[pixel]! / 255
    const adjusted = value <= 0 ? 0 : value >= 255 ? 255 : value
    return weight >= 1 ? adjusted : original + (adjusted - original) * weight
  }
  const full = coverage === null && amount >= 1
  if (tables !== null) {
    const [red, green, blue] = tables
    for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
      const r = data[index]!
      const g = data[index + 1]!
      const b = data[index + 2]!
      if (full) {
        data[index] = red[r]!
        data[index + 1] = green[g]!
        data[index + 2] = blue[b]!
      } else {
        if (coverage !== null && coverage[pixel] === 0) continue
        data[index] = clampByte(mix(pixel, red[r]!, r))
        data[index + 1] = clampByte(mix(pixel, green[g]!, g))
        data[index + 2] = clampByte(mix(pixel, blue[b]!, b))
      }
    }
    return
  }
  const apply = pixelFunction(settings)
  if (apply === null) return
  const out = new Float64Array(3)
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] === 0) continue
    if (coverage !== null && coverage[pixel] === 0) continue
    const r = data[index]!
    const g = data[index + 1]!
    const b = data[index + 2]!
    apply(r, g, b, out)
    data[index] = clampByte(full ? out[0]! : mix(pixel, out[0]!, r))
    data[index + 1] = clampByte(full ? out[1]! : mix(pixel, out[1]!, g))
    data[index + 2] = clampByte(full ? out[2]! : mix(pixel, out[2]!, b))
  }
}

/** The layer adjustments that change anything, in order. */
export function activeAdjustments(adjustments: readonly LayerAdjustment[] | undefined): readonly LayerAdjustment[] {
  return (adjustments ?? []).filter((adjustment) => adjustment.enabled && !isNeutralAdjustment(adjustment.settings))
}

// ---- Histogram and automatic levels ----

export interface Histogram {
  readonly red: Uint32Array
  readonly green: Uint32Array
  readonly blue: Uint32Array
  /** The three channels together, as Photoshop's RGB histogram counts them. */
  readonly rgb: Uint32Array
  /** How many pixels were counted (fully transparent ones are left out). */
  readonly pixels: number
}

export function histogram(data: Pixels): Histogram {
  const red = new Uint32Array(256)
  const green = new Uint32Array(256)
  const blue = new Uint32Array(256)
  let pixels = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue
    red[data[index]!]! += 1
    green[data[index + 1]!]! += 1
    blue[data[index + 2]!]! += 1
    pixels += 1
  }
  const rgb = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) rgb[value] = red[value]! + green[value]! + blue[value]!
  return { red, green, blue, rgb, pixels }
}

const AUTO_CLIP = 0.001

function clipPoints(counts: Uint32Array, total: number): readonly [number, number] {
  const limit = total * AUTO_CLIP
  let low = 0
  let seen = 0
  // The white point stays two above the black and within the byte range, so a channel all at 254–255 still gives valid levels.
  while (low < 253 && seen + counts[low]! <= limit) { seen += counts[low]!; low += 1 }
  let high = 255
  seen = 0
  while (high > low + 2 && seen + counts[high]! <= limit) { seen += counts[high]!; high -= 1 }
  return [low, Math.max(low + 2, high)]
}

/**
 * Photoshop's 自动色调 ('tone': each channel stretched on its own, which
 * also corrects a colour cast) and 自动对比度 ('contrast': all three by the
 * same points), clipping the darkest and lightest 0.1%.
 */
export function autoLevels(counts: Histogram, mode: 'tone' | 'contrast'): Extract<AdjustmentSettings, { kind: 'levels' }> {
  const channel = ([inputBlack, inputWhite]: readonly [number, number]): LevelsChannel => ({ ...IDENTITY_LEVELS, inputBlack, inputWhite })
  if (counts.pixels === 0) return defaultAdjustment('levels') as Extract<AdjustmentSettings, { kind: 'levels' }>
  if (mode === 'contrast') {
    return { kind: 'levels', channels: { rgb: channel(clipPoints(counts.rgb, counts.pixels * 3)), red: IDENTITY_LEVELS, green: IDENTITY_LEVELS, blue: IDENTITY_LEVELS } }
  }
  return {
    kind: 'levels',
    channels: { rgb: IDENTITY_LEVELS, red: channel(clipPoints(counts.red, counts.pixels)), green: channel(clipPoints(counts.green, counts.pixels)), blue: channel(clipPoints(counts.blue, counts.pixels)) }
  }
}

/** The same stretch as curves: each channel's points straight from its black to its white. */
export function autoCurves(counts: Histogram): Extract<AdjustmentSettings, { kind: 'curves' }> {
  const levels = autoLevels(counts, 'tone').channels
  const curve = (channel: LevelsChannel): CurvePoints => channel.inputBlack === 0 && channel.inputWhite === 255 ? IDENTITY_CURVE : [[channel.inputBlack, 0], [channel.inputWhite, 255]]
  return { kind: 'curves', channels: { rgb: IDENTITY_CURVE, red: curve(levels.red), green: curve(levels.green), blue: curve(levels.blue) } }
}

// ---- Words for people and the Agent ----

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

/** A short description of the settings, such as 色阶（输入 12–240，中间调 1.20）. */
export function describeAdjustment(settings: AdjustmentSettings): string {
  const label = ADJUSTMENT_LABELS[settings.kind]
  const parts: string[] = []
  switch (settings.kind) {
    case 'brightness-contrast':
      parts.push(`亮度 ${signed(settings.brightness)}`, `对比度 ${signed(settings.contrast)}`)
      break
    case 'levels':
      for (const [name, channel] of [['RGB', settings.channels.rgb], ['红', settings.channels.red], ['绿', settings.channels.green], ['蓝', settings.channels.blue]] as const) {
        if (channel.inputBlack === 0 && channel.inputWhite === 255 && channel.gamma === 1 && channel.outputBlack === 0 && channel.outputWhite === 255) continue
        parts.push(`${name} 输入 ${channel.inputBlack}–${channel.inputWhite}，中间调 ${channel.gamma.toFixed(2)}，输出 ${channel.outputBlack}–${channel.outputWhite}`)
      }
      break
    case 'curves':
      for (const [name, points] of [['RGB', settings.channels.rgb], ['红', settings.channels.red], ['绿', settings.channels.green], ['蓝', settings.channels.blue]] as const) {
        if (isStraightCurve(points)) continue
        parts.push(`${name} ${points.map(([input, output]) => `${input}→${output}`).join(' ')}`)
      }
      break
    case 'exposure':
      parts.push(`曝光度 ${signed(Number(settings.exposure.toFixed(2)))}`, `位移 ${signed(Number(settings.offset.toFixed(4)))}`, `灰度系数 ${settings.gamma.toFixed(2)}`)
      break
    case 'vibrance':
      parts.push(`自然饱和度 ${signed(settings.vibrance)}`, `饱和度 ${signed(settings.saturation)}`)
      break
    case 'hue-saturation':
      if (settings.colorize !== null) parts.push(`着色 色相 ${settings.colorize.hue}，饱和度 ${settings.colorize.saturation}，明度 ${signed(settings.colorize.lightness)}`)
      else parts.push(`色相 ${signed(settings.hue)}`, `饱和度 ${signed(settings.saturation)}`, `明度 ${signed(settings.lightness)}`)
      break
    case 'color-balance':
      for (const [name, range] of [['阴影', settings.shadows], ['中间调', settings.midtones], ['高光', settings.highlights]] as const) {
        if (range.every((value) => value === 0)) continue
        parts.push(`${name} ${range.map(signed).join(' ')}`)
      }
      if (!settings.preserveLuminosity) parts.push('不保持明度')
      break
    case 'black-white':
      parts.push(`红 ${settings.reds}% 黄 ${settings.yellows}% 绿 ${settings.greens}% 青 ${settings.cyans}% 蓝 ${settings.blues}% 洋红 ${settings.magentas}%`)
      if (settings.tint !== null) parts.push(`色调 ${settings.tint}`)
      break
    case 'invert':
    case 'desaturate':
      break
  }
  return parts.length === 0 ? label : `${label}（${parts.join('，')}）`
}

// ---- A layer's own adjustments ----

/** The selection clips a layer's adjustments were made in. */
export function adjustmentClipIds(adjustments: readonly LayerAdjustment[] | undefined): string[] {
  return [...new Set(activeAdjustments(adjustments).flatMap((adjustment) => adjustment.clip === undefined ? [] : [adjustment.clip]))]
}

/**
 * A layer's adjustments in order over its pixels as drawn. coverageOf gives
 * a clip's coverage at the same size; an adjustment whose clip it cannot
 * give is skipped, so callers wait for clips before drawing.
 */
export function adjustLayerPixels(data: Pixels, adjustments: readonly LayerAdjustment[] | undefined, coverageOf: (clipId: string) => Uint8Array | Uint8ClampedArray | null = () => null): void {
  for (const adjustment of activeAdjustments(adjustments)) {
    if (adjustment.clip === undefined) { adjustPixels(data, adjustment.settings); continue }
    const coverage = coverageOf(adjustment.clip)
    if (coverage !== null) adjustPixels(data, adjustment.settings, { coverage })
  }
}

/**
 * Coverage from a grayscale picture at another size, sampled bilinearly at
 * pixel centres: an adjustment layer's mask over the part of the canvas being
 * drawn. map turns a pixel of the result into a point in the mask's pixels.
 */
export function sampleCoverage(
  mask: { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray },
  width: number,
  height: number,
  map: { readonly scaleX: number; readonly scaleY: number; readonly offsetX: number; readonly offsetY: number }
): Uint8Array<ArrayBuffer> {
  const coverage = new Uint8Array(width * height)
  if (mask.width === width && mask.height === height && map.scaleX === 1 && map.scaleY === 1 && map.offsetX === 0 && map.offsetY === 0) {
    coverage.set(mask.data)
    return coverage
  }
  const columns = new Int32Array(width * 2)
  const columnWeights = new Float32Array(width)
  for (let x = 0; x < width; x += 1) {
    const u = Math.min(mask.width - 1, Math.max(0, (x + 0.5) * map.scaleX + map.offsetX - 0.5))
    const left = Math.floor(u)
    columns[x * 2] = left
    columns[x * 2 + 1] = Math.min(mask.width - 1, left + 1)
    columnWeights[x] = u - left
  }
  for (let y = 0; y < height; y += 1) {
    const v = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * map.scaleY + map.offsetY - 0.5))
    const top = Math.floor(v)
    const bottom = Math.min(mask.height - 1, top + 1)
    const rowWeight = v - top
    const topRow = top * mask.width
    const bottomRow = bottom * mask.width
    for (let x = 0; x < width; x += 1) {
      const left = columns[x * 2]!
      const right = columns[x * 2 + 1]!
      const weight = columnWeights[x]!
      const upper = mask.data[topRow + left]! + (mask.data[topRow + right]! - mask.data[topRow + left]!) * weight
      const lower = mask.data[bottomRow + left]! + (mask.data[bottomRow + right]! - mask.data[bottomRow + left]!) * weight
      coverage[y * width + x] = Math.round(upper + (lower - upper) * rowWeight)
    }
  }
  return coverage
}
