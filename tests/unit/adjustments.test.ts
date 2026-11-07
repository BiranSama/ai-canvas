import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { applySceneCommand } from '../../src/domain/commands/apply-command'
import { adjustmentSettingsSchema, ELEMENT_SCHEMA_VERSION, sceneSchema, type AdjustmentSettings, type SceneElement } from '../../src/domain'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'
import { groupBoundsForChildTransforms } from '../../src/renderer/src/store/workspace-store'
import { adjustPixels, autoLevels, curveTable, defaultAdjustment, describeAdjustment, histogram, isNeutralAdjustment } from '../../src/shared/adjustments'

/** One pixel through an adjustment. */
function one(settings: AdjustmentSettings, r: number, g: number, b: number, a = 255): number[] {
  const data = new Uint8ClampedArray([r, g, b, a])
  adjustPixels(data, settings)
  return [...data]
}

const levels = (rgb: Partial<{ inputBlack: number; inputWhite: number; gamma: number; outputBlack: number; outputWhite: number }>): AdjustmentSettings => {
  const base = defaultAdjustment('levels')
  if (base.kind !== 'levels') throw new Error('levels')
  return { ...base, channels: { ...base.channels, rgb: { ...base.channels.rgb, ...rgb } } }
}

describe('tone adjustments', () => {
  it('maps levels by Photoshop formula: input range, midtone gamma, output range', () => {
    expect(one(levels({ gamma: 2 }), 128, 0, 255)).toEqual([181, 0, 255, 255])
    expect(one(levels({ inputBlack: 50, inputWhite: 200 }), 50, 125, 200)).toEqual([0, 128, 255, 255])
    expect(one(levels({ outputBlack: 20, outputWhite: 220 }), 0, 255, 128)).toEqual([20, 220, 120, 255])
  })

  it('draws a curve through its points and flat past the ends', () => {
    const table = curveTable([[30, 0], [128, 200], [230, 255]])
    expect(Math.round(table[128]!)).toBe(200)
    expect(table[0]).toBe(0)
    expect(table[255]).toBe(255)
    // Two points are a straight line.
    expect(Math.round(curveTable([[0, 255], [255, 0]])[100]!)).toBe(155)
  })

  it('applies a channel curve before the composite one', () => {
    const base = defaultAdjustment('curves')
    if (base.kind !== 'curves') throw new Error('curves')
    const settings: AdjustmentSettings = { ...base, channels: { ...base.channels, red: [[0, 0], [255, 128]], rgb: [[0, 255], [255, 0]] } }
    // Red 255 → 128 by its own curve → 127 by the inverting composite one.
    expect(one(settings, 255, 255, 0)).toEqual([127, 0, 255, 255])
  })

  it('doubles light in linear space at +1 exposure', () => {
    expect(one({ kind: 'exposure', exposure: 1, offset: 0, gamma: 1 }, 128, 0, 255)).toEqual([176, 0, 255, 255])
    expect(one({ kind: 'exposure', exposure: -20, offset: 0, gamma: 1 }, 200, 200, 200)).toEqual([0, 0, 0, 255])
  })

  it('brightens the midtones and keeps black and white; contrast spreads about middle grey', () => {
    const [brighter] = one({ kind: 'brightness-contrast', brightness: 80, contrast: 0 }, 128, 0, 0)
    expect(brighter).toBeGreaterThan(150)
    expect(one({ kind: 'brightness-contrast', brightness: 150, contrast: 0 }, 0, 255, 0)).toEqual([0, 255, 0, 255])
    const [dark, , light] = one({ kind: 'brightness-contrast', brightness: 0, contrast: 50 }, 80, 0, 180)
    expect(dark).toBeLessThan(80)
    expect(light).toBeGreaterThan(180)
  })

  it('inverts and desaturates', () => {
    expect(one({ kind: 'invert' }, 10, 128, 255)).toEqual([245, 127, 0, 255])
    expect(one({ kind: 'desaturate' }, 200, 100, 50)).toEqual([125, 125, 125, 255])
  })
})

describe('colour adjustments', () => {
  const hueSat = (hue: number, saturation: number, lightness: number): AdjustmentSettings => ({ kind: 'hue-saturation', hue, saturation, lightness, colorize: null })

  it('turns red into green at a hue of +120', () => {
    expect(one(hueSat(120, 0, 0), 255, 0, 0)).toEqual([0, 255, 0, 255])
    expect(one(hueSat(-120, 0, 0), 255, 0, 0)).toEqual([0, 0, 255, 255])
  })

  it('leaves the HSL lightness at −100 saturation, the same as 去色', () => {
    expect(one(hueSat(0, -100, 0), 200, 100, 50)).toEqual(one({ kind: 'desaturate' }, 200, 100, 50))
    const [r, g, b] = one(hueSat(0, 50, 0), 160, 120, 100)
    expect(r! - b!).toBeGreaterThan(60)
    expect(g).toBeGreaterThan(b!)
  })

  it('lightens towards white and darkens towards black', () => {
    expect(one(hueSat(0, 0, 100), 10, 100, 200)).toEqual([255, 255, 255, 255])
    expect(one(hueSat(0, 0, -50), 100, 200, 50)).toEqual([50, 100, 25, 255])
  })

  it('colourizes with one hue and keeps each pixel lightness', () => {
    const settings: AdjustmentSettings = { kind: 'hue-saturation', hue: 0, saturation: 0, lightness: 0, colorize: { hue: 240, saturation: 100, lightness: 0 } }
    expect(one(settings, 128, 128, 128)).toEqual([1, 1, 255, 255])
    expect(one(settings, 255, 255, 255)).toEqual([255, 255, 255, 255])
  })

  it('mixes black and white by Photoshop default weights', () => {
    const bw = defaultAdjustment('black-white')
    expect(one(bw, 255, 0, 0)).toEqual([102, 102, 102, 255])
    expect(one(bw, 255, 255, 0)).toEqual([153, 153, 153, 255])
    expect(one(bw, 0, 0, 255)).toEqual([51, 51, 51, 255])
    expect(one(bw, 128, 128, 128)).toEqual([128, 128, 128, 255])
  })

  it('tints black and white in one colour', () => {
    const tinted: AdjustmentSettings = { ...defaultAdjustment('black-white'), tint: '#FF0000' } as AdjustmentSettings
    const [r, g, b] = one(tinted, 128, 128, 128)
    expect(r).toBeGreaterThan(g!)
    expect(g).toBe(b)
  })

  it('pushes colour balance in its tonal range and keeps the lightness when asked', () => {
    const midRed: AdjustmentSettings = { kind: 'color-balance', shadows: [0, 0, 0], midtones: [100, 0, 0], highlights: [0, 0, 0], preserveLuminosity: false }
    const [r, g, b] = one(midRed, 128, 128, 128)
    expect(r).toBeGreaterThan(200)
    expect([g, b]).toEqual([128, 128])
    // Black is no midtone.
    expect(one(midRed, 0, 0, 0)).toEqual([0, 0, 0, 255])
    const kept = one({ ...midRed, preserveLuminosity: true }, 128, 128, 128)
    expect(Math.round((Math.max(...kept.slice(0, 3)) + Math.min(...kept.slice(0, 3))) / 2)).toBe(128)
  })

  it('gives dull colours more vibrance than strong ones and leaves greys', () => {
    const settings: AdjustmentSettings = { kind: 'vibrance', vibrance: 80, saturation: 0 }
    expect(one(settings, 120, 120, 120)).toEqual([120, 120, 120, 255])
    const dull = one(settings, 140, 120, 110)
    const strong = one(settings, 230, 40, 30)
    expect((dull[0]! - dull[2]!) / 30).toBeGreaterThan((strong[0]! - strong[2]!) / 200)
  })
})

describe('mixing and leaving things alone', () => {
  it('mixes by coverage and amount and never changes alpha', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 200, 0, 0, 0, 255, 0, 0, 0, 255])
    adjustPixels(data, { kind: 'invert' }, { coverage: new Uint8Array([255, 0, 255]), amount: 0.5 })
    expect([...data]).toEqual([128, 128, 128, 200, 0, 0, 0, 255, 128, 128, 128, 255])
  })

  it('takes a curve with its ends moved in along the diagonal as a change: flat past them', () => {
    const base = defaultAdjustment('curves')
    if (base.kind !== 'curves') throw new Error('curves')
    const inward: AdjustmentSettings = { ...base, channels: { ...base.channels, rgb: [[50, 50], [200, 200]] } }
    expect(isNeutralAdjustment(inward)).toBe(false)
    expect(one(inward, 0, 128, 255)).toEqual([50, 128, 200, 255])
    expect(describeAdjustment(inward)).toBe('曲线（RGB 50→50 200→200）')
  })

  it('cuts an adjusted value to the range before mixing it with the original', () => {
    const data = new Uint8ClampedArray([240, 100, 0, 255])
    adjustPixels(data, { kind: 'vibrance', vibrance: 0, saturation: 100 }, { amount: 0.5 })
    expect([...data]).toEqual([248, 91, 0, 255])
  })

  it('knows the neutral settings Photoshop opens with', () => {
    for (const kind of ['brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance'] as const) {
      expect(isNeutralAdjustment(defaultAdjustment(kind))).toBe(true)
    }
    expect(isNeutralAdjustment(defaultAdjustment('black-white'))).toBe(false)
    expect(isNeutralAdjustment({ kind: 'invert' })).toBe(false)
  })

  it('stretches each channel for 自动色调 and all together for 自动对比度', () => {
    const data = new Uint8ClampedArray(4 * 1000)
    for (let index = 0; index < 1000; index += 1) data.set([50 + (index % 151), 60 + (index % 101), 100, 255], index * 4)
    const counts = histogram(data)
    const tone = autoLevels(counts, 'tone').channels
    expect([tone.red.inputBlack, tone.red.inputWhite]).toEqual([50, 200])
    expect([tone.green.inputBlack, tone.green.inputWhite]).toEqual([60, 160])
    const contrast = autoLevels(counts, 'contrast').channels.rgb
    expect([contrast.inputBlack, contrast.inputWhite]).toEqual([50, 200])
  })

  it('gives valid levels for a white picture and a channel at its top', () => {
    const white = histogram(new Uint8ClampedArray(4 * 100).fill(255))
    const saturated = new Uint8ClampedArray(4 * 100)
    for (let index = 0; index < 100; index += 1) saturated.set([254 + (index % 2), 20 + index, 0, 255], index * 4)
    for (const settings of [autoLevels(white, 'tone'), autoLevels(white, 'contrast'), autoLevels(histogram(saturated), 'tone')]) {
      expect(adjustmentSettingsSchema.safeParse(settings).success).toBe(true)
    }
    expect(autoLevels(white, 'contrast').channels.rgb).toMatchObject({ inputBlack: 253, inputWhite: 255 })
  })

  it('describes the settings in words', () => {
    expect(describeAdjustment(levels({ inputBlack: 12, inputWhite: 240, gamma: 1.2 }))).toBe('色阶（RGB 输入 12–240，中间调 1.20，输出 0–255）')
    expect(describeAdjustment({ kind: 'invert' })).toBe('反相')
  })
})

describe('the settings and the adjustment layer', () => {
  it('refuses curves that go backwards and levels with no input range', () => {
    expect(adjustmentSettingsSchema.safeParse({ kind: 'curves', channels: { rgb: [[0, 0], [0, 255]], red: [[0, 0], [255, 255]], green: [[0, 0], [255, 255]], blue: [[0, 0], [255, 255]] } }).success).toBe(false)
    expect(adjustmentSettingsSchema.safeParse(levels({ inputBlack: 200, inputWhite: 201 })).success).toBe(false)
  })

  it('keeps an adjustment layer over the whole canvas and out of its group box', () => {
    const scene = createMerchantExampleScene('coffee-poster')
    const layer = {
      id: '0f0f0f0f-0000-4000-8000-0000000000ad', version: ELEMENT_SCHEMA_VERSION, type: 'adjustment', name: '曲线 1', description: '',
      transform: { x: 0.2, y: 0.2, width: 0.3, height: 0.3, rotation: 10 }, zIndex: 0, opacity: 1, visible: true, locked: false, groupId: null,
      semanticRole: 'adjustment', referencePolicy: 'include', settings: defaultAdjustment('curves'), mask: null
    } as SceneElement
    const added = produce(scene, (draft) => { applySceneCommand(draft, { kind: 'element.add', element: layer }) })
    const adjustment = added.elements.at(-1)!
    expect(adjustment.transform).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
    const moved = produce(added, (draft) => { applySceneCommand(draft, { kind: 'element.update', elementId: layer.id, changes: { transform: { x: 0.5, y: 0.5, width: 0.1, height: 0.1, rotation: 0 } } }) })
    expect(moved.elements.at(-1)!.transform).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
    const title = scene.elements.find((element) => element.name === '标题')!
    const grouped = produce(moved, (draft) => {
      applySceneCommand(draft, {
        kind: 'element.group',
        group: { ...layer, id: '0f0f0f0f-0000-4000-8000-0000000000ae', type: 'group', name: '组', childIds: [title.id, layer.id] } as unknown as Extract<SceneElement, { type: 'group' }>,
        elementIds: [title.id, layer.id]
      })
    })
    expect(sceneSchema.safeParse(grouped).success).toBe(true)
    expect(grouped.elements.find((element) => element.type === 'group')!.transform).toMatchObject({ x: title.transform.x, width: title.transform.width })
  })

  it('leaves an adjustment layer out of its group\'s box when a member moves', () => {
    const scene = createMerchantExampleScene('coffee-poster')
    const title = scene.elements.find((element) => element.name === '标题')!
    const layer = {
      id: '0f0f0f0f-0000-4000-8000-0000000000b1', version: ELEMENT_SCHEMA_VERSION, type: 'adjustment', name: '曲线 1', description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 0, opacity: 1, visible: true, locked: false, groupId: null,
      semanticRole: 'adjustment', referencePolicy: 'include', settings: defaultAdjustment('curves'), mask: null
    } as SceneElement
    const grouped = produce(scene, (draft) => {
      applySceneCommand(draft, { kind: 'element.add', element: layer })
      applySceneCommand(draft, {
        kind: 'element.group', elementIds: [title.id, layer.id],
        group: { ...layer, id: '0f0f0f0f-0000-4000-8000-0000000000b2', type: 'group', name: '组', childIds: [title.id, layer.id] } as unknown as Extract<SceneElement, { type: 'group' }>
      })
    })
    const moved = { ...title.transform, x: title.transform.x + 0.05 }
    expect(groupBoundsForChildTransforms(grouped, '0f0f0f0f-0000-4000-8000-0000000000b2', new Map([[title.id, moved]]))).toMatchObject({ x: moved.x, width: moved.width, y: moved.y, height: moved.height })
  })

  it('takes a blend mode, as an adjustment layer does in Photoshop', () => {
    const scene = createMerchantExampleScene('coffee-poster')
    const element = { id: '0f0f0f0f-0000-4000-8000-0000000000af', version: ELEMENT_SCHEMA_VERSION, type: 'adjustment', name: '反相', description: '', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: scene.elements.length, opacity: 1, blendMode: 'multiply', visible: true, locked: false, groupId: null, semanticRole: 'adjustment', referencePolicy: 'include', settings: { kind: 'invert' } }
    expect(sceneSchema.safeParse({ ...scene, elements: [...scene.elements, element] }).success).toBe(true)
  })
})
