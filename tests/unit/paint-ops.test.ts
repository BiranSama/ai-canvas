import { describe, expect, it } from 'vitest'
import { paintOpSchema, type PaintOp } from '../../src/domain'
import { applyPaintOp, applyPaintOps, startsWithBaked, StrokeRasterizer } from '../../src/shared/paint-ops'

const ID = '00000000-0000-4000-8000-000000000001'

function canvas(width: number, height: number, rgba: readonly [number, number, number, number] = [0, 0, 0, 0]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index)
  return pixels
}

function pixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const index = (y * width + x) * 4
  return [...pixels.subarray(index, index + 4)]
}

function stroke(points: number[], overrides: Partial<Extract<PaintOp, { kind: 'stroke' }>> = {}): Extract<PaintOp, { kind: 'stroke' }> {
  return { id: ID, kind: 'stroke', tool: 'brush', color: '#FF0000', size: 4, hardness: 1, opacity: 1, flow: 1, pressure: false, lockAlpha: false, points, ...overrides }
}

describe('painting on layer pixels', () => {
  it('lays a hard round stroke along the points and nothing beside it', () => {
    const pixels = canvas(20, 20)
    applyPaintOp(pixels, 20, 20, stroke([2, 10, 1, 18, 10, 1]))
    expect(pixel(pixels, 20, 10, 10)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, 20, 10, 9)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, 20, 10, 5)[3]).toBe(0)
  })

  it('gives the same bytes drawn live point by point as replayed at once', () => {
    const points = [1, 1, 0.2, 9, 14, 0.9, 30, 6, 0.5, 33, 30, 1]
    const op = stroke(points, { size: 9, hardness: 0.3, opacity: 0.7, flow: 0.4, pressure: true })
    const replayed = canvas(40, 40, [10, 200, 30, 255])
    applyPaintOp(replayed, 40, 40, op)
    const live = canvas(40, 40, [10, 200, 30, 255])
    const rasterizer = new StrokeRasterizer(live, 40, 40, op)
    const rects = []
    for (let index = 0; index < points.length; index += 3) rects.push(rasterizer.addPoint(points[index]!, points[index + 1]!, points[index + 2]!))
    expect([...live]).toEqual([...replayed])
    expect(rects.every((rect) => rect !== null)).toBe(true)
  })

  it('builds up with flow but never past the stroke opacity', () => {
    const pixels = canvas(30, 10)
    applyPaintOp(pixels, 30, 10, stroke([2, 5, 1, 28, 5, 1, 2, 5, 1, 28, 5, 1], { size: 6, opacity: 0.5, flow: 0.3 }))
    const alpha = pixel(pixels, 30, 15, 5)[3]!
    expect(alpha).toBeGreaterThan(100)
    expect(alpha).toBeLessThanOrEqual(128)
  })

  it('erases to transparency, and on a transparency-locked layer paints its colour instead', () => {
    const erased = canvas(20, 20, [255, 255, 255, 255])
    applyPaintOp(erased, 20, 20, stroke([10, 2, 1, 10, 18, 1], { tool: 'eraser' }))
    expect(pixel(erased, 20, 10, 10)).toEqual([255, 255, 255, 0])
    expect(pixel(erased, 20, 2, 10)).toEqual([255, 255, 255, 255])
    const locked = canvas(20, 20, [255, 255, 255, 255])
    applyPaintOp(locked, 20, 20, stroke([10, 2, 1, 10, 18, 1], { tool: 'eraser', color: '#000000', lockAlpha: true }))
    expect(pixel(locked, 20, 10, 10)).toEqual([0, 0, 0, 255])
  })

  it('leaves transparent pixels alone on a transparency-locked layer', () => {
    const pixels = canvas(20, 20)
    pixels.set([0, 0, 255, 255], (10 * 20 + 10) * 4)
    applyPaintOp(pixels, 20, 20, stroke([2, 10, 1, 18, 10, 1], { lockAlpha: true }))
    expect(pixel(pixels, 20, 10, 10)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, 20, 5, 10)[3]).toBe(0)
  })

  it('fills the joined area the bucket lands in, or every matching pixel when not contiguous', () => {
    const base = canvas(9, 3, [255, 255, 255, 255])
    for (let y = 0; y < 3; y += 1) base.set([0, 0, 0, 255], (y * 9 + 4) * 4)
    const joined = new Uint8ClampedArray(base)
    applyPaintOp(joined, 9, 3, { id: ID, kind: 'fill', x: 1, y: 1, color: '#00FF00', tolerance: 10, contiguous: true, opacity: 1, lockAlpha: false })
    expect(pixel(joined, 9, 0, 0)).toEqual([0, 255, 0, 255])
    expect(pixel(joined, 9, 4, 1)).toEqual([0, 0, 0, 255])
    expect(pixel(joined, 9, 8, 2)).toEqual([255, 255, 255, 255])
    const everywhere = new Uint8ClampedArray(base)
    applyPaintOp(everywhere, 9, 3, { id: ID, kind: 'fill', x: 1, y: 1, color: '#00FF00', tolerance: 10, contiguous: false, opacity: 1, lockAlpha: false })
    expect(pixel(everywhere, 9, 8, 2)).toEqual([0, 255, 0, 255])
  })

  it('draws linear and radial gradients from the first colour to the second', () => {
    const linear = canvas(11, 1)
    applyPaintOp(linear, 11, 1, { id: ID, kind: 'gradient', shape: 'linear', from: [0, 0], to: [11, 0], colors: ['#000000', '#FFFFFF'], opacity: 1, lockAlpha: false })
    expect(pixel(linear, 11, 0, 0)[0]).toBeLessThan(20)
    expect(pixel(linear, 11, 5, 0)[0]).toBe(128)
    expect(pixel(linear, 11, 10, 0)[0]).toBeGreaterThan(235)
    expect(pixel(linear, 11, 5, 0)[3]).toBe(255)
    const radial = canvas(21, 21)
    applyPaintOp(radial, 21, 21, { id: ID, kind: 'gradient', shape: 'radial', from: [10.5, 10.5], to: [20.5, 10.5], colors: ['#FF0000', '#0000FF'], opacity: 1, lockAlpha: false })
    expect(pixel(radial, 21, 10, 10)).toEqual([255, 0, 0, 255])
    expect(pixel(radial, 21, 0, 10)[2]).toBe(255)
  })

  it('fills the whole layer, or with lockAlpha only what is already there', () => {
    const pixels = canvas(2, 1)
    pixels.set([9, 9, 9, 255], 0)
    applyPaintOps(pixels, 2, 1, [{ id: ID, kind: 'fill-all', color: '#336699', opacity: 1, lockAlpha: true }])
    expect([...pixels]).toEqual([0x33, 0x66, 0x99, 255, 0, 0, 0, 0])
  })

  it('accepts only well-formed operations', () => {
    expect(paintOpSchema.safeParse(stroke([1, 2, 1])).success).toBe(true)
    expect(paintOpSchema.safeParse(stroke([1, 2])).success).toBe(false)
    expect(paintOpSchema.safeParse(stroke([1, 2, 1], { color: 'red' })).success).toBe(false)
  })

  it('keeps a background bake only while the recorded operations still begin with the baked ones', () => {
    const ops = ['a', 'b', 'c'].map((id) => ({ ...stroke([1, 1]), id }))
    expect(startsWithBaked(ops, ['a', 'b', 'c'])).toBe(true)
    // A stroke added while baking stays on top of the baked pixels.
    expect(startsWithBaked([...ops, { ...stroke([1, 1]), id: 'd' }], ['a', 'b', 'c'])).toBe(true)
    // Undone while baking, or undone and painted over: the baked pixels hold a stroke that is gone.
    expect(startsWithBaked(ops.slice(0, 2), ['a', 'b', 'c'])).toBe(false)
    expect(startsWithBaked([...ops.slice(0, 2), { ...stroke([1, 1]), id: 'e' }], ['a', 'b', 'c'])).toBe(false)
    expect(startsWithBaked(undefined, ['a'])).toBe(false)
  })
})
