import type { AdjustmentLayer as PsdAdjustment, HueSaturationAdjustmentChannel, LevelsAdjustmentChannel } from 'ag-psd'
import type { AdjustmentSettings, CurvePoints, LevelsChannel } from '../../domain'
import { adjustmentSettingsSchema } from '../../domain'

/*
 * Our adjustments as Photoshop's adjustment layers and back, for exporting
 * and opening PSDs. 去色 has no adjustment layer of its own in Photoshop; it
 * goes out as 色相/饱和度 with saturation at −100, which does the same.
 *
 * ag-psd reads and writes Photoshop's 色相/饱和度 block as seven records of
 * seven numbers. The first is really the colorize flag, the colorize hue,
 * saturation and lightness, then the master hue, saturation and lightness;
 * the other six are the colour ranges, each its four range ends and three
 * settings.
 */

/** Photoshop's default colour ranges for reds, yellows, greens, cyans, blues and magentas. */
const HUE_RANGES = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]] as const
const RANGE_NAMES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const

function range(index: number): HueSaturationAdjustmentChannel {
  const [a, b, c, d] = HUE_RANGES[index]!
  return { a, b, c, d, hue: 0, saturation: 0, lightness: 0 }
}

function levelsOut(channel: LevelsChannel): LevelsAdjustmentChannel {
  return { shadowInput: channel.inputBlack, highlightInput: channel.inputWhite, shadowOutput: channel.outputBlack, highlightOutput: channel.outputWhite, midtoneInput: channel.gamma }
}

function levelsIn(channel: LevelsAdjustmentChannel | undefined): LevelsChannel {
  if (channel === undefined) return { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }
  return { inputBlack: channel.shadowInput, inputWhite: channel.highlightInput, gamma: channel.midtoneInput, outputBlack: channel.shadowOutput, outputWhite: channel.highlightOutput }
}

function curveIn(points: readonly { readonly input: number; readonly output: number }[] | undefined): CurvePoints {
  if (points === undefined || points.length < 2) return [[0, 0], [255, 255]]
  return [...points].sort((left, right) => left.input - right.input).map((point) => [point.input, point.output] as [number, number]) as CurvePoints
}

function hex(color: { readonly r: number; readonly g: number; readonly b: number }): string {
  return `#${[color.r, color.g, color.b].map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function rgb(color: string): { r: number; g: number; b: number } {
  return { r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) }
}

/** The adjustment as Photoshop's adjustment layer has it. */
export function toPsdAdjustment(settings: AdjustmentSettings): PsdAdjustment {
  switch (settings.kind) {
    case 'brightness-contrast':
      return { type: 'brightness/contrast', brightness: settings.brightness, contrast: settings.contrast, meanValue: 127, useLegacy: false, labColorOnly: false, auto: false }
    case 'levels':
      return { type: 'levels', rgb: levelsOut(settings.channels.rgb), red: levelsOut(settings.channels.red), green: levelsOut(settings.channels.green), blue: levelsOut(settings.channels.blue) }
    case 'curves': {
      const out = (points: CurvePoints) => points.map(([input, output]) => ({ input, output }))
      return { type: 'curves', rgb: out(settings.channels.rgb), red: out(settings.channels.red), green: out(settings.channels.green), blue: out(settings.channels.blue) }
    }
    case 'exposure':
      return { type: 'exposure', exposure: settings.exposure, offset: settings.offset, gamma: settings.gamma }
    case 'vibrance':
      return { type: 'vibrance', vibrance: settings.vibrance, saturation: settings.saturation }
    case 'hue-saturation':
    case 'desaturate': {
      const values = settings.kind === 'desaturate' ? { hue: 0, saturation: -100, lightness: 0, colorize: null } : settings
      const colorize = values.colorize
      const master: HueSaturationAdjustmentChannel = {
        // The colorize flag is the high byte of the first number.
        a: colorize === null ? 0 : 256,
        b: colorize?.hue ?? 0,
        c: colorize?.saturation ?? 25,
        d: colorize?.lightness ?? 0,
        hue: values.hue,
        saturation: values.saturation,
        lightness: values.lightness
      }
      return { type: 'hue/saturation', master, ...Object.fromEntries(RANGE_NAMES.map((name, index) => [name, range(index)])) }
    }
    case 'color-balance': {
      const balance = ([cyanRed, magentaGreen, yellowBlue]: readonly [number, number, number]) => ({ cyanRed, magentaGreen, yellowBlue })
      return { type: 'color balance', shadows: balance(settings.shadows), midtones: balance(settings.midtones), highlights: balance(settings.highlights), preserveLuminosity: settings.preserveLuminosity }
    }
    case 'black-white':
      return {
        type: 'black & white', reds: settings.reds, yellows: settings.yellows, greens: settings.greens, cyans: settings.cyans, blues: settings.blues, magentas: settings.magentas,
        useTint: settings.tint !== null, tintColor: rgb(settings.tint ?? '#E1D3B3')
      }
    case 'invert':
      return { type: 'invert' }
  }
}

export interface ImportedAdjustment {
  readonly settings: AdjustmentSettings
  /** What could not come across, said once per layer. */
  readonly simplified: string | null
}

/** A Photoshop adjustment layer as ours, or null for a kind we do not have. */
export function fromPsdAdjustment(adjustment: PsdAdjustment): ImportedAdjustment | null {
  let settings: unknown
  let simplified: string | null = null
  switch (adjustment.type) {
    case 'brightness/contrast':
      settings = { kind: 'brightness-contrast', brightness: Math.round(adjustment.brightness ?? 0), contrast: Math.round(adjustment.contrast ?? 0) }
      if (adjustment.useLegacy === true) simplified = '使用旧版的亮度/对比度按新版导入'
      break
    case 'levels':
      settings = { kind: 'levels', channels: { rgb: levelsIn(adjustment.rgb), red: levelsIn(adjustment.red), green: levelsIn(adjustment.green), blue: levelsIn(adjustment.blue) } }
      break
    case 'curves':
      settings = { kind: 'curves', channels: { rgb: curveIn(adjustment.rgb), red: curveIn(adjustment.red), green: curveIn(adjustment.green), blue: curveIn(adjustment.blue) } }
      break
    case 'exposure':
      settings = { kind: 'exposure', exposure: adjustment.exposure ?? 0, offset: adjustment.offset ?? 0, gamma: adjustment.gamma ?? 1 }
      break
    case 'vibrance':
      settings = { kind: 'vibrance', vibrance: Math.round(adjustment.vibrance ?? 0), saturation: Math.round(adjustment.saturation ?? 0) }
      break
    case 'hue/saturation': {
      const master = adjustment.master
      const colorized = master !== undefined && master.a !== 0
      settings = {
        kind: 'hue-saturation',
        hue: master?.hue ?? 0,
        saturation: master?.saturation ?? 0,
        lightness: master?.lightness ?? 0,
        colorize: colorized ? { hue: master.b, saturation: master.c, lightness: master.d } : null
      }
      if (RANGE_NAMES.some((name) => { const channel = adjustment[name]; return channel !== undefined && (channel.hue !== 0 || channel.saturation !== 0 || channel.lightness !== 0) })) {
        simplified = '色相/饱和度里单独调的色系没有带过来'
      }
      break
    }
    case 'color balance': {
      const balance = (values: { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined) => [values?.cyanRed ?? 0, values?.magentaGreen ?? 0, values?.yellowBlue ?? 0]
      settings = { kind: 'color-balance', shadows: balance(adjustment.shadows), midtones: balance(adjustment.midtones), highlights: balance(adjustment.highlights), preserveLuminosity: adjustment.preserveLuminosity ?? true }
      break
    }
    case 'black & white':
      settings = {
        kind: 'black-white', reds: Math.round(adjustment.reds ?? 40), yellows: Math.round(adjustment.yellows ?? 60), greens: Math.round(adjustment.greens ?? 40),
        cyans: Math.round(adjustment.cyans ?? 60), blues: Math.round(adjustment.blues ?? 20), magentas: Math.round(adjustment.magentas ?? 80),
        tint: adjustment.useTint === true && adjustment.tintColor !== undefined && 'r' in adjustment.tintColor ? hex(adjustment.tintColor) : null
      }
      break
    case 'invert':
      settings = { kind: 'invert' }
      break
    default:
      return null
  }
  const parsed = adjustmentSettingsSchema.safeParse(settings)
  return parsed.success ? { settings: parsed.data, simplified } : null
}
