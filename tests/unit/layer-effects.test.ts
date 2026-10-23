import { describe, expect, it } from 'vitest'
import { applyImageEffects, hasVisibleEffects, shadowGeometry, shadowSilhouette, softShadow, softShadowStrength } from '../../src/shared/layer-effects'

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) data.set(rgba, index)
  return data
}

describe('image layer effects', () => {
  it('shifts colour per channel and fades only the outer band', () => {
    const data = solid(100, 50, [100, 100, 100, 255])
    applyImageEffects(data, 100, 50, { colorMatch: { gain: [1.1, 1, 0.9], offset: [5, -10, 0] }, feather: 0.2, shadow: null })
    const at = (x: number, y: number) => [...data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)]
    expect(at(50, 25)).toEqual([115, 90, 90, 255])
    // The band is 20% of the 50 px side: 10 px, smooth from the edge inwards.
    expect(at(0, 25)[3]).toBeLessThan(10)
    // 5.5 px into a 10 px band: smoothstep(0.55) of full alpha.
    expect(at(5, 25)[3]).toBe(147)
    expect(at(10, 25)[3]).toBe(255)
    expect(at(50, 0)[3]).toBeLessThan(10)
  })

  it('casts a shadow from the opaque parts, scaled to the image', () => {
    const data = solid(4, 1, [200, 10, 10, 255])
    data[3] = 0
    const shadow = softShadow(1)
    expect([...shadowSilhouette(data, 4, 1, shadow).subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 140])
    expect(shadowGeometry(shadow, 400, 200)).toEqual({ sigma: 8, offsetX: 0, offsetY: 5, padding: 24 })
    expect(softShadowStrength(softShadow(0.5))).toBeCloseTo(0.5, 2)
    expect(softShadowStrength(null)).toBe(0)
  })

  it('treats empty effects as none', () => {
    expect(hasVisibleEffects(undefined)).toBe(false)
    expect(hasVisibleEffects({ colorMatch: null, feather: 0, shadow: null })).toBe(false)
    expect(hasVisibleEffects({ colorMatch: null, feather: 0, shadow: { ...softShadow(1), opacity: 0 } })).toBe(false)
    expect(hasVisibleEffects({ colorMatch: null, feather: 0.01, shadow: null })).toBe(true)
  })
})
