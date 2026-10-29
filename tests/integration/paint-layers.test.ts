import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { CommandBus, createScene, ELEMENT_SCHEMA_VERSION, type PaintOp, type Scene, type SceneElement } from '../../src/domain'
import { blankLayerBytes, drawLayers } from '../../src/main/paint/draw-layers'
import { buildLayerMask } from '../../src/main/paint/layer-mask-build'
import { paintedImageBytes } from '../../src/main/paint/painted-image'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import { applyMaskAlpha, applyPaintOps, maskCoverage } from '../../src/shared/paint-ops'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const BASE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, blendMode: 'normal' as const, visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include' as const
}
const ASSET = '50000000-0000-4000-8000-000000000100'
const LAYER = '50000000-0000-4000-8000-000000000011'
const ID = (n: number): string => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const OPS: PaintOp[] = [
  { id: ID(201), kind: 'fill', x: 3, y: 3, color: '#20A040', tolerance: 10, contiguous: true, opacity: 1, lockAlpha: false },
  { id: ID(202), kind: 'stroke', tool: 'brush', color: '#C03020', size: 9, hardness: 0.4, opacity: 0.8, flow: 0.6, pressure: true, lockAlpha: false, points: [4, 60, 0.3, 40, 20, 1, 90, 70, 0.6] },
  { id: ID(203), kind: 'stroke', tool: 'eraser', color: '#FFFFFF', size: 14, hardness: 1, opacity: 1, flow: 1, pressure: false, lockAlpha: false, points: [80, 10, 1, 80, 40, 1] },
  { id: ID(204), kind: 'gradient', shape: 'radial', from: [64, 64], to: [100, 64], colors: ['#FFFF00', '#0000FF'], opacity: 0.5, lockAlpha: true }
]

function scene(elements: SceneElement[]): Scene {
  const base = createScene({ id: ID(1), projectId: ID(2), now: '2026-10-24T00:00:00.000Z' })
  return { ...base, canvas: { ...base.canvas, outputWidth: 128, outputHeight: 128, transparent: false, backgroundColor: '#FFFFFF' }, elements }
}

function paintedLayer(paint: PaintOp[]): Extract<SceneElement, { type: 'image' }> {
  return {
    ...BASE, id: LAYER, type: 'image', name: '图层 1', zIndex: 0, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    assetId: ASSET, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', paint
  }
}

async function rgba(buffer: Buffer): Promise<Buffer> {
  return (await sharp(buffer).ensureAlpha().raw().toBuffer())
}

/** Straight RGBA as it shows over the white artboard. */
function overWhite(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length)
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) out[index + channel] = Math.round(pixels[index + channel]! * alpha + 255 * (1 - alpha))
    out[index + 3] = 255
  }
  return out
}

function largestDifference(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let largest = 0
  for (let index = 0; index < left.length; index += 1) largest = Math.max(largest, Math.abs(left[index]! - right[index]!))
  return largest
}

it('draws a layer\'s recorded paint into the composite exactly as the shared replay does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paint-layers-'))
  roots.push(root)
  // A transparent layer with a dark square, the size of the canvas.
  const source = new Uint8ClampedArray(128 * 128 * 4)
  for (let y = 30; y < 50; y += 1) for (let x = 30; x < 50; x += 1) source.set([10, 10, 10, 255], (y * 128 + x) * 4)
  const path = join(root, 'layer.png')
  await sharp(Buffer.from(source), { raw: { width: 128, height: 128, channels: 4 } }).png().toFile(path)

  const expected = new Uint8ClampedArray(source)
  applyPaintOps(expected, 128, 128, OPS)
  expect(largestDifference(await rgba(await paintedImageBytes(path, OPS)), expected)).toBe(0)

  // Over the white artboard in the reference render.
  const rendered = await rgba((await new CompositeReferenceRenderer(async (assetId) => assetId === ASSET ? path : null).render(scene([paintedLayer(OPS)]), 'final')).buffer)
  const overWhite = new Uint8ClampedArray(expected.length)
  for (let index = 0; index < expected.length; index += 4) {
    const alpha = expected[index + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) overWhite[index + channel] = Math.round(expected[index + channel]! * alpha + 255 * (1 - alpha))
    overWhite[index + 3] = 255
  }
  expect(largestDifference(rendered, overWhite)).toBeLessThanOrEqual(2)
})

it('draws layers alone for a merge, cut to what they cover, and rasterizes in place keeping identity', async () => {
  const shape = (id: string, x: number, fill: string, opacity: number, zIndex: number): SceneElement => ({
    ...BASE, id, type: 'shape', name: `块 ${zIndex}`, zIndex, opacity, transform: { x, y: 0.25, width: 0.25, height: 0.25, rotation: 0 },
    shape: 'rectangle', fill, stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
  })
  const lower = shape(ID(21), 0.25, '#FF0000', 0.5, 0)
  const upper = shape(ID(22), 0.375, '#0000FF', 1, 1)
  const picture = scene([lower, upper, shape(ID(23), 0, '#00FF00', 1, 2)])

  // The base layer is drawn at full strength; the result keeps its own opacity.
  const drawn = await drawLayers(picture, [lower.id, upper.id], lower.id, async () => null)
  expect(drawn.transform).toEqual({ x: 0.25, y: 0.25, width: 0.375, height: 0.25, rotation: 0 })
  const { data, info } = await sharp(drawn.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([48, 32])
  expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
  expect([...data.subarray((10 * 48 + 30) * 4, (10 * 48 + 30) * 4 + 4)]).toEqual([0, 0, 255, 255])

  const executed = new CommandBus(picture, { now: () => '2026-10-24T00:00:01.000Z' }).execute({
    id: ID(300), origin: 'user', summary: '向下合并', commands: [
      { kind: 'element.rasterize', elementId: lower.id, assetId: ASSET, transform: drawn.transform },
      { kind: 'element.remove', elementId: upper.id }
    ]
  })
  if (!executed.ok) throw new Error(JSON.stringify(executed.error))
  expect(executed.scene.elements.map((element) => element.id)).toEqual([lower.id, ID(23)])
  expect(executed.scene.elements[0]).toMatchObject({ id: lower.id, type: 'image', name: '块 0', opacity: 0.5, assetId: ASSET, fit: 'fill', transform: drawn.transform })

  const blank = await sharp(await blankLayerBytes(300, 200)).raw().toBuffer({ resolveWithObject: true })
  expect([blank.info.width, blank.info.height, blank.info.channels]).toEqual([300, 200, 4])
  expect(blank.data.every((value) => value === 0)).toBe(true)
})

const CLIP = '50000000-0000-4000-8000-000000000120'
const MASK = '50000000-0000-4000-8000-000000000130'
const MASK_CLIP = '50000000-0000-4000-8000-000000000131'

it('replays paint limited to a selection and shows an image layer through its mask, as the shared math does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paint-masks-'))
  roots.push(root)
  const files = new Map<string, string>()
  const save = async (id: string, data: Uint8Array | Uint8ClampedArray, channels: 1 | 4): Promise<void> => {
    const path = join(root, `${id}.png`)
    await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: 128, height: 128, channels } }).png().toFile(path)
    files.set(id, path)
  }
  await save(ASSET, new Uint8ClampedArray(128 * 128 * 4), 4)
  // The selection: the left half, softening over its last eight pixels.
  const clip = new Uint8Array(128 * 128)
  for (let y = 0; y < 128; y += 1) for (let x = 0; x < 128; x += 1) clip[y * 128 + x] = x < 56 ? 255 : x < 64 ? Math.round((64 - x) / 8 * 255) : 0
  await save(CLIP, clip, 1)
  // The mask: everything shows but a band across the middle, which a painted stroke half restores.
  const mask = new Uint8Array(128 * 128).fill(255)
  for (let y = 54; y < 74; y += 1) mask.fill(0, y * 128, y * 128 + 128)
  await save(MASK, mask, 1)
  const maskClip = new Uint8Array(128 * 128)
  for (let y = 0; y < 128; y += 1) maskClip.fill(255, y * 128 + 64, y * 128 + 128)
  await save(MASK_CLIP, maskClip, 1)
  const resolve = async (id: string): Promise<string | null> => files.get(id) ?? null

  const ops: PaintOp[] = [
    { id: ID(301), clip: CLIP, kind: 'fill-all', color: '#2040C0', opacity: 1, lockAlpha: false },
    { id: ID(302), clip: CLIP, kind: 'stroke', tool: 'brush', color: '#E0A020', size: 30, hardness: 0.5, opacity: 1, flow: 1, pressure: false, lockAlpha: false, points: [10, 100, 1, 120, 100, 1] }
  ]
  const maskOps: PaintOp[] = [{ id: ID(303), clip: MASK_CLIP, kind: 'fill-all', color: '#FFFFFF', opacity: 0.5, lockAlpha: true }]
  const expected = new Uint8ClampedArray(128 * 128 * 4)
  applyPaintOps(expected, 128, 128, ops, new Map([[CLIP, clip]]))
  const coverage = maskCoverage(mask, 128, 128, maskOps, new Map([[MASK_CLIP, maskClip]]))
  applyMaskAlpha(expected, expected, coverage, 128)
  // Nothing reached past the selection, and the band shows only where the mask was painted.
  expect(expected[(20 * 128 + 100) * 4 + 3]).toBe(0)
  expect(expected[(64 * 128 + 20) * 4 + 3]).toBe(0)
  expect(expected[(100 * 128 + 20) * 4 + 3]).toBe(255)

  const layer = { ...paintedLayer(ops), mask: { assetId: MASK, paint: maskOps, enabled: true } }
  expect(largestDifference(await rgba(await paintedImageBytes(files.get(ASSET)!, ops, resolve, layer.mask)), expected)).toBe(0)
  const rendered = await rgba((await new CompositeReferenceRenderer(resolve).render(scene([layer]), 'final')).buffer)
  expect(largestDifference(rendered, overWhite(expected))).toBeLessThanOrEqual(2)

  // A turned-off mask hides nothing.
  const off = await rgba((await new CompositeReferenceRenderer(resolve).render(scene([{ ...layer, mask: { assetId: MASK, paint: maskOps, enabled: false } }]), 'final')).buffer)
  const unmasked = new Uint8ClampedArray(128 * 128 * 4)
  applyPaintOps(unmasked, 128, 128, ops, new Map([[CLIP, clip]]))
  expect(largestDifference(off, overWhite(unmasked))).toBeLessThanOrEqual(2)
})

it('masks a shape layer over its box in the reference, and merging draws it masked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shape-mask-'))
  roots.push(root)
  // A 32×32 mask: the shape's left half hidden.
  const gray = new Uint8Array(32 * 32)
  for (let y = 0; y < 32; y += 1) gray.fill(255, y * 32 + 16, y * 32 + 32)
  const path = join(root, 'mask.png')
  await sharp(Buffer.from(gray), { raw: { width: 32, height: 32, channels: 1 } }).png().toFile(path)
  const resolve = async (id: string): Promise<string | null> => id === MASK ? path : null
  const shape: SceneElement = {
    ...BASE, id: ID(31), type: 'shape', name: '块', zIndex: 0, transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 },
    shape: 'rectangle', fill: '#C02020', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final', mask: { assetId: MASK, enabled: true }
  }
  const rendered = await sharp((await new CompositeReferenceRenderer(resolve).render(scene([shape]), 'final')).buffer).raw().toBuffer({ resolveWithObject: true })
  const pixel = (x: number, y: number): number[] => [...rendered.data.subarray((y * 128 + x) * rendered.info.channels, (y * 128 + x) * rendered.info.channels + 3)]
  expect(pixel(40, 64)).toEqual([255, 255, 255])
  expect(pixel(88, 64)).toEqual([0xC0, 0x20, 0x20])

  const drawn = await drawLayers(scene([shape]), [shape.id], shape.id, resolve)
  // The mask's soft edge, stretched over the box, can reach one pixel into the hidden half.
  expect(drawn.transform.x).toBeCloseTo(0.5, 1)
  expect(drawn.transform.width).toBeCloseTo(0.25, 1)
})

it('builds the agent\'s layer masks in the layer\'s own pixels: shapes from the canvas, the subject from the picture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'layer-mask-'))
  roots.push(root)
  const MASK_ASSET = ID(301)
  // A 200×100 picture whose right quarter is transparent, placed over the canvas's middle 64×64 pixels.
  const picture = Buffer.alloc(200 * 100 * 4)
  for (let pixel = 0; pixel < 200 * 100; pixel += 1) picture.set([120, 80, 40, pixel % 200 < 150 ? 255 : 0], pixel * 4)
  await sharp(picture, { raw: { width: 200, height: 100, channels: 4 } }).png().toFile(join(root, 'picture.png'))
  await sharp(Buffer.alloc(200 * 100, 255), { raw: { width: 200, height: 100, channels: 1 } }).extract({ left: 0, top: 0, width: 200, height: 50 })
    .extend({ bottom: 50, background: { r: 0, g: 0, b: 0 } }).png().toFile(join(root, 'mask.png'))
  const paths: Record<string, string> = { [ASSET]: join(root, 'picture.png'), [MASK_ASSET]: join(root, 'mask.png') }
  const deps = {
    resolveAsset: async (assetId: string) => paths[assetId] ?? null,
    assetSize: async (assetId: string) => assetId === ASSET || assetId === MASK_ASSET ? { width: 200, height: 100 } : null,
    // A stand-in model: the left half of whatever it is shown, and a faint guess everywhere else.
    subject: async (pixels: Uint8Array, width: number, height: number) => {
      expect(pixels.length).toBe(width * height * 4)
      return Uint8Array.from({ length: width * height }, (_, index) => index % width < width / 2 ? 255 : 10)
    }
  }
  const layer = { ...paintedLayer([]), transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 } }
  const at = (mask: { readonly width: number; readonly data: Uint8Array }, x: number, y: number): number => mask.data[y * mask.width + x]!
  const build = async (element: SceneElement, spec: Omit<Parameters<typeof buildLayerMask>[1], 'elementId'>) => {
    const built = await buildLayerMask(scene([element]), { elementId: element.id, ...spec }, deps)
    if (typeof built === 'string') throw new Error(built)
    return built
  }

  // The canvas's left half reaches the middle of the layer, which spans canvas x 32–96.
  const half = await build(layer, { shape: { kind: 'box', box: { x: 0, y: 0, width: 0.5, height: 1 } }, combine: 'replace', invert: false, feather: 0 })
  expect([half.width, half.height]).toEqual([200, 100])
  expect([at(half, 10, 50), at(half, 95, 50), at(half, 105, 50), at(half, 190, 50)]).toEqual([255, 255, 0, 0])
  // Subtracting from a layer with no mask hides only the shape.
  const hidden = await build(layer, { shape: { kind: 'box', box: { x: 0, y: 0, width: 0.5, height: 1 } }, combine: 'subtract', invert: false, feather: 0 })
  expect([at(hidden, 10, 50), at(hidden, 190, 50)]).toEqual([0, 255])
  const triangle = await build(layer, { shape: { kind: 'polygons', polygons: [[{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.25, y: 0.75 }]] }, combine: 'replace', invert: false, feather: 0 })
  expect([at(triangle, 20, 10), at(triangle, 180, 90)]).toEqual([255, 0])
  // A selection with a hole in it shows all but the hole.
  const square = (left: number, top: number, size: number) => [{ x: left, y: top }, { x: left + size, y: top }, { x: left + size, y: top + size }, { x: left, y: top + size }]
  const ring = await build(layer, { shape: { kind: 'polygons', polygons: [square(0, 0, 1)], holes: [square(0.4, 0.4, 0.2)] }, combine: 'replace', invert: false, feather: 0 })
  expect([at(ring, 20, 10), at(ring, 100, 50), at(ring, 190, 90)]).toEqual([255, 0, 255])
  // Feathered over 4 canvas pixels, about 12 of the layer's across the edge.
  const soft = await build(layer, { shape: { kind: 'box', box: { x: 0, y: 0, width: 0.5, height: 1 } }, combine: 'replace', invert: false, feather: 4 })
  expect(at(soft, 100, 50)).toBeGreaterThan(80)
  expect(at(soft, 100, 50)).toBeLessThan(180)
  expect(at(soft, 80, 50)).toBe(255)

  // The subject is found in the layer's own pixels; faint guesses and transparent pixels are left out.
  const subject = await build(layer, { shape: { kind: 'subject' }, combine: 'replace', invert: true, feather: 0 })
  expect([at(subject, 10, 50), at(subject, 120, 50), at(subject, 180, 50)]).toEqual([0, 255, 255])
  expect(await buildLayerMask(scene([layer]), { elementId: layer.id, shape: { kind: 'subject' }, combine: 'replace', invert: false, feather: 0 }, { ...deps, subject: null }))
    .toBe('选择主体用的模型还没有下载。')

  // The mask it has, inverted; a new shape added to it keeps what it showed.
  const masked = { ...layer, mask: { assetId: MASK_ASSET, enabled: true } }
  const inverted = await build(masked, { shape: { kind: 'current' }, combine: 'replace', invert: true, feather: 0 })
  expect([at(inverted, 100, 10), at(inverted, 100, 90)]).toEqual([0, 255])
  const added = await build(masked, { shape: { kind: 'box', box: { x: 0, y: 0, width: 0.5, height: 1 } }, combine: 'add', invert: false, feather: 0 })
  expect([at(added, 190, 10), at(added, 10, 90), at(added, 190, 90)]).toEqual([255, 255, 0])

  // A shape layer's mask stretches over its box, at its size in canvas pixels.
  const block: SceneElement = {
    ...BASE, id: ID(302), type: 'shape', name: '块', zIndex: 0, transform: { x: 0, y: 0, width: 0.5, height: 0.25, rotation: 0 },
    shape: 'rectangle', fill: '#C02020', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
  }
  const boxMask = await build(block, { shape: { kind: 'ellipse', box: { x: 0, y: 0, width: 0.5, height: 0.25 } }, combine: 'replace', invert: false, feather: 0 })
  expect([boxMask.width, boxMask.height, at(boxMask, 32, 16), at(boxMask, 0, 0)]).toEqual([64, 32, 255, 0])
  expect(await buildLayerMask(scene([block]), { elementId: block.id, shape: { kind: 'subject' }, combine: 'replace', invert: false, feather: 0 }, deps)).toBe('主体只能在图片图层上找。')
})
