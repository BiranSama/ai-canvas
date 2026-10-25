import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { PsdImportError, readPsdForImport } from '../../src/main/psd/psd-import'
import { samplePsd } from '../helpers/psd-fixture'

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

describe('reading a PSD for import', () => {
  it('keeps each pixel layer bottom first with its place, opacity, visibility, blend mode and group', async () => {
    const document = await readPsdForImport(samplePsd())
    expect(document).toMatchObject({ width: 200, height: 100, opaqueBackground: true, groups: [{ name: '标题组', visible: true }] })
    expect(document.layers.map((layer) => layer.name)).toEqual(['背景', '阴影', '草稿', '柔光', '减淡'])
    expect(document.layers[0]).toMatchObject({ left: 0, top: 0, width: 200, height: 100, opacity: 1, visible: true, blendMode: 'normal', groupIndex: null })
    expect(document.layers[1]).toMatchObject({ left: 10, top: 10, width: 20, height: 10, blendMode: 'multiply', groupIndex: 0 })
    expect(document.layers[1]!.opacity).toBeCloseTo(0.5, 2)
    expect(document.layers[2]).toMatchObject({ visible: false, groupIndex: 0 })
    expect(document.layers[3]).toMatchObject({ blendMode: 'soft-light', groupIndex: null })
    expect(document.layers[3]!.opacity).toBeCloseTo(0.8, 2)
    expect(document.layers[4]).toMatchObject({ blendMode: 'normal' })

    const shadow = await pixels(document.layers[1]!.png)
    expect([shadow.width, shadow.height]).toEqual([20, 10])
    expect([...shadow.data.subarray(0, 4)]).toEqual([0, 0, 255, 255])
  })

  it('keeps the layer mask as a mask over the layer, and says what it simplified, bringing the flattened image along', async () => {
    const document = await readPsdForImport(samplePsd())
    const layer = document.layers[3]!
    // The pixels stay whole; the mask, in the layer's own pixels, hides the part it hid in Photoshop.
    const unmasked = await pixels(layer.png)
    expect(unmasked.data[(5 * 40 + 30) * 4 + 3]).toBe(255)
    expect(layer.mask).toMatchObject({ enabled: true })
    const mask = await sharp(layer.mask!.png).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
    expect([mask.info.width, mask.info.height]).toEqual([unmasked.width, unmasked.height])
    expect(mask.data[0]).toBe(255)
    expect(mask.data[5 * 40 + 30]).toBe(0)
    expect(document.layers.filter((candidate) => candidate.mask !== null)).toHaveLength(1)
    expect(document.approximations).toEqual(['1 个图层的混合模式暂不支持，按正常处理'])
    expect(document.keptAsPictures).toEqual([])
    expect(document.composite).not.toBeNull()
    const composite = await pixels(document.composite!)
    expect([composite.width, composite.height]).toEqual([200, 100])
  })

  it('refuses what is over its limits before decoding it, and what is not a PSD', async () => {
    const limits = { maxEdge: 30_000, maxLayers: 2_000, maxDecodedBytes: 2 ** 31 }
    await expect(readPsdForImport(samplePsd(), { ...limits, maxEdge: 150 })).rejects.toThrow('超出支持的范围')
    await expect(readPsdForImport(samplePsd(), { ...limits, maxLayers: 3 })).rejects.toThrow('图层超过 3 个')
    await expect(readPsdForImport(samplePsd(), { ...limits, maxDecodedBytes: 1000 })).rejects.toBeInstanceOf(PsdImportError)
    await expect(readPsdForImport(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('这个 PSD 读不出来')
  })
})
