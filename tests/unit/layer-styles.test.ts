import { describe, expect, it } from 'vitest'
import { layerStyleSchema, type LayerStyle } from '../../src/domain'
import { activeLayerStyles, applyLayerStyles, defaultLayerStyle, describeLayerStyle, distanceToSet, layerStyleReach, type StyleBox } from '../../src/shared/layer-styles'

/** A red square of this size in the middle of a transparent raster padded by pad. */
function square(size: number, pad: number): { data: Uint8ClampedArray; box: StyleBox } {
  const width = size + pad * 2
  const data = new Uint8ClampedArray(width * width * 4)
  for (let y = pad; y < pad + size; y += 1) for (let x = pad; x < pad + size; x += 1) data.set([220, 30, 30, 255], (y * width + x) * 4)
  return { data, box: { x: pad, y: pad, width: size, height: size, rasterWidth: width, rasterHeight: width } }
}

const alphaAt = (data: Uint8ClampedArray, width: number, x: number, y: number): number => data[(y * width + x) * 4 + 3]!
const rgbAt = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)]

describe('layer styles', () => {
  it('measures distance to the nearest pixel of a set', () => {
    const set = new Uint8Array(25)
    set[12] = 1
    const distance = distanceToSet(set, 5, 5)
    expect(distance[12]).toBe(0)
    expect(distance[13]).toBe(1)
    expect(distance[0]).toBeCloseTo(Math.SQRT2 * 2, 5)
  })

  it('strokes outside, inside and centred at its size', () => {
    for (const [position, outside, inside] of [['outside', 4, 0], ['inside', 0, 4], ['center', 2, 2]] as const) {
      const { data, box } = square(20, 10)
      const style: LayerStyle = { stroke: { enabled: true, size: 4, position, color: '#0000FF', opacity: 1 } }
      applyLayerStyles(data, box, style, 1)
      const width = box.rasterWidth
      // Along the middle row: the stroke reaches `outside` pixels out of the square and `inside` pixels into it.
      const row = 20
      for (let step = 1; step <= 6; step += 1) {
        const pixel = alphaAt(data, width, 10 - step, row)
        expect(pixel, `${position} ${step} out`).toBe(step <= outside ? 255 : 0)
      }
      const firstInside = rgbAt(data, width, 10, row)
      expect(firstInside, position).toEqual(inside > 0 ? [0, 0, 255] : [220, 30, 30])
      expect(rgbAt(data, width, 10 + Math.max(inside, 1) + 1, row), position).toEqual([220, 30, 30])
    }
  })

  it('casts its drop shadow away from the light, knocked out under the layer, and the stroke widens it', () => {
    const { data, box } = square(20, 20)
    const style: LayerStyle = { dropShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 1, angle: 0, distance: 6, spread: 100, size: 0 } }
    const result = applyLayerStyles(data, box, style, 1)
    expect(result.under).toHaveLength(1)
    const shadow = result.under[0]!.pixels
    const width = box.rasterWidth
    // Light from the right (0°): the shadow falls to the left, not to the right.
    expect(alphaAt(shadow, width, 20 - 3, 30)).toBe(255)
    expect(alphaAt(shadow, width, 40 + 3, 30)).toBe(0)
    // Knocked out where the layer is.
    expect(alphaAt(shadow, width, 30, 30)).toBe(0)
    // Light from the top (90°): it falls below.
    const top = square(20, 20)
    const below = applyLayerStyles(top.data, top.box, { dropShadow: { ...style.dropShadow!, angle: 90 } }, 1).under[0]!.pixels
    expect(alphaAt(below, width, 30, 40 + 3)).toBe(255)
    expect(alphaAt(below, width, 30, 20 - 3)).toBe(0)
    // A turned layer keeps the picture's light: turned 90° clockwise, the screen's left is the layer's own down.
    const turned = square(20, 20)
    const local = applyLayerStyles(turned.data, turned.box, style, 1, 90).under[0]!.pixels
    expect(alphaAt(local, width, 30, 40 + 3)).toBe(255)
    expect(alphaAt(local, width, 20 - 3, 30)).toBe(0)
    // An outside stroke is part of what casts the shadow.
    const stroked = square(20, 20)
    const wide = applyLayerStyles(stroked.data, stroked.box, { ...style, dropShadow: { ...style.dropShadow!, distance: 0 }, stroke: { enabled: true, size: 4, position: 'outside', color: '#FFFFFF', opacity: 1 } }, 1).under[0]!.pixels
    expect(alphaAt(wide, width, 20 - 2, 30)).toBe(0)
    expect(alphaAt(stroked.data, width, 20 - 2, 30)).toBe(255)
  })

  it('blurs a shadow by its size and grows it by its spread, at the scale it is drawn', () => {
    const hard = square(20, 30)
    const soft = square(20, 30)
    const base = { enabled: true, blendMode: 'normal' as const, color: '#000000', opacity: 1, angle: 0, distance: 0 }
    const sharp = applyLayerStyles(hard.data, hard.box, { dropShadow: { ...base, spread: 100, size: 8 } }, 1).under[0]!.pixels
    const blurred = applyLayerStyles(soft.data, soft.box, { dropShadow: { ...base, spread: 0, size: 8 } }, 1).under[0]!.pixels
    const width = hard.box.rasterWidth
    // Spread 100% grows it hard by its size; spread 0 fades it out over about its size.
    expect(alphaAt(sharp, width, 30 - 7, 40)).toBe(255)
    expect(alphaAt(blurred, width, 30 - 1, 40)).toBeGreaterThan(90)
    expect(alphaAt(blurred, width, 30 - 1, 40)).toBeLessThan(170)
    expect(alphaAt(blurred, width, 30 - 12, 40)).toBeLessThan(15)
    // At half the pixels a style is half as wide.
    const small = square(10, 15)
    const half = applyLayerStyles(small.data, small.box, { dropShadow: { ...base, spread: 100, size: 8 } }, 0.5).under[0]!.pixels
    expect(alphaAt(half, small.box.rasterWidth, 15 - 3, 20)).toBe(255)
    expect(alphaAt(half, small.box.rasterWidth, 15 - 6, 20)).toBe(0)
  })

  it('lays colour and gradient overlays over the layer only, in their mode', () => {
    const { data, box } = square(20, 4)
    applyLayerStyles(data, box, { colorOverlay: { enabled: true, blendMode: 'normal', color: '#00FF00', opacity: 0.5 } }, 1)
    const width = box.rasterWidth
    expect(rgbAt(data, width, 10, 10)).toEqual([110, 143, 15])
    expect(alphaAt(data, width, 1, 1)).toBe(0)
    const ramp = square(20, 0)
    applyLayerStyles(ramp.data, ramp.box, { gradientOverlay: { ...defaultLayerStyle('gradientOverlay'), angle: 0 } }, 1)
    // Black at the left, white at the right, at 0°.
    expect(rgbAt(ramp.data, 20, 0, 10)[0]).toBeLessThan(15)
    expect(rgbAt(ramp.data, 20, 19, 10)[0]).toBeGreaterThan(240)
    expect(rgbAt(ramp.data, 20, 10, 10)[0]).toBeGreaterThan(110)
    expect(rgbAt(ramp.data, 20, 10, 10)[0]).toBeLessThan(150)
  })

  it('shades the inside edge facing the light with the inner shadow', () => {
    const { data, box } = square(30, 4)
    applyLayerStyles(data, box, { innerShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 1, angle: 90, distance: 4, choke: 100, size: 2 } }, 1)
    const width = box.rasterWidth
    // Light from the top: the top inside edge is in shade, the bottom one is not.
    expect(rgbAt(data, width, 19, 5)[0]).toBe(0)
    expect(rgbAt(data, width, 19, 32)).toEqual([220, 30, 30])
  })

  it('checks its settings and reports what is on and how far it reaches', () => {
    const style: LayerStyle = { dropShadow: defaultLayerStyle('dropShadow'), stroke: { ...defaultLayerStyle('stroke', '#FFFFFF'), enabled: false } }
    expect(layerStyleSchema.safeParse(style).success).toBe(true)
    expect(layerStyleSchema.safeParse({ dropShadow: { ...style.dropShadow, size: 500 } }).success).toBe(false)
    expect(activeLayerStyles(style)).toEqual(['dropShadow'])
    expect(describeLayerStyle(style)).toBe('投影（距离 5、大小 5）')
    expect(layerStyleReach(style)).toBeGreaterThanOrEqual(13)
    expect(layerStyleReach({ stroke: defaultLayerStyle('stroke') })).toBe(5)
  })
})
