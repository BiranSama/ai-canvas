import { describe, expect, it } from 'vitest'
import { boxLayerSpace, canvasToLayer, imageLayerSpace, layerMaskOnCanvas, maskInLayerSpace } from '../../src/shared/layer-space'
import {
  combineMasks,
  createMask,
  decodeMask,
  ellipseMask,
  encodeMask,
  featherMask,
  invertMask,
  isMaskEmpty,
  magicWandMask,
  maskBounds,
  maskIoU,
  polygonMask,
  rectMask,
  simplifyOutline,
  traceMaskOutline,
  translateMask,
  type GrayMask
} from '../../src/shared/mask-raster'
import { applyMaskAlpha, applyPaintOps, maskCoverage, maskGray } from '../../src/shared/paint-ops'
import type { SceneElement } from '../../src/domain'

function coverage(mask: GrayMask): number {
  let sum = 0
  for (const value of mask.data) sum += value / 255
  return sum
}

const at = (mask: GrayMask, x: number, y: number): number => mask.data[y * mask.width + x]!

describe('selection shapes', () => {
  it('snaps the rectangular marquee to whole pixels and draws ellipses and polygons with antialiased edges', () => {
    const rect = rectMask(20, 20, { x: 2.4, y: 3.6, width: 5.2, height: 4 })
    expect(maskBounds(rect)).toEqual({ x: 2, y: 4, width: 6, height: 4 })
    expect(new Set(rect.data)).toEqual(new Set([0, 255]))

    const ellipse = ellipseMask(200, 200, { x: 20, y: 40, width: 160, height: 100 })
    expect(coverage(ellipse) / (Math.PI * 80 * 50)).toBeCloseTo(1, 2)
    expect(at(ellipse, 100, 90)).toBe(255)
    expect(at(ellipse, 21, 41)).toBe(0)
    expect([...ellipse.data].some((value) => value > 0 && value < 255)).toBe(true)

    const triangle = polygonMask(100, 100, [10, 10, 90, 10, 10, 90])
    expect(coverage(triangle) / (80 * 80 / 2)).toBeCloseTo(1, 2)
    // Drawn either way round, the nonzero rule fills it the same.
    expect(maskIoU(triangle, polygonMask(100, 100, [10, 10, 10, 90, 90, 10]))).toBe(1)
  })

  it('adds, subtracts and intersects as Photoshop does, and inverts, moves and feathers', () => {
    const left = rectMask(10, 10, { x: 0, y: 0, width: 6, height: 10 })
    const right = rectMask(10, 10, { x: 4, y: 0, width: 6, height: 10 })
    expect(coverage(combineMasks(left, right, 'add'))).toBe(100)
    expect(coverage(combineMasks(left, right, 'subtract'))).toBe(40)
    expect(coverage(combineMasks(left, right, 'intersect'))).toBe(20)
    expect(combineMasks(left, right, 'replace')).toBe(right)
    // Subtracting from or intersecting with nothing leaves nothing.
    expect(isMaskEmpty(combineMasks(null, right, 'subtract'))).toBe(true)
    expect(coverage(invertMask(left))).toBe(40)
    expect(maskBounds(translateMask(left, 2, 3))).toEqual({ x: 2, y: 3, width: 6, height: 7 })

    const square = rectMask(80, 80, { x: 20, y: 20, width: 40, height: 40 })
    const soft = featherMask(square, 10)
    expect(coverage(soft) / coverage(square)).toBeCloseTo(1, 1)
    expect(at(soft, 40, 40)).toBe(255)
    expect(at(soft, 20, 40)).toBeGreaterThan(80)
    expect(at(soft, 20, 40)).toBeLessThan(180)
    expect(at(soft, 12, 40)).toBeLessThan(at(soft, 18, 40))
  })

  it('keeps old selections compact and traces their outline for the ants', () => {
    const ellipse = ellipseMask(300, 200, { x: 30, y: 30, width: 200, height: 120 })
    const runs = encodeMask(ellipse)
    expect(runs.length).toBeLessThan(ellipse.data.length / 20)
    expect(decodeMask(300, 200, runs).data).toEqual(ellipse.data)

    const outline = traceMaskOutline(rectMask(50, 50, { x: 10, y: 10, width: 20, height: 15 }))
    expect(outline).toHaveLength(1)
    const xs = [...outline[0]!].filter((_, index) => index % 2 === 0)
    const ys = [...outline[0]!].filter((_, index) => index % 2 === 1)
    // A rectangle's straight runs collapse to its corners, on the pixel edges.
    expect(xs.length).toBeLessThanOrEqual(8)
    expect(Math.min(...xs)).toBeCloseTo(10, 0)
    expect(Math.max(...xs)).toBeCloseTo(30, 0)
    expect(Math.min(...ys)).toBeCloseTo(10, 0)
    expect(Math.max(...ys)).toBeCloseTo(25, 0)
    expect(traceMaskOutline(createMask(10, 10))).toEqual([])
    // Two separate shapes are two outlines.
    expect(traceMaskOutline(combineMasks(rectMask(40, 20, { x: 2, y: 2, width: 8, height: 8 }), rectMask(40, 20, { x: 20, y: 2, width: 8, height: 8 }), 'add'))).toHaveLength(2)
  })

  it('picks pixels like the clicked one with the magic wand, joined or anywhere', () => {
    const width = 20
    const height = 10
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const red = x < 5 || x >= 15 ? 200 : x === 10 ? 0 : 205
        rgba.set([red, 0, 0, 255], (y * width + x) * 4)
      }
    }
    const joined = magicWandMask(rgba, width, height, 1, 1, 10, true, false)
    expect(coverage(joined)).toBe(5 * 10 + 5 * 10)
    const anywhere = magicWandMask(rgba, width, height, 1, 1, 10, false, false)
    expect(coverage(anywhere)).toBe(19 * 10)
    const strict = magicWandMask(rgba, width, height, 1, 1, 0, false, false)
    expect(coverage(strict)).toBe(10 * 10)
    const soft = magicWandMask(rgba, width, height, 1, 1, 0, true, true)
    expect(at(soft, 4, 5)).toBeLessThan(255)
    expect(at(soft, 4, 5)).toBeGreaterThan(0)
  })
})

describe('a selection in a layer\'s own pixels', () => {
  const canvas = { width: 100, height: 80 }
  const image = (changes: Partial<Extract<SceneElement, { type: 'image' }>> = {}): Extract<SceneElement, { type: 'image' }> => ({
    id: '50000000-0000-4000-8000-000000000001', version: 1, type: 'image', name: '图', description: '', zIndex: 0, opacity: 1, visible: true, locked: false,
    groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: '50000000-0000-4000-8000-000000000002',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', ...changes
  })

  it('copies the selection straight across for a layer that covers the canvas pixel for pixel', () => {
    const selection = ellipseMask(100, 80, { x: 10, y: 10, width: 50, height: 30 })
    const space = imageLayerSpace(image(), canvas, canvas)
    expect(maskInLayerSpace(selection, space)).toEqual(selection.data)
  })

  it('follows a layer\'s place, scale and rotation there and back', () => {
    const selection = rectMask(100, 80, { x: 30, y: 20, width: 30, height: 30 })
    const element = image({ transform: { x: 0.2, y: 0.1, width: 0.6, height: 0.7, rotation: 15 } })
    const space = imageLayerSpace(element, { width: 300, height: 280 }, canvas)
    const inLayer = maskInLayerSpace(selection, space)
    expect(inLayer.length).toBe(300 * 280)
    const back = layerMaskOnCanvas(inLayer, space, canvas)
    expect(maskIoU(back, selection)).toBeGreaterThan(0.95)
    // The inverse mapping lands on the same layer pixel.
    const toLayer = canvasToLayer(space)
    const [cx, cy] = space.toCanvas(120.5, 80.5)
    const [lx, ly] = toLayer.at(cx, cy)
    expect(lx).toBeCloseTo(120.5, 6)
    expect(ly).toBeCloseTo(80.5, 6)
    expect(toLayer.scale).toBeCloseTo(300 / 60, 6)
  })

  it('stretches a text or shape layer\'s mask over its box', () => {
    const element = image({ transform: { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0 } })
    const space = boxLayerSpace(element, { width: 25, height: 20 }, canvas)
    expect(space.toCanvas(0, 0)).toEqual([50, 40])
    expect(space.toCanvas(25, 20)).toEqual([100, 80])
  })
})

describe('layer masks in the shared pixel math', () => {
  it('replays a mask\'s paint over its gray and scales the layer\'s transparency by it', () => {
    const gray = new Uint8Array(4 * 2).fill(255)
    const coverageAfter = maskCoverage(gray, 4, 2, [{ id: '50000000-0000-4000-8000-000000000003', kind: 'fill-all', color: maskGray('#000000'), opacity: 0.5, lockAlpha: true }])
    expect([...coverageAfter]).toEqual(new Array(8).fill(128))
    const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(200)
    applyMaskAlpha(pixels, pixels, coverageAfter, 4, { x0: 0, y0: 0, x1: 2, y1: 2 })
    expect(pixels[3]).toBe(Math.round(200 * 128 / 255))
    expect(pixels[2 * 4 + 3]).toBe(200)
    expect(maskGray('#FF0000')).toBe('#4C4C4C')
  })

  it('limits each operation to its clip and leaves out one whose clip is missing', () => {
    const clip = new Uint8Array(4).fill(0)
    clip[1] = 255
    clip[2] = 128
    const pixels = new Uint8ClampedArray(16)
    const fill = { id: '50000000-0000-4000-8000-000000000004', clip: '50000000-0000-4000-8000-000000000005', kind: 'fill-all' as const, color: '#FF0000', opacity: 1, lockAlpha: false }
    applyPaintOps(pixels, 2, 2, [fill], new Map([[fill.clip, clip]]))
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...pixels.subarray(4, 8)]).toEqual([255, 0, 0, 255])
    expect(pixels[11]).toBe(128)
    const untouched = new Uint8ClampedArray(16)
    applyPaintOps(untouched, 2, 2, [fill])
    expect([...untouched]).toEqual(new Array(16).fill(0))
    // Delete in a selection clears only what it covers.
    const opaque = new Uint8ClampedArray(16).fill(255)
    applyPaintOps(opaque, 2, 2, [{ id: '50000000-0000-4000-8000-000000000006', clip: fill.clip, kind: 'clear' }], new Map([[fill.clip, clip]]))
    expect([opaque[3], opaque[7], opaque[11], opaque[15]]).toEqual([255, 0, 127, 255])
  })
})

describe('outline thinning', () => {
  it('drops the points within the tolerance of the line, and no point the outline needs', () => {
    const [outline] = traceMaskOutline(ellipseMask(400, 400, { x: 20, y: 20, width: 360, height: 360 }))
    const thin = simplifyOutline(outline!, 2)
    expect(thin.length).toBeLessThan(outline!.length / 4)
    expect(thin.length / 2).toBeGreaterThan(12)
    // Every traced point is still within the tolerance of the thinned outline.
    const distance = (x: number, y: number): number => {
      let nearest = Infinity
      for (let index = 0, count = thin.length / 2; index < count; index += 1) {
        const ax = thin[index * 2]!, ay = thin[index * 2 + 1]!
        const bx = thin[((index + 1) % count) * 2]!, by = thin[((index + 1) % count) * 2 + 1]!
        const length = Math.max(1e-9, (bx - ax) ** 2 + (by - ay) ** 2)
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length))
        nearest = Math.min(nearest, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))))
      }
      return nearest
    }
    for (let index = 0; index < outline!.length; index += 2) expect(distance(outline![index]!, outline![index + 1]!)).toBeLessThanOrEqual(2.01)
    // A triangle has nothing to drop.
    const triangle = Float32Array.of(0, 0, 10, 0, 0, 10)
    expect(simplifyOutline(triangle, 5)).toBe(triangle)
  })
})
