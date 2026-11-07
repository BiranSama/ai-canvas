import { describe, expect, it } from 'vitest'
import { blendModeSchema } from '../../src/domain'
import { adjustPixels } from '../../src/shared/adjustments'
import {
  BLEND_MODE_GROUPS,
  BLEND_MODES,
  blendColor,
  blendInPlace,
  blendModeIntent,
  blendModeLabel,
  blendModeToCanvasOperation,
  blendModeToSvgStyle,
  elementSupportsBlendMode,
  resolveBlendMode
} from '../../src/shared/blend-mode'

/** One colour over another in a mode, as bytes. */
function blend(mode: (typeof BLEND_MODES)[number], backdrop: readonly number[], source: readonly number[]): number[] {
  const out = new Float64Array(3)
  blendColor(mode, backdrop[0]! / 255, backdrop[1]! / 255, backdrop[2]! / 255, source[0]! / 255, source[1]! / 255, source[2]! / 255, out)
  return [...out].map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255))
}

describe('blend modes', () => {
  it('has Photoshop\'s sixteen native modes in its order and groups, each mapped exactly', () => {
    expect(BLEND_MODES).toEqual(blendModeSchema.options)
    expect(BLEND_MODE_GROUPS.flat()).toEqual([...BLEND_MODES])
    expect(blendModeToCanvasOperation('normal')).toBe('source-over')
    for (const mode of BLEND_MODES.slice(1)) {
      expect(blendModeToCanvasOperation(mode)).toBe(mode)
      expect(blendModeToSvgStyle(mode)).toBe(` style="mix-blend-mode:${mode}"`)
      expect(blendModeIntent(mode).length).toBeGreaterThan(0)
    }
    expect(() => blendModeToCanvasOperation('linear-burn' as never)).toThrow(/Unsupported blend mode/)
    expect(blendModeToSvgStyle('normal')).toBe('')
    expect([blendModeLabel('multiply'), blendModeLabel('color-dodge'), blendModeLabel('luminosity')]).toEqual(['正片叠底', '颜色减淡', '明度'])
  })

  it('resolves a missing mode to normal and allows modes on drawn layers and adjustment layers', () => {
    expect(resolveBlendMode({})).toBe('normal')
    expect(resolveBlendMode({ blendMode: 'overlay' })).toBe('overlay')
    for (const type of ['text', 'image', 'shape', 'sketch', 'light', 'adjustment'] as const) expect(elementSupportsBlendMode(type)).toBe(true)
    for (const type of ['placeholder', 'mask', 'group'] as const) expect(elementSupportsBlendMode(type)).toBe(false)
  })

  it('follows the W3C formulas, which the browser and librsvg also draw', () => {
    // Values librsvg gave for rgb(60,150,220) over rgb(200,80,40).
    const backdrop = [200, 80, 40]
    const source = [60, 150, 220]
    const expected: Record<string, number[]> = {
      multiply: [47, 47, 35], screen: [213, 183, 225], overlay: [171, 94, 69], darken: [60, 80, 40], lighten: [200, 150, 220],
      'color-dodge': [255, 195, 255], 'color-burn': [21, 0, 5], 'hard-light': [94, 111, 196], 'soft-light': [177, 91, 84],
      difference: [140, 70, 180], exclusion: [166, 136, 191], hue: [41, 131, 201], saturation: [200, 80, 40], color: [41, 131, 201], luminosity: [219, 99, 59]
    }
    for (const [mode, values] of Object.entries(expected)) {
      const result = blend(mode as never, backdrop, source)
      result.forEach((value, channel) => expect(Math.abs(value - values[channel]!), `${mode} channel ${channel}`).toBeLessThanOrEqual(1))
    }
    expect(blend('normal', backdrop, source)).toEqual(source)
  })

  it('lays colours over pixels in a mode without touching their transparency', () => {
    const data = new Uint8ClampedArray([200, 80, 40, 255, 200, 80, 40, 128, 0, 0, 0, 0])
    const colors = new Uint8ClampedArray([60, 150, 220, 255, 60, 150, 220, 255, 60, 150, 220, 255])
    blendInPlace(data, colors, 'multiply', { coverage: new Uint8Array([255, 0, 255]) })
    expect([...data]).toEqual([47, 47, 35, 255, 200, 80, 40, 128, 0, 0, 0, 0])
  })

  it('blends an adjustment layer\'s result in its mode: curves brightening in 明度 keeps the colours', () => {
    const pixel = (): Uint8ClampedArray => new Uint8ClampedArray([180, 60, 40, 255])
    const brighten = { kind: 'curves' as const, channels: { rgb: [[0, 0], [128, 200], [255, 255]] as [number, number][], red: [[0, 0], [255, 255]] as [number, number][], green: [[0, 0], [255, 255]] as [number, number][], blue: [[0, 0], [255, 255]] as [number, number][] } }
    const normal = pixel()
    adjustPixels(normal, brighten)
    const luminosity = pixel()
    adjustPixels(luminosity, brighten, { blend: 'luminosity' })
    const lum = (data: Uint8ClampedArray): number => 0.3 * data[0]! + 0.59 * data[1]! + 0.11 * data[2]!
    // Both brighten by the same amount; 明度 moves the channels together, so the colour stays, where plain curves lift each channel its own way.
    expect(Math.abs(lum(luminosity) - lum(normal))).toBeLessThanOrEqual(2)
    expect(luminosity[0]! - luminosity[1]!).toBeCloseTo(120, -0.5)
    expect(luminosity[1]! - luminosity[2]!).toBeCloseTo(20, -0.5)
    expect(Math.abs(normal[0]! - normal[1]! - 120)).toBeGreaterThan(5)
    // Main hands in a Buffer, whose slice is a view: the result must be the same.
    const buffer = Buffer.from([180, 60, 40, 255])
    adjustPixels(buffer, brighten, { blend: 'luminosity' })
    expect([...buffer]).toEqual([...luminosity])
    // At half opacity it is halfway.
    const half = pixel()
    adjustPixels(half, brighten, { blend: 'luminosity', amount: 0.5 })
    expect(Math.abs(half[1]! - (60 + luminosity[1]!) / 2)).toBeLessThanOrEqual(1)
  })

  it('lays even an adjustment that changes nothing over the picture in another mode, as an empty curve in 滤色 brightens', () => {
    const gray = new Uint8ClampedArray([128, 128, 128, 255])
    adjustPixels(gray, { kind: 'brightness-contrast', brightness: 0, contrast: 0 }, { blend: 'multiply' })
    expect([...gray]).toEqual([64, 64, 64, 255])
    const plain = new Uint8ClampedArray([128, 128, 128, 255])
    adjustPixels(plain, { kind: 'brightness-contrast', brightness: 0, contrast: 0 })
    expect([...plain]).toEqual([128, 128, 128, 255])
  })
})
