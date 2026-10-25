import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { createScene, ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../src/domain'
import { measureToneMatch } from '../../src/main/edit/tone-match'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import { softShadow } from '../../src/shared/layer-effects'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const BASE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, blendMode: 'normal' as const, visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include' as const
}
const ASSET = '40000000-0000-4000-8000-000000000100'

function scene(effects: Extract<SceneElement, { type: 'image' }>['effects']): Scene {
  const base = createScene({ id: '40000000-0000-4000-8000-000000000001', projectId: '40000000-0000-4000-8000-000000000002', now: '2026-10-23T00:00:00.000Z' })
  return {
    ...base,
    canvas: { ...base.canvas, outputWidth: 400, outputHeight: 300, transparent: false, backgroundColor: '#FFFFFF' },
    elements: [
      { ...BASE, id: '40000000-0000-4000-8000-000000000010', type: 'shape', name: '背景', zIndex: 0, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        shape: 'rectangle', fill: '#2040A0', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final' },
      { ...BASE, id: '40000000-0000-4000-8000-000000000011', type: 'image', name: '主体', zIndex: 1, transform: { x: 0.25, y: 0.2, width: 0.5, height: 0.5, rotation: 0 },
        assetId: ASSET, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', ...(effects === undefined ? {} : { effects }) }
    ]
  }
}

async function pixels(buffer: Buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
}

it('draws feather and shadow into the composite and measures the tone around an image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-effects-'))
  roots.push(root)
  const path = join(root, 'orange.png')
  await sharp({ create: { width: 200, height: 150, channels: 4, background: { r: 240, g: 140, b: 40, alpha: 1 } } }).png().toFile(path)
  const resolve = async (assetId: string) => assetId === ASSET ? path : null
  const renderer = new CompositeReferenceRenderer(resolve)

  // The image covers [100, 60] to [300, 210]; its shorter side is 150 px.
  const plain = await pixels((await renderer.render(scene(undefined), 'final')).buffer)
  expect(plain(101, 135)).toEqual([240, 140, 40])
  const feathered = await pixels((await renderer.render(scene({ colorMatch: null, feather: 0.1, shadow: null }), 'final')).buffer)
  expect(feathered(200, 135)).toEqual([240, 140, 40])
  // 1.5 px into a 15 px fade: mostly the blue beneath.
  const edge = feathered(101, 135)
  expect(edge[2]!).toBeGreaterThan(130)
  expect(edge[0]!).toBeLessThan(80)
  // Just below the image the shadow darkens the background; far from it nothing changes.
  const shadowed = await pixels((await renderer.render(scene({ colorMatch: null, feather: 0, shadow: softShadow(1) }), 'final')).buffer)
  expect(plain(200, 214)).toEqual([0x20, 0x40, 0xA0])
  expect(shadowed(200, 214)[2]!).toBeLessThan(135)
  expect(shadowed(20, 20)).toEqual([0x20, 0x40, 0xA0])

  // The tone match moves the orange towards the blue around it, part of the way.
  const measured = await measureToneMatch(scene(undefined), scene(undefined).elements[1] as Extract<SceneElement, { type: 'image' }>, resolve, 0.4)
  expect(measured?.opaque).toBe(true)
  const [red, , blue] = measured!.colorMatch.offset
  expect(red).toBeLessThan(-40)
  expect(blue).toBeGreaterThan(30)
  const colored = await pixels((await renderer.render(scene({ colorMatch: measured!.colorMatch, feather: 0, shadow: null }), 'final')).buffer)
  expect(colored(200, 135)[0]).toBeLessThan(200)
  expect(colored(200, 135)[2]).toBeGreaterThan(70)
})
