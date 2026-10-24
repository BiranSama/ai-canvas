import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createScene, ELEMENT_SCHEMA_VERSION, type SceneElement } from '../../src/domain'
import { extractLayer, inContextLayerJob, layerRegion, layersBelow, regionMask, regionTransform } from '../../src/main/edit/layer-in-context'
import { subScene } from '../../src/main/reference/sub-scene'

const NOW = '2026-10-23T00:00:00.000Z'

function placeholder(id: string, transform: SceneElement['transform'], zIndex: number): SceneElement {
  return {
    id, version: ELEMENT_SCHEMA_VERSION, type: 'placeholder', name: '主体', description: '', transform, zIndex, opacity: 1, visible: true,
    locked: false, groupId: null, semanticRole: 'subject', referencePolicy: 'include', subject: '香水瓶', pose: '', facing: '',
    allowOverflow: false, transparentBackground: true, frameShape: 'rectangle', generationNotes: ''
  }
}

function scene(elements: SceneElement[]) {
  const base = createScene({ id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', now: NOW })
  return { ...base, canvas: { ...base.canvas, outputWidth: 400, outputHeight: 300 }, elements }
}

async function solid(width: number, height: number, rgb: readonly [number, number, number], square?: { left: number; top: number; size: number; rgb: readonly [number, number, number] }): Promise<Buffer> {
  const composites = square === undefined ? [] : [{
    input: await sharp({ create: { width: square.size, height: square.size, channels: 3, background: { r: square.rgb[0], g: square.rgb[1], b: square.rgb[2] } } }).png().toBuffer(),
    left: square.left, top: square.top
  }]
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).composite(composites).png().toBuffer()
}

describe('redrawing one element in context', () => {
  it('measures the element box and a band around it, cut off at the canvas edge', () => {
    const middle = layerRegion(scene([]), placeholder('00000000-0000-4000-8000-000000000010', { x: 0.25, y: 0.2, width: 0.5, height: 0.5, rotation: 0 }, 0))
    // 12% of the shorter side (150 px) is an 18 px band.
    expect(middle).toEqual({ canvasWidth: 400, canvasHeight: 300, core: { left: 100, top: 60, width: 200, height: 150 }, expanded: { left: 82, top: 42, width: 236, height: 186 } })
    expect(regionTransform(middle!)).toMatchObject({ x: 82 / 400, y: 42 / 300, width: 236 / 400, height: 186 / 300, rotation: 0 })
    const corner = layerRegion(scene([]), placeholder('00000000-0000-4000-8000-000000000010', { x: 0, y: 0, width: 0.3, height: 0.3, rotation: 0 }, 0))
    expect(corner?.expanded).toMatchObject({ left: 0, top: 0 })
    expect(layerRegion(scene([]), placeholder('00000000-0000-4000-8000-000000000010', { x: 1.2, y: 0, width: 0.3, height: 0.3, rotation: 0 }, 0))).toBeNull()
  })

  it('paints only the band and box, and keeps just the layers beneath', async () => {
    const back = placeholder('00000000-0000-4000-8000-000000000011', { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, 0)
    const target = placeholder('00000000-0000-4000-8000-000000000012', { x: 0.25, y: 0.2, width: 0.5, height: 0.5, rotation: 0 }, 1)
    const front = placeholder('00000000-0000-4000-8000-000000000013', { x: 0.1, y: 0.1, width: 0.2, height: 0.2, rotation: 0 }, 2)
    const all = scene([back, target, front])
    expect([...layersBelow(all, target)]).toEqual([back.id])
    expect(subScene(all, layersBelow(all, target)).elements.map((element) => [element.id, element.zIndex])).toEqual([[back.id, 0]])
    const region = layerRegion(all, target)!
    const { data, info } = await sharp(await regionMask(region)).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels]
    expect([at(81, 100), at(82, 100), at(317, 100), at(318, 100), at(150, 41), at(150, 42)]).toEqual([0, 255, 255, 0, 0, 255])
  })

  it('matches the cut-out to the picture around it and fades it across the band', async () => {
    const region = layerRegion(scene([]), placeholder('00000000-0000-4000-8000-000000000010', { x: 0.25, y: 0.2, width: 0.5, height: 0.5, rotation: 0 }, 0))!
    const source = await solid(400, 300, [100, 120, 140])
    // The model brightened everything by 30 and painted a red square in the box; it also answered at another size.
    const result = await solid(800, 600, [130, 150, 170], { left: 300, top: 220, size: 200, rgb: [230, 30, 30] })
    const layer = await extractLayer(result, source, region)
    const { data, info } = await sharp(layer).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels]).toEqual([236, 186, 4])
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]
    // In the band the drift is undone: the background reads as it was.
    const band = pixel(10, 93)
    expect(Math.abs(band[0]! - 100)).toBeLessThanOrEqual(2)
    expect(Math.abs(band[2]! - 140)).toBeLessThanOrEqual(2)
    // Transparent at the outer edge, half way in the middle of the band, opaque over the box.
    expect(pixel(0, 93)[3]).toBeLessThan(10)
    expect(pixel(9, 93)[3]).toBeGreaterThan(90)
    expect(pixel(9, 93)[3]).toBeLessThan(170)
    expect(pixel(118, 93)[3]).toBe(255)
    // The red square survives the correction, still clearly red.
    const red = pixel(118, 93)
    expect(red[0]! - red[1]!).toBeGreaterThan(150)
  })

  it('reads back only what an in-context job recorded', () => {
    const region = { canvasWidth: 400, canvasHeight: 300, core: { left: 1, top: 1, width: 10, height: 10 }, expanded: { left: 0, top: 0, width: 12, height: 12 } }
    expect(inContextLayerJob({ mode: 'layer-in-context', targetElementId: 'e', sourceAssetId: 's', layerRegion: region })).toEqual({ targetElementId: 'e', sourceAssetId: 's', region })
    expect(inContextLayerJob({ mode: 'local-edit', targetElementId: 'e' })).toBeNull()
  })
})
