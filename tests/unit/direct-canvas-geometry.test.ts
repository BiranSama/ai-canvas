import { describe, expect, it } from 'vitest'
import {
  boundsForElements,
  clampCrop,
  clampPan,
  cornerRadiusFromLocalPoint,
  lineEndpointsForTransform,
  lineTransformFromStageEndpoints,
  rectFromPoints,
  rectsIntersect,
  shapeEditAnchors,
  shapeEditToolbarPosition,
  snapRect
} from '../../src/renderer/src/canvas/direct-canvas-geometry'
import { createElementForTool } from '../../src/renderer/src/canvas/element-factory'
import { createBlankScene } from '../../src/renderer/src/scene/create-blank-scene'

describe('Direct Canvas geometry', () => {
  it('normalizes marquee direction and detects intersections', () => {
    expect(rectFromPoints({ x: 20, y: 30 }, { x: 5, y: 10 })).toEqual({ x: 5, y: 10, width: 15, height: 20 })
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 4, height: 4 })).toBe(true)
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 11, width: 4, height: 4 })).toBe(false)
  })

  it('snaps edges and centers using the caller supplied screen threshold', () => {
    expect(snapRect(
      { x: 96, y: 37, width: 20, height: 20 },
      [{ x: 0, y: 0, width: 100, height: 100 }],
      5
    )).toMatchObject({ dx: 4, dy: 3, guides: [{ axis: 'x', position: 100 }, { axis: 'y', position: 50 }] })
  })

  it('keeps a minimum part of the artwork visible and clamps crop windows', () => {
    expect(clampPan({
      pan: { x: 900, y: -900 },
      viewport: { width: 500, height: 400 },
      centeredArtboard: { x: 100, y: 50, width: 300, height: 300 },
      minimumVisible: 72
    })).toEqual({ x: 328, y: -278 })
    expect(clampCrop({ x: -1, y: .9, width: .4, height: .4 })).toEqual({ x: 0, y: .6, width: .4, height: .4 })
  })

  it('computes a shared selection boundary', () => {
    const scene = createBlankScene()
    const first = createElementForTool('shape', scene)
    const second = createElementForTool('text', scene)
    if (first === null || second === null) throw new Error('Fixtures were not created.')
    first.transform = { x: .1, y: .2, width: .2, height: .3, rotation: 0 }
    second.transform = { x: .5, y: .4, width: .25, height: .2, rotation: 0 }
    expect(boundsForElements([first, second], { x: 100, y: 50, width: 400, height: 600 })).toEqual({ x: 140, y: 170, width: 260, height: 240 })
  })

  it('projects the approved direct-edit anchors without pretending shapes are Bezier paths', () => {
    expect(shapeEditAnchors('rectangle')).toEqual(['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'])
    expect(shapeEditAnchors('ellipse')).toEqual(['top-center', 'middle-left', 'middle-right', 'bottom-center'])
    expect(shapeEditAnchors('line')).toEqual(['middle-left', 'middle-right'])
  })

  it('maps the rectangle radius handle and keeps the adjacent toolbar inside the stage', () => {
    expect(cornerRadiusFromLocalPoint({ x: 170, y: 30 }, { width: 200, height: 100 })).toBe(.3)
    expect(cornerRadiusFromLocalPoint({ x: 40, y: 80 }, { width: 100, height: 100 })).toBe(.5)
    expect(shapeEditToolbarPosition(
      { x: 440, y: 18, width: 160, height: 120 },
      { width: 520, height: 320 },
      { width: 304, height: 44 }
    )).toEqual({ left: 204, top: 150, placement: 'below' })
  })

  it('creates all new canvas elements with an explicit normal blend mode', () => {
    const scene = createBlankScene()
    for (const tool of ['text', 'sketch', 'shape', 'light', 'placeholder'] as const) {
      expect(createElementForTool(tool, scene)?.blendMode).toBe('normal')
    }
  })

  it('starts new text visibly on light, dark and transparent canvases without changing saved text', () => {
    const scene = createBlankScene()
    scene.canvas.backgroundColor = '#FAF9F6'
    const light = createElementForTool('text', scene)!
    expect(light).toMatchObject({ type: 'text', fill: '#172033' })
    scene.elements.push(light)
    scene.canvas.backgroundColor = '#172033'
    expect(createElementForTool('text', scene)).toMatchObject({ fill: '#F4F4F2' })
    expect(scene.elements[0]).toEqual(light)
    scene.canvas.transparent = true
    expect(createElementForTool('text', scene)).toMatchObject({ fill: '#172033' })
  })

  it('round-trips direct line endpoints through the existing transform contract', () => {
    const artboard = { x: 0, y: 0, width: 1_000, height: 1_000 }
    const transform = lineTransformFromStageEndpoints({ x: 100, y: 200 }, { x: 500, y: 500 }, .1, artboard)
    expect(transform).toMatchObject({ x: .13, y: .16, width: .5, height: .1 })
    expect(transform.rotation).toBeCloseTo(36.8699, 3)
    const endpoints = lineEndpointsForTransform(transform, artboard)
    expect(endpoints.start.x).toBeCloseTo(100, 5)
    expect(endpoints.start.y).toBeCloseTo(200, 5)
    expect(endpoints.end.x).toBeCloseTo(500, 5)
    expect(endpoints.end.y).toBeCloseTo(500, 5)
  })
})
