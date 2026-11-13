import { describe, expect, it } from 'vitest'
import {
  ELEMENT_SCHEMA_VERSION,
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
  distortQuad,
  flipQuad,
  perspectiveQuad,
  quadCentre,
  quadIsDrawable,
  rotateQuad,
  scaleQuad,
  skewQuad,
  transformLayers,
  transformLayersByQuads,
  transformQuad,
  type Corners,
  type Point,
  type Quad,
  type Scene,
  type SceneElement
} from '../../src/domain'
import { produce } from 'immer'
import { applySceneCommand } from '../../src/domain/commands/apply-command'
import { warpLayerPixels, warpLayout, warpPixels, warpSourceMatrix } from '../../src/shared/warp'
import { expandBand, expandMask } from '../../src/renderer/src/selection/generative-fill'
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
    // A skew, a mirror, a vertical flip, and a mirror skewed (the sign of the skew kept through the mirror).
    for (const corners of [[[0.25, 0], [1.25, 0], [1, 1], [0, 1]], MIRRORED_CORNERS, [[0, 1], [1, 1], [1, 0], [0, 0]], [[1, 0], [0, 0], [0.25, 1], [1.25, 1]]] as Corners[]) {
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

describe('warp past the box', () => {
  it('keeps what is drawn past the box, a stroke\'s outer half, through the warp', () => {
    const corners: Corners = [[0.2, 0], [1.2, 0], [1, 1], [0, 1]]
    const margin = 4
    const size = 20 + 2 * margin
    // A line three pixels left of the box, all the way down, in a source that starts `margin` before the box.
    const source = new Uint8ClampedArray(size * size * 4)
    for (let y = 0; y < size; y += 1) source.set([255, 255, 255, 255], (y * size + 1) * 4)
    expect(warpLayout(corners, 20, 20, 1).x).toBeGreaterThan(-3)
    const layout = warpLayout(corners, 20, 20, 1, margin)
    expect(layout.x).toBeLessThanOrEqual(-margin - 1)
    const pixels = warpPixels(source, size, size, layout.rasterWidth, layout.rasterHeight, warpSourceMatrix(corners, 20, 20, layout, 20, 20, margin))
    const alpha = (x: number, y: number): number => pixels[((y - layout.y) * layout.rasterWidth + (x - layout.x)) * 4 + 3]!
    // At the bottom the skew has barely moved it; at the top it went a fifth of the box to the right.
    expect(alpha(-3, 19)).toBeGreaterThan(100)
    expect(alpha(1, 0)).toBeGreaterThan(100)
    expect(alpha(-3, 0)).toBe(0)
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

  it('keeps every layer where it is in pixels, moves guides, and leaves adjustment layers on the whole canvas', () => {
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
    // A mask's outline is in its own box, which moved with it.
    expect(mask?.type === 'mask' && before?.type === 'mask' ? mask.paths : null).toEqual(before?.type === 'mask' ? before.paths : undefined)
    expect(reframe.maskRemaps).toEqual([{ elementId: '00000000-0000-4000-8000-0000000000a1', assetId: '00000000-0000-4000-8000-0000000000a2', canvasWidth: outputWidth, canvasHeight: outputHeight, frame: { ...frame } }])
  })

  it('moves a locked layer too, and leaves it locked', () => {
    const scene = sceneWithAdjustment()
    const locked = sceneSchema.parse({ ...scene, elements: scene.elements.map((element) => element.id === IDS.image ? { ...element, locked: true } : element) })
    const frame = { left: -100, top: -50, width: locked.canvas.outputWidth + 200, height: locked.canvas.outputHeight + 100 }
    const after = applyCommands(locked, reframeScene(locked, frame).commands)
    const image = after.elements.find((element) => element.id === IDS.image)!
    const before = locked.elements.find((element) => element.id === IDS.image)!
    expect(image.locked).toBe(true)
    expect(image.transform.x * frame.width + frame.left).toBeCloseTo(before.transform.x * locked.canvas.outputWidth, 3)
  })

  it('names the layers a frame would take further or larger than a scene can hold', () => {
    const base = sceneWithAdjustment()
    const big = sceneSchema.parse({ ...base, canvas: { ...base.canvas, outputWidth: 8192, outputHeight: 8192, aspectWidth: 1, aspectHeight: 1 }, elements: base.elements.map((element) => element.id === IDS.image ? { ...element, transform: { x: -1.5, y: -1.5, width: 4, height: 4, rotation: 0 } } : element) })
    const image = big.elements.find((element) => element.id === IDS.image)!
    // Four canvases wide on an 8192-pixel canvas is 512 times a 64-pixel one.
    expect(reframeScene(big, { left: 4064, top: 4064, width: 64, height: 64 }).outOfRange).toEqual([image.name])
    expect(reframeScene(big, { left: 0, top: 0, width: 4096, height: 4096 }).outOfRange).toEqual([])
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
    // Past 100:1 either way, the nearest ratio the canvas can store, still the right way round.
    expect(aspectNear(8192, 64)).toEqual({ width: 100, height: 1 })
    expect(aspectNear(64, 16384)).toEqual({ width: 1, height: 100 })
  })
})

describe('transform box handles', () => {
  const box: Quad = [[100, 100], [300, 100], [300, 200], [100, 200]]
  const rounded = (quad: Quad): number[][] => quad.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])

  it('scales from the opposite handle, keeping proportions at a corner unless Shift is held, or from the middle with Alt', () => {
    expect(rounded(scaleQuad(box, 2, [500, 300], { free: false, fromCentre: false }))).toEqual([[100, 100], [500, 100], [500, 300], [100, 300]])
    expect(rounded(scaleQuad(box, 2, [500, 200], { free: false, fromCentre: false }))).toEqual([[100, 100], [400, 100], [400, 250], [100, 250]])
    expect(rounded(scaleQuad(box, 2, [500, 200], { free: true, fromCentre: false }))).toEqual([[100, 100], [500, 100], [500, 200], [100, 200]])
    // The right side scales across only; with Alt the left side moves the other way.
    expect(rounded(scaleQuad(box, 5, [400, 150], { free: true, fromCentre: true }))).toEqual([[0, 100], [400, 100], [400, 200], [0, 200]])
  })

  it('skews along a side, distorts a corner, pulls a perspective, turns and flips', () => {
    expect(rounded(skewQuad(box, 4, [50, 30], { along: true, symmetric: false }))).toEqual([[150, 100], [350, 100], [300, 200], [100, 200]])
    expect(rounded(skewQuad(box, 4, [50, 30], { along: false, symmetric: true }))).toEqual([[150, 130], [350, 130], [250, 170], [50, 170]])
    expect(rounded(distortQuad(box, 1, [20, -10]))).toEqual([[100, 100], [320, 90], [300, 200], [100, 200]])
    // Dragging the top-left corner in narrows the top from both sides.
    expect(rounded(perspectiveQuad(box, 0, [40, 5]))).toEqual([[140, 100], [260, 100], [300, 200], [100, 200]])
    expect(rounded(perspectiveQuad(box, 0, [3, 30]))).toEqual([[100, 130], [300, 100], [300, 200], [100, 170]])
    expect(rounded(rotateQuad(box, quadCentre(box), 90))).toEqual([[250, 50], [250, 250], [150, 250], [150, 50]])
    expect(rounded(flipQuad(box, quadCentre(box), 'horizontal'))).toEqual([[300, 100], [100, 100], [100, 200], [300, 200]])
    expect(quadIsDrawable(distortQuad(box, 0, [300, 200]))).toBe(false)
  })

  it('moves every layer through the box, groups fitted around them, text refused a perspective', () => {
    const scene = makeAllElementTypesScene()
    const image = scene.elements.find((element) => element.id === IDS.image)!
    const text = scene.elements.find((element) => element.id === IDS.text)!
    const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
    const from = transformQuad(scene, [image])!
    const narrowed = perspectiveQuad(from, 0, [20, 0])
    const outcome = transformLayersByQuads(scene, [image], from, narrowed)
    expect(outcome.ok).toBe(true)
    const after = applyCommands(scene, outcome.ok ? outcome.commands : [])
    const moved = after.elements.find((element) => element.id === IDS.image)!
    const points = layerCornerPoints(moved.transform, moved.type === 'image' ? moved.corners : null, canvas)
    points.forEach((point, index) => close(point, narrowed[index]!, 4))
    const textOutcome = transformLayersByQuads(scene, [text], transformQuad(scene, [text])!, perspectiveQuad(transformQuad(scene, [text])!, 0, [20, 0]))
    expect(textOutcome).toEqual({ ok: false, reason: '「主标题」是文字，只能翻转和斜切；扭曲、透视要先栅格化。' })
  })

  it('stretches a picture fitted into its box through its corners, and scales it as a box when kept in proportion', () => {
    const scene = makeAllElementTypesScene()
    const image = scene.elements.find((element) => element.id === IDS.image)!
    expect(image.type === 'image' ? image.fit : null).toBe('contain')
    const from = transformQuad(scene, [image])!
    const fixed = from[0]
    const resized = (factorX: number, factorY: number, picture: SceneElement): SceneElement => {
      const outcome = transformLayersByQuads(sceneSchema.parse({ ...scene, elements: scene.elements.map((element) => element.id === picture.id ? picture : element) }), [picture], from, from.map(([x, y]) => [fixed[0] + (x - fixed[0]) * factorX, fixed[1] + (y - fixed[1]) * factorY]) as unknown as Quad)
      expect(outcome.ok).toBe(true)
      return applyCommands(scene, outcome.ok ? outcome.commands : []).elements.find((element) => element.id === picture.id)!
    }
    // Widened: the box stays, so it is not fitted again; the stretch is in its corners.
    const widened = resized(1.5, 1, image)
    expect(widened.transform).toEqual(image.transform)
    close((widened.type === 'image' ? widened.corners ?? [] : []).flat(), [0, 0, 1.5, 0, 1.5, 1, 0, 1], 4)
    // Doubled: the same shape of box, so it is simply larger.
    const doubled = resized(2, 2, image)
    expect(doubled.transform.width).toBeCloseTo(image.transform.width * 2, 4)
    expect(doubled.type === 'image' ? doubled.corners ?? null : 'not an image').toBeNull()
    // A picture filling its box stretches with the box.
    const filling = resized(1.5, 1, { ...image, fit: 'fill' } as SceneElement)
    expect(filling.transform.width).toBeCloseTo(image.transform.width * 1.5, 4)
    expect(filling.type === 'image' ? filling.corners ?? null : 'not an image').toBeNull()
  })

  it('fits a group around what its layers cover, corners and turns included', () => {
    const scene = makeAllElementTypesScene()
    const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
    const groupId = '00000000-0000-4000-8000-0000000000c1'
    const group = {
      id: groupId, version: ELEMENT_SCHEMA_VERSION, type: 'group', name: '组合', description: '', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 0,
      opacity: 1, blendMode: 'normal', visible: true, locked: false, groupId: null, semanticRole: 'composition', referencePolicy: 'include', childIds: [IDS.image, IDS.shape]
    } as unknown as Extract<SceneElement, { type: 'group' }>
    const grouped = applyCommands(scene, [{ kind: 'element.group', group, elementIds: [IDS.image, IDS.shape] }])
    const image = grouped.elements.find((element) => element.id === IDS.image)!
    const from = transformQuad(grouped, [image])!
    // The bottom pulled a whole box to the right: the picture now reaches past its box, and the group follows it.
    const width = from[1][0] - from[0][0]
    const outcome = transformLayersByQuads(grouped, [image], from, [from[0], from[1], [from[2][0] + width, from[2][1]], [from[3][0] + width, from[3][1]]] as unknown as Quad)
    expect(outcome.ok).toBe(true)
    const after = applyCommands(grouped, outcome.ok ? outcome.commands : [])
    const skewed = after.elements.find((element) => element.id === IDS.image)!
    const reach = Math.max(...layerCornerPoints(skewed.transform, skewed.type === 'image' ? skewed.corners : null, canvas).map(([x]) => x)) / canvas.width
    const fitted = after.elements.find((element) => element.id === groupId)!.transform
    expect(reach).toBeGreaterThan(skewed.transform.x + skewed.transform.width)
    expect(fitted.x + fitted.width).toBeCloseTo(Math.max(reach, ...after.elements.filter((element) => element.groupId === groupId).map((element) => element.transform.x + element.transform.width)), 6)
    // Grouping a turned layer takes in where it is turned to.
    const turned = sceneSchema.parse({ ...scene, elements: scene.elements.map((element) => element.id === IDS.shape ? { ...element, transform: { ...element.transform, rotation: 90 } } : element) })
    const shape = turned.elements.find((element) => element.id === IDS.shape)!
    const around = applyCommands(turned, [{ kind: 'element.group', group: { ...group, childIds: [IDS.shape] }, elementIds: [IDS.shape] }]).elements.find((element) => element.id === groupId)!.transform
    const bounds = layerCanvasBounds(shape.transform, null, canvas)
    close([around.x, around.y, around.width, around.height], [bounds.x / canvas.width, bounds.y / canvas.height, bounds.width / canvas.width, bounds.height / canvas.height], 6)
  })

  it('takes the box along when a reshaped layer is moved far, so its corners stay within what is stored', () => {
    const base = makeAllElementTypesScene()
    const big = sceneSchema.parse({ ...base, canvas: { ...base.canvas, outputWidth: 8192, outputHeight: 8192, aspectWidth: 1, aspectHeight: 1 } })
    const image = big.elements.find((element) => element.id === IDS.image)!
    const skewedCorners: Corners = [[0, 0], [1, 0], [1.25, 1], [0.25, 1]]
    const scene = sceneSchema.parse({ ...big, elements: big.elements.map((element) => element.id === IDS.image ? { ...element, transform: { x: 0.1, y: 0.1, width: 100 / 8192, height: 100 / 8192, rotation: 30 }, corners: skewedCorners } : element) })
    const skewed = scene.elements.find((element) => element.id === IDS.image)!
    const canvas = { width: 8192, height: 8192 }
    const before = layerCornerPoints(skewed.transform, skewedCorners, canvas)
    const outcome = transformLayers(scene, [skewed], ([x, y]) => [x + 6500, y])
    expect(outcome.ok).toBe(true)
    const moved = applyCommands(scene, outcome.ok ? outcome.commands : []).elements.find((element) => element.id === image.id)!
    const corners = moved.type === 'image' ? moved.corners! : null
    // The same shape, where it was moved to, and the corners near the box again.
    layerCornerPoints(moved.transform, corners, canvas).forEach((point, index) => close(point, [before[index]![0] + 6500, before[index]![1]], 4))
    expect(Math.max(...corners!.flat().map(Math.abs))).toBeLessThan(2)
  })

  it('scales text by its type when kept in proportion, and stretches it in its box when not', () => {
    const scene = makeAllElementTypesScene()
    const text = scene.elements.find((element) => element.id === IDS.text)!
    const from = transformQuad(scene, [text])!
    const fixed = from[0]
    const doubled = transformLayersByQuads(scene, [text], from, from.map(([x, y]) => [fixed[0] + (x - fixed[0]) * 2, fixed[1] + (y - fixed[1]) * 2]) as unknown as Quad)
    const grown = applyCommands(scene, doubled.ok ? doubled.commands : []).elements.find((element) => element.id === IDS.text)!
    expect(grown.type === 'text' ? [grown.fontSize, grown.letterSpacing, grown.corners ?? null] : null).toEqual([168, 36, null])
    expect(grown.transform.width).toBeCloseTo(text.transform.width * 2, 4)
    const widened = transformLayersByQuads(scene, [text], from, from.map(([x, y]) => [fixed[0] + (x - fixed[0]) * 1.5, y]) as unknown as Quad)
    const stretched = applyCommands(scene, widened.ok ? widened.commands : []).elements.find((element) => element.id === IDS.text)!
    expect(stretched.transform).toEqual(text.transform)
    expect(stretched.type === 'text' ? stretched.fontSize : null).toBe(84)
    close((stretched.type === 'text' ? stretched.corners ?? [] : []).flat(), [0, 0, 1.5, 0, 1.5, 1, 0, 1], 4)
  })
})

describe('generative expand', () => {
  it('covers what the canvas added and fades into the old picture across a band, only on its open sides', () => {
    const mask = expandMask(200, 100, { left: 50, top: 0, width: 100, height: 100 })!
    const at = (x: number, y: number): number => mask.data[y * 200 + x]!
    expect(expandBand(200, 100)).toBe(8)
    expect(at(10, 50)).toBe(255)
    expect(at(190, 50)).toBe(255)
    // Inside the old picture: fading in from the left side, nothing in the middle, and no fade along the closed top.
    expect(at(50, 50)).toBeGreaterThan(200)
    expect(at(53, 50)).toBeGreaterThan(at(56, 50))
    expect(at(58, 50)).toBe(0)
    expect(at(100, 0)).toBe(0)
    expect(expandMask(200, 100, { left: 0, top: 0, width: 200, height: 100 })).toBeNull()
  })
})
