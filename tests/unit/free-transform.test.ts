import { describe, expect, it } from 'vitest'
import {
  IDENTITY_CORNERS,
  MIRRORED_CORNERS,
  affineOf,
  anchoredFrame,
  applyMatrix,
  aspectNear,
  boxWarpMatrix,
  cornersAreAffine,
  cornersAreDrawable,
  decomposeAffine,
  homographyFromCorners,
  invertMatrix,
  layerCanvasBounds,
  layerCornerPoints,
  placeFromCornerPoints,
  reframeScene,
  remapGrayMask,
  sceneSchema,
  type SceneCommand,
  type Corners,
  type Point,
  type Scene,
  type SceneElement
} from '../../src/domain'
import { produce } from 'immer'
import { applySceneCommand } from '../../src/domain/commands/apply-command'
import { warpLayerPixels, warpLayout } from '../../src/shared/warp'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

const canvas = { width: 1000, height: 800 }

function applyCommands(scene: Scene, commands: readonly SceneCommand[]): Scene {
  return sceneSchema.parse(produce(scene, (draft) => { for (const command of commands) applySceneCommand(draft, command) }))
}

function close(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length)
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits))
}

describe('free transform corners', () => {
  it('maps the unit square onto the corners, projective or not', () => {
    const perspective: Corners = [[0.2, 0], [0.8, 0], [1, 1], [0, 1]]
    const matrix = homographyFromCorners(perspective)
    close(applyMatrix(matrix, 0, 0), [0.2, 0])
    close(applyMatrix(matrix, 1, 0), [0.8, 0])
    close(applyMatrix(matrix, 1, 1), [1, 1])
    close(applyMatrix(matrix, 0, 1), [0, 1])
    // The middle of the square lands where the diagonals cross, not at the average of the corners.
    close(applyMatrix(matrix, 0.5, 0.5), [0.5, 0.375])
    const inverse = invertMatrix(matrix)
    close(applyMatrix(inverse, ...applyMatrix(matrix, 0.3, 0.7)), [0.3, 0.7])
    expect(cornersAreAffine(perspective)).toBe(false)
    expect(cornersAreAffine([[0.2, 0], [1.2, 0], [1, 1], [0, 1]])).toBe(true)
  })

  it('refuses corners that fold the box over itself or squash it flat', () => {
    expect(cornersAreDrawable(IDENTITY_CORNERS)).toBe(true)
    expect(cornersAreDrawable(MIRRORED_CORNERS)).toBe(true)
    expect(cornersAreDrawable([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(false)
    expect(cornersAreDrawable([[0, 0], [1, 0], [2, 0], [0, 0.000001]])).toBe(false)
    expect(cornersAreDrawable([[0, 0], [1, 0], [0.2, 0.2], [0, 1]])).toBe(false)
  })

  it('splits an affine map the way Konva sets a node, mirror included', () => {
    for (const corners of [[[0.25, 0], [1.25, 0], [1, 1], [0, 1]], MIRRORED_CORNERS, [[0, 1], [1, 1], [1, 0], [0, 0]]] as Corners[]) {
      const affine = affineOf(boxWarpMatrix(corners, 300, 200))
      const parts = decomposeAffine(affine)
      const angle = parts.rotation * Math.PI / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      // Konva: translate · rotate · skew(skewX, 0) · scale.
      const a = cos * parts.scaleX
      const b = sin * parts.scaleX
      const c = parts.scaleY * (cos * parts.skewX - sin)
      const d = parts.scaleY * (sin * parts.skewX + cos)
      close([a, b, c, d, parts.x, parts.y], affine)
    }
  })

  it('finds a layer on the canvas through its turn and its corners', () => {
    const transform = { x: 0.1, y: 0.1, width: 0.2, height: 0.25, rotation: 90 }
    const points = layerCornerPoints(transform, MIRRORED_CORNERS, canvas)
    // Turned a quarter about the top-left corner (100, 80): the box runs down from there and to the left.
    close(points[0], [100, 280])
    close(points[1], [100, 80])
    close(points[2], [-100, 80])
    const bounds = layerCanvasBounds(transform, null, canvas)
    close([bounds.x, bounds.y, bounds.width, bounds.height], [-100, 80, 200, 200])
  })

  it('turns corner points back into a plain box, a mirrored box, or the box with corners', () => {
    const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.25, rotation: 0 }
    const rect = (points: Point[]): readonly [Point, Point, Point, Point] => points as unknown as readonly [Point, Point, Point, Point]
    // Moved and scaled: a plain box.
    const moved = placeFromCornerPoints(rect([[200, 100], [500, 100], [500, 300], [200, 300]]), box, canvas)
    expect(moved?.corners).toBeNull()
    close(Object.values(moved!.transform), [0.2, 0.125, 0.3, 0.25, 0])
    // Flipped left to right: the same box, mirrored corners.
    const flipped = placeFromCornerPoints(rect([[400, 80], [100, 80], [100, 280], [400, 280]]), box, canvas)
    expect(flipped?.corners).toEqual(MIRRORED_CORNERS)
    close(Object.values(flipped!.transform), [0.1, 0.1, 0.3, 0.25, 0])
    // Flipped top to bottom: mirrored and turned half round, covering the same place.
    const upsideDown = placeFromCornerPoints(rect([[100, 280], [400, 280], [400, 80], [100, 80]]), box, canvas)
    expect(upsideDown?.corners).toEqual(MIRRORED_CORNERS)
    expect(Math.abs(upsideDown!.transform.rotation)).toBeCloseTo(180)
    expect(layerCanvasBounds(upsideDown!.transform, upsideDown!.corners, canvas)).toMatchObject({ x: expect.closeTo(100), y: expect.closeTo(80), width: expect.closeTo(300), height: expect.closeTo(200) })
    // Skewed: the box stays, the corners record the shear; text accepts it.
    const skewed = placeFromCornerPoints(rect([[150, 80], [450, 80], [400, 280], [100, 280]]), box, canvas, true)
    expect(skewed?.transform).toEqual(box)
    close(skewed!.corners!.flat(), [1 / 6, 0, 7 / 6, 0, 1, 1, 0, 1])
    // A perspective is not for text.
    expect(placeFromCornerPoints(rect([[150, 80], [350, 80], [400, 280], [100, 280]]), box, canvas, true)).toBeNull()
  })
})

describe('warp', () => {
  it('resamples a layer into its perspective, with transparent outside and straight colours at the edge', () => {
    const size = 40
    const source = new Uint8ClampedArray(size * size * 4)
    for (let index = 0; index < size * size; index += 1) source.set([200, 40, 20, 255], index * 4)
    const corners: Corners = [[0.25, 0], [0.75, 0], [1, 1], [0, 1]]
    const { layout, pixels } = warpLayerPixels(source, size, size, corners, size, size, 1)
    expect(layout.rasterWidth).toBe(size + 2)
    const at = (x: number, y: number): number[] => [...pixels.slice(((y - Math.floor(layout.y)) * layout.rasterWidth + (x - Math.floor(layout.x))) * 4, ((y - Math.floor(layout.y)) * layout.rasterWidth + (x - Math.floor(layout.x))) * 4 + 4)]
    // Inside the trapezoid: the colour; at its top corners outside: nothing.
    expect(at(20, 20)).toEqual([200, 40, 20, 255])
    expect(at(2, 2)[3]).toBe(0)
    // Edge pixels are partly covered but keep the colour, not darkened by the transparent outside.
    let edges = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3]!
      if (alpha > 0 && alpha < 255) {
        edges += 1
        expect(Math.abs(pixels[index]! - 200)).toBeLessThanOrEqual(1)
      }
    }
    expect(edges).toBeGreaterThan(20)
  })

  it('gives a raster that covers corners beyond the box', () => {
    const layout = warpLayout([[-0.5, 0], [1, 0], [1.5, 1], [0, 1]], 100, 50, 2)
    // On whole box pixels, a pixel to spare each side.
    expect(layout.x).toBe(-51)
    expect(layout.width).toBe(202)
    expect(layout.rasterWidth).toBe(404)
  })
})

describe('reframe', () => {
  function sceneWithAdjustment(): Scene {
    const scene = makeAllElementTypesScene()
    const adjustment = {
      id: '00000000-0000-4000-8000-0000000000a1', version: 1, type: 'adjustment', name: '曲线', description: '', zIndex: scene.elements.length,
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, opacity: 1, visible: true, locked: false, groupId: null,
      semanticRole: 'content', referencePolicy: 'include', settings: { kind: 'invert' },
      mask: { assetId: '00000000-0000-4000-8000-0000000000a2', enabled: true }
    } as unknown as SceneElement
    return sceneSchema.parse({ ...scene, canvas: { ...scene.canvas, guides: [{ axis: 'x', position: 100 }, { axis: 'y', position: 50 }] }, elements: [...scene.elements, adjustment] })
  }

  it('keeps every layer where it is in pixels, moves guides and mask outlines, and leaves adjustment layers on the whole canvas', () => {
    const scene = sceneWithAdjustment()
    const { outputWidth, outputHeight } = scene.canvas
    const frame = { left: -200, top: 100, width: outputWidth + 400, height: outputHeight - 100 }
    const reframe = reframeScene(scene, frame)
    const after = applyCommands(scene, reframe.commands)
    expect(after.canvas.outputWidth).toBe(frame.width)
    expect(after.canvas.guides).toEqual([{ axis: 'x', position: 300 }, { axis: 'y', position: -50 }])
    for (const element of scene.elements) {
      const next = after.elements.find((candidate) => candidate.id === element.id)!
      if (element.type === 'adjustment') {
        expect(next.transform).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
        continue
      }
      expect(next.transform.x * frame.width + frame.left).toBeCloseTo(element.transform.x * outputWidth, 3)
      expect(next.transform.y * frame.height + frame.top).toBeCloseTo(element.transform.y * outputHeight, 3)
      expect(next.transform.width * frame.width).toBeCloseTo(element.transform.width * outputWidth, 3)
    }
    const mask = after.elements.find((element) => element.id === IDS.mask)
    const before = scene.elements.find((element) => element.id === IDS.mask)
    if (mask?.type === 'mask' && before?.type === 'mask') {
      expect(mask.paths[0]!.points[0]!.x * frame.width + frame.left).toBeCloseTo(before.paths[0]!.points[0]!.x * outputWidth, 3)
    }
    expect(reframe.maskRemaps).toEqual([{ elementId: '00000000-0000-4000-8000-0000000000a1', assetId: '00000000-0000-4000-8000-0000000000a2', canvasWidth: outputWidth, canvasHeight: outputHeight, frame: { ...frame } }])
  })

  it('keeps layers far off a small crop', () => {
    const scene = sceneWithAdjustment()
    const after = applyCommands(scene, reframeScene(scene, { left: 10, top: 10, width: 64, height: 64 }).commands)
    expect(after.elements.find((element) => element.id === IDS.shape)?.transform.width).toBeGreaterThan(4)
  })

  it('places the old canvas by its anchor and cuts or grows a mask by repeating its edge', () => {
    expect(anchoredFrame({ outputWidth: 1000, outputHeight: 800 }, 1200, 1000, 'center')).toEqual({ left: -100, top: -100, width: 1200, height: 1000 })
    expect(anchoredFrame({ outputWidth: 1000, outputHeight: 800 }, 1200, 1000, 'top-left')).toEqual({ left: 0, top: 0, width: 1200, height: 1000 })
    expect(anchoredFrame({ outputWidth: 1000, outputHeight: 800 }, 600, 600, 'bottom-right')).toEqual({ left: 400, top: 200, width: 600, height: 600 })
    const mask = Uint8Array.from([0, 255, 10, 20])
    expect([...remapGrayMask(mask, 2, 2, { left: -1, top: 0, width: 4, height: 2 }, 4, 2)]).toEqual([0, 0, 255, 255, 10, 10, 20, 20])
    expect(aspectNear(1234, 567)).toEqual({ width: 37, height: 17 })
  })
})
