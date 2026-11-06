import { readPsd, writePsdUint8Array, type Layer } from 'ag-psd'
import { describe, expect, it } from 'vitest'
import { ADJUSTMENT_KINDS, MAX_LAYER_ADJUSTMENTS, type AdjustmentSettings } from '../../src/domain'
import { buildPsd } from '../../src/main/export/psd-writer'
import { fromPsdAdjustment, toPsdAdjustment } from '../../src/main/psd/psd-adjustments'
import { readPsdForImport } from '../../src/main/psd/psd-import'
import { defaultAdjustment } from '../../src/shared/adjustments'
import { exportPsdWriteSchema, type PsdDocument } from '../../src/shared/artwork-export'

/*
 * Adjustments go out to Photoshop as its own adjustment layers and come
 * back as they went: written to a real PSD and read again with ag-psd.
 */

/** Each kind with settings away from where it opens, so nothing passes by being a default. */
const SAMPLES: readonly AdjustmentSettings[] = ADJUSTMENT_KINDS.map((kind): AdjustmentSettings => {
  switch (kind) {
    case 'brightness-contrast': return { kind, brightness: 35, contrast: -20 }
    case 'levels': return { kind, channels: {
      rgb: { inputBlack: 12, inputWhite: 240, gamma: 1.35, outputBlack: 4, outputWhite: 250 },
      red: { inputBlack: 0, inputWhite: 230, gamma: 0.9, outputBlack: 0, outputWhite: 255 },
      green: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
      blue: { inputBlack: 20, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }
    } }
    case 'curves': return { kind, channels: { rgb: [[0, 0], [64, 50], [190, 210], [255, 255]], red: [[0, 10], [255, 245]], green: [[0, 0], [255, 255]], blue: [[0, 0], [128, 140], [255, 255]] } }
    case 'exposure': return { kind, exposure: 0.75, offset: -0.0125, gamma: 1.1 }
    case 'vibrance': return { kind, vibrance: 40, saturation: -10 }
    case 'hue-saturation': return { kind, hue: -30, saturation: 25, lightness: 5, colorize: { hue: 200, saturation: 40, lightness: -10 } }
    case 'color-balance': return { kind, shadows: [10, -5, 0], midtones: [0, 20, -15], highlights: [-30, 0, 5], preserveLuminosity: false }
    case 'black-white': return { kind, reds: 55, yellows: 70, greens: 30, cyans: 60, blues: 10, magentas: 90, tint: '#C8A070' }
    case 'invert': return { kind }
    case 'desaturate': return { kind }
  }
})

function roundTrip(settings: AdjustmentSettings): AdjustmentSettings | null {
  const bytes = writePsdUint8Array({ width: 8, height: 8, children: [{ name: '调整', adjustment: toPsdAdjustment(settings) }] }, { noBackground: true })
  const adjustment = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true }).children?.[0]?.adjustment
  return adjustment === undefined ? null : fromPsdAdjustment(adjustment)?.settings ?? null
}

describe('adjustments in a PSD', () => {
  it('come back from Photoshop adjustment layers as they went, 去色 as saturation −100', () => {
    for (const settings of SAMPLES) {
      const back = roundTrip(settings)
      if (settings.kind === 'desaturate') expect(back).toEqual({ kind: 'hue-saturation', hue: 0, saturation: -100, lightness: 0, colorize: null })
      else if (settings.kind === 'exposure' && back?.kind === 'exposure') {
        // Photoshop keeps exposure as 32-bit floats.
        expect(back.exposure).toBeCloseTo(settings.exposure, 5)
        expect(back.offset).toBeCloseTo(settings.offset, 5)
        expect(back.gamma).toBeCloseTo(settings.gamma, 5)
      } else expect(back, settings.kind).toEqual(settings)
    }
  })

  it('writes adjustment layers with their masks, and clipped ones over their layer', async () => {
    const width = 16
    const height = 8
    const pixels = new Uint8Array(width * height * 4).fill(200)
    const mask = new Uint8Array(width * height)
    for (let index = 0; index < mask.length; index += 1) mask[index] = index % width < width / 2 ? 255 : 0
    const document: PsdDocument = {
      width, height, composite: new Uint8Array(width * height * 4),
      children: [
        { kind: 'layer', name: '照片', hidden: false, opacity: 1, blendMode: 'normal', left: 0, top: 0, width, height, pixels, mask: null, text: null },
        { kind: 'adjustment', name: '曲线', hidden: false, opacity: 1, clipping: true, settings: SAMPLES[2]!, mask: null },
        { kind: 'adjustment', name: '黑白 1', hidden: true, opacity: 0.6, clipping: false, settings: defaultAdjustment('black-white'), mask: { left: 0, top: 0, width, height, pixels: mask, disabled: false } }
      ]
    }
    // What the page sends passes Main's check.
    expect(exportPsdWriteSchema.safeParse({ target: '00000000-0000-4000-8000-000000000000', document }).success).toBe(true)
    const psd = readPsd(await buildPsd(document, async () => ({ postScriptName: 'Arial', fauxBold: false })), { useImageData: true })
    const [photo, curves, blackWhite] = psd.children as Layer[]
    expect(photo?.adjustment).toBeUndefined()
    expect(curves).toMatchObject({ name: '曲线', clipping: true, adjustment: { type: 'curves' } })
    expect(blackWhite).toMatchObject({ name: '黑白 1', hidden: true, clipping: false, adjustment: { type: 'black & white' } })
    expect(blackWhite!.opacity).toBeCloseTo(0.6, 2)
    expect(blackWhite!.mask?.imageData?.data[0]).toBe(255)
    expect(blackWhite!.mask?.imageData?.data[(width - 1) * 4]).toBe(0)
  })

  it('opens adjustment layers as ours, a plain clipped one as its layer\'s own, and says what it could not bring', async () => {
    const width = 16
    const height = 8
    const imageData = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(180) }
    const maskData = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(0) }
    const bytes = writePsdUint8Array({
      width, height,
      children: [
        { name: '照片', left: 0, top: 0, right: width, bottom: height, imageData },
        { name: '照片的曲线', clipping: true, adjustment: toPsdAdjustment(SAMPLES[2]!) },
        { name: '半透明的剪贴', clipping: true, opacity: 0.5, adjustment: toPsdAdjustment({ kind: 'invert' }) },
        { name: '整体色阶', adjustment: toPsdAdjustment(SAMPLES[1]!), mask: { left: 0, top: 0, right: width, bottom: height, defaultColor: 255, imageData: maskData } },
        { name: '照片滤镜', adjustment: { type: 'photo filter', density: 0.25 } }
      ]
    }, { noBackground: true })
    const document = await readPsdForImport(bytes)
    expect(document.layers.map((layer) => [layer.kind, layer.name])).toEqual([['pixels', '照片'], ['adjustment', '半透明的剪贴'], ['adjustment', '整体色阶']])
    const photo = document.layers[0]!
    expect(photo.kind === 'pixels' && photo.adjustments).toEqual([{ settings: SAMPLES[2], enabled: true }])
    const levels = document.layers[2]!
    expect(levels.kind === 'adjustment' && levels.settings).toEqual(SAMPLES[1])
    expect(levels.kind === 'adjustment' && levels.mask).toMatchObject({ enabled: true })
    expect(document.layers[1]!.opacity).toBeCloseTo(0.5, 2)
    expect(document.approximations.join('；')).toContain('1 个调整图层或填充图层没有带过来')
    expect(document.approximations.join('；')).toContain('1 个剪贴蒙版按普通图层导入')
  })

  it('brings clipped adjustments past what a layer holds as adjustment layers, so the PSD still opens', async () => {
    const imageData = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(180) }
    const clipped = Array.from({ length: MAX_LAYER_ADJUSTMENTS + 1 }, (_, index) => ({ name: `反相 ${index + 1}`, clipping: true, adjustment: toPsdAdjustment({ kind: 'invert' }) }))
    const bytes = writePsdUint8Array({ width: 4, height: 4, children: [{ name: '照片', left: 0, top: 0, right: 4, bottom: 4, imageData }, ...clipped] }, { noBackground: true })
    const document = await readPsdForImport(bytes)
    const photo = document.layers[0]!
    expect(photo.kind === 'pixels' && photo.adjustments).toHaveLength(MAX_LAYER_ADJUSTMENTS)
    expect(document.layers.slice(1).map((layer) => [layer.kind, layer.name])).toEqual([['adjustment', `反相 ${MAX_LAYER_ADJUSTMENTS + 1}`]])
  })

  it('clips to the nearest unclipped layer below, even one it cannot bring', async () => {
    const imageData = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(180) }
    const bytes = writePsdUint8Array({
      width: 4, height: 4,
      children: [
        { name: '照片', left: 0, top: 0, right: 4, bottom: 4, imageData },
        { name: '照片滤镜', adjustment: { type: 'photo filter', density: 0.25 } },
        { name: '剪贴在滤镜上', clipping: true, adjustment: toPsdAdjustment({ kind: 'invert' }) }
      ]
    }, { noBackground: true })
    const document = await readPsdForImport(bytes)
    const photo = document.layers[0]!
    expect(photo.kind === 'pixels' && photo.adjustments).toEqual([])
    expect(document.layers.map((layer) => layer.name)).toEqual(['照片', '剪贴在滤镜上'])
  })
})
