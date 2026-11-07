import { describe, expect, it } from 'vitest'
import { filterSettingsSchema, layerAdjustmentSchema, type FilterSettings } from '../../src/domain'
import { activeAdjustments, adjustLayerPixels, hasSpatialFilters, isFilterSettings, layerSettingsLabel } from '../../src/shared/adjustments'
import { applyFilter, defaultFilter, describeFilter, isNeutralFilter } from '../../src/shared/filters'

/** A width × height picture, each pixel from the function. */
function picture(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4)
  return data
}

const at = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)]

describe('filters', () => {
  it('blurs like a Gaussian: the total stays, a flat picture stays flat and the box edges stay opaque', () => {
    // A thin line, so the profile across it is the one-dimensional Gaussian, tall enough to measure in bytes.
    const size = 41
    const line = picture(size, 3, (x) => x === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255])
    applyFilter(line, size, 3, { kind: 'gaussian-blur', radius: 3 })
    let total = 0
    for (let x = 0; x < size; x += 1) total += at(line, size, x, 1)[0]!
    expect(Math.abs(total - 255)).toBeLessThan(12)
    // About one sigma away, a Gaussian falls to about 60% of its peak; two sigma, about 14%.
    const peak = at(line, size, 20, 1)[0]!
    expect(peak).toBeGreaterThan(25)
    expect(at(line, size, 23, 1)[0]! / peak).toBeGreaterThan(0.45)
    expect(at(line, size, 23, 1)[0]! / peak).toBeLessThan(0.72)
    expect(at(line, size, 26, 1)[0]! / peak).toBeLessThan(0.3)
    const flat = picture(16, 16, () => [90, 140, 200, 255])
    applyFilter(flat, 16, 16, { kind: 'gaussian-blur', radius: 6 })
    expect(at(flat, 16, 0, 0)).toEqual([90, 140, 200, 255])
    expect(at(flat, 16, 15, 8)).toEqual([90, 140, 200, 255])
  })

  it('blurs a cut-out without bleeding black from its transparent pixels', () => {
    const cutout = picture(21, 21, (x) => x < 10 ? [255, 0, 0, 255] : [0, 0, 0, 0])
    applyFilter(cutout, 21, 21, { kind: 'gaussian-blur', radius: 2 })
    const edge = at(cutout, 21, 10, 10)
    expect(edge[3]).toBeGreaterThan(40)
    expect(edge[3]).toBeLessThan(215)
    expect(edge.slice(0, 3)).toEqual([255, 0, 0])
  })

  it('scales its radius: half the pixels blur half as far, so the canvas matches the export', () => {
    const full = picture(64, 1, (x) => x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255])
    const half = picture(32, 1, (x) => x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255])
    applyFilter(full, 64, 1, { kind: 'gaussian-blur', radius: 4 })
    applyFilter(half, 32, 1, { kind: 'gaussian-blur', radius: 4 }, { scale: 0.5 })
    for (let x = 0; x < 32; x += 1) expect(Math.abs(at(half, 32, x, 0)[0]! - (at(full, 64, x * 2, 0)[0]! + at(full, 64, x * 2 + 1, 0)[0]!) / 2)).toBeLessThan(12)
  })

  it('sharpens an edge, leaving differences below the threshold alone', () => {
    const edge = (): Uint8ClampedArray => picture(20, 4, (x) => x < 10 ? [100, 100, 100, 255] : [150, 150, 150, 255])
    const sharp = edge()
    applyFilter(sharp, 20, 4, { kind: 'unsharp-mask', amount: 100, radius: 1.5, threshold: 0 })
    expect(at(sharp, 20, 9, 1)[0]).toBeLessThan(100)
    expect(at(sharp, 20, 10, 1)[0]).toBeGreaterThan(150)
    expect(at(sharp, 20, 0, 1)[0]).toBe(100)
    const held = edge()
    applyFilter(held, 20, 4, { kind: 'unsharp-mask', amount: 100, radius: 1.5, threshold: 60 })
    expect([...held]).toEqual([...edge()])
  })

  it('adds the same grain each time, fixed to the output pixel, and keeps transparency', () => {
    const settings: FilterSettings = { kind: 'add-noise', amount: 20, distribution: 'uniform', monochromatic: false, seed: 7 }
    const gray = (): Uint8ClampedArray => picture(8, 8, (x) => x === 0 ? [128, 128, 128, 0] : [128, 128, 128, 255])
    const once = gray()
    const again = gray()
    applyFilter(once, 8, 8, settings)
    applyFilter(again, 8, 8, settings)
    expect([...once]).toEqual([...again])
    expect(at(once, 8, 0, 3)).toEqual([128, 128, 128, 0])
    let changed = 0
    for (let index = 4; index < once.length; index += 4) if (once[index] !== 128) changed += 1
    expect(changed).toBeGreaterThan(40)
    // Uniform at 20% stays within ±25.5 levels.
    for (let index = 0; index < once.length; index += 4) if (once[index + 3] !== 0) expect(Math.abs(once[index]! - 128)).toBeLessThanOrEqual(26)
    // At half the pixels each one takes the grain of the output pixel at its centre.
    const small = picture(4, 4, () => [128, 128, 128, 255])
    applyFilter(small, 4, 4, settings, { scale: 0.5 })
    expect(at(small, 4, 1, 2)).toEqual(at(once, 8, 3, 5))
    const mono = gray()
    applyFilter(mono, 8, 8, { ...settings, monochromatic: true })
    const pixel = at(mono, 8, 4, 4)
    expect(pixel[0]).toBe(pixel[1])
    expect(pixel[1]).toBe(pixel[2])
    const other = gray()
    applyFilter(other, 8, 8, { ...settings, seed: 8 })
    expect([...other]).not.toEqual([...once])
  })

  it('smears along its angle only', () => {
    const line = (): Uint8ClampedArray => picture(41, 41, (x) => x === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255])
    const across = line()
    applyFilter(across, 41, 41, { kind: 'motion-blur', angle: 0, distance: 10 })
    expect(at(across, 41, 20, 20)[0]).toBeLessThan(80)
    expect(at(across, 41, 24, 20)[0]).toBeGreaterThan(5)
    expect(at(across, 41, 30, 20)[0]).toBe(0)
    const along = line()
    applyFilter(along, 41, 41, { kind: 'motion-blur', angle: 90, distance: 10 })
    expect(at(along, 41, 20, 20)[0]).toBe(255)
    expect(at(along, 41, 22, 20)[0]).toBe(0)
  })

  it('works only inside the selection it was made in', () => {
    const data = picture(8, 1, (x) => x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])
    const coverage = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0])
    applyFilter(data, 8, 1, { kind: 'gaussian-blur', radius: 2 }, { coverage })
    expect(at(data, 8, 1, 0)[0]).toBeLessThan(220)
    expect(at(data, 8, 5, 0)[0]).toBe(255)
    expect(at(data, 8, 6, 0)[0]).toBe(0)
  })

  it('sits in a layer\'s list with the adjustments, its mask going on after the ones that move pixels', () => {
    for (const kind of ['gaussian-blur', 'unsharp-mask', 'add-noise', 'motion-blur'] as const) {
      const settings = defaultFilter(kind)
      expect(filterSettingsSchema.safeParse(settings).success).toBe(true)
      expect(layerAdjustmentSchema.safeParse({ id: '0f0f0f0f-0000-4000-8000-0000000000aa', enabled: true, settings }).success).toBe(true)
      expect(isFilterSettings(settings)).toBe(true)
      expect(isNeutralFilter(settings)).toBe(false)
      expect(describeFilter(settings).length).toBeGreaterThan(0)
    }
    expect(filterSettingsSchema.safeParse({ kind: 'gaussian-blur', radius: 300 }).success).toBe(false)
    expect(layerSettingsLabel({ kind: 'gaussian-blur', radius: 2 })).toBe('高斯模糊')
    const list = [
      { id: '0f0f0f0f-0000-4000-8000-0000000000a1', enabled: true, settings: { kind: 'invert' as const } },
      { id: '0f0f0f0f-0000-4000-8000-0000000000a2', enabled: true, settings: defaultFilter('add-noise') }
    ]
    expect(hasSpatialFilters(list)).toBe(false)
    expect(hasSpatialFilters([...list, { id: '0f0f0f0f-0000-4000-8000-0000000000a3', enabled: false, settings: defaultFilter('gaussian-blur') }])).toBe(false)
    expect(hasSpatialFilters([...list, { id: '0f0f0f0f-0000-4000-8000-0000000000a3', enabled: true, settings: defaultFilter('gaussian-blur') }])).toBe(true)
    expect(activeAdjustments(list)).toHaveLength(2)
    // In order: invert, then the blur sees the inverted picture.
    const data = picture(4, 1, () => [0, 0, 0, 255])
    adjustLayerPixels(data, [list[0]!, { id: '0f0f0f0f-0000-4000-8000-0000000000a3', enabled: true, settings: { kind: 'gaussian-blur', radius: 1 } }], { width: 4, height: 1, scale: 1 })
    expect(at(data, 4, 2, 0)).toEqual([255, 255, 255, 255])
  })
})
