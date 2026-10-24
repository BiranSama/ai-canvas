import sharp from 'sharp'
import { expect, it } from 'vitest'
import { createScene, ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../src/domain'
import { CompositeReferenceRenderer, svgPaint } from '../../src/main/reference/composite-reference-renderer'

function shape(id: string, zIndex: number, changes: Partial<Extract<SceneElement, { type: 'shape' }>>): SceneElement {
  return {
    id, version: ELEMENT_SCHEMA_VERSION, type: 'shape', name: '形状', description: '', zIndex, opacity: 1, blendMode: 'normal', visible: true, locked: false,
    groupId: null, semanticRole: 'content', referencePolicy: 'include', transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 },
    shape: 'path', fill: '#D02020', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final', ...changes
  } as SceneElement
}

function scene(elements: SceneElement[]): Scene {
  const base = createScene({ id: '70000000-0000-4000-8000-000000000001', projectId: '70000000-0000-4000-8000-000000000002', now: '2026-10-23T00:00:00.000Z' })
  return { ...base, canvas: { ...base.canvas, outputWidth: 400, outputHeight: 400, transparent: false, backgroundColor: '#FFFFFF' }, elements }
}

it('draws a free-form outline in its box, filling closed outlines only', async () => {
  const renderer = new CompositeReferenceRenderer(async () => null)
  // A triangle pointing down across the box [100, 100]–[300, 300], and an open wave below it.
  const rendered = await renderer.render(scene([
    shape('70000000-0000-4000-8000-000000000010', 0, { path: 'M0 0L100 0L50 100Z' }),
    shape('70000000-0000-4000-8000-000000000011', 1, { transform: { x: 0, y: 0.8, width: 1, height: 0.1, rotation: 0 }, path: 'M0 50Q25 0 50 50T100 50', fill: '#00000000', stroke: '#2040A0', strokeWidth: 0.2 })
  ]), 'final')
  const { data, info } = await sharp(rendered.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
  expect(at(200, 150)).toEqual([0xD0, 0x20, 0x20])
  // Inside the box but outside the triangle.
  expect(at(110, 280)).toEqual([255, 255, 255])
  // The wave is stroked, not filled: its line is blue and the space it would enclose stays white.
  expect(at(0, 340)).toEqual([0x20, 0x40, 0xA0])
  expect(at(100, 352)).toEqual([255, 255, 255])

  expect(svgPaint('#00000000')).toBe('none')
  expect(svgPaint('#20409980')).toBe('rgba(32,64,153,0.502)')
  expect(svgPaint('#204099')).toBe('#204099')
})
