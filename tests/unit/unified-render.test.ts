import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../src/domain'
import { unifiedPlacementCommands, unifiedRenderCover, unifiedRenderJob } from '../../src/main/edit/unified-render'

const NOW = '2026-10-23T00:00:00.000Z'
const BASE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, blendMode: 'normal' as const, visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include' as const, transform: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, rotation: 0 }
}
const id = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const shape = (n: number, zIndex: number, changes: Partial<SceneElement> = {}): SceneElement =>
  ({ ...BASE, id: id(n), type: 'shape', name: `形状${n}`, zIndex, shape: 'rectangle', fill: '#336699', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final', ...changes }) as SceneElement
const text = (n: number, zIndex: number): SceneElement => ({
  ...BASE, id: id(n), type: 'text', name: `文字${n}`, zIndex, content: '标题', orientation: 'horizontal', align: 'center', wrapping: 'word',
  fontFamily: 'Georgia', fontSize: 40, fontWeight: 400, fill: '#111111', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0,
  letterSpacing: 0, lineHeight: 1.2, accuracy: 'strict', visualWeight: 'primary', styleDescription: '', renderStrategy: 'standard', resultAssetId: null
}) as SceneElement
const placeholder = (n: number, zIndex: number): SceneElement => ({
  ...BASE, id: id(n), type: 'placeholder', name: '占位', zIndex, subject: '花', pose: '', facing: '', allowOverflow: false,
  transparentBackground: true, frameShape: 'rectangle', generationNotes: ''
}) as SceneElement

function scene(elements: SceneElement[]): Scene {
  return { ...createScene({ id: id(1), projectId: id(2), now: NOW }), elements }
}

describe('unified render', () => {
  it('redraws the exported layers except text and intent layers', () => {
    const elements = [shape(10, 0), text(11, 1), placeholder(12, 2), shape(13, 3, { visible: false }), shape(14, 4, { role: 'placeholder' }), shape(15, 5)]
    expect(unifiedRenderCover(scene(elements))).toEqual([id(10), id(15)])
    expect(unifiedRenderJob({ mode: 'unified-render', coveredElementIds: [id(10)] })).toEqual({ coveredElementIds: [id(10)] })
    expect(unifiedRenderJob({ mode: 'canvas' })).toBeNull()
  })

  it('lays the render right above what it covers and keeps every text on top in its order', () => {
    // Background, a title, a decoration above the title, a placeholder and a caption at the top.
    const before = scene([shape(10, 0), text(11, 1), shape(12, 2), placeholder(13, 3), text(14, 4)])
    const rendered = { ...shape(20, 0), type: 'image', name: '统一渲染 1', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      assetId: id(30), crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover', referenceRole: 'general' } as unknown as SceneElement
    const commands = unifiedPlacementCommands(before, rendered, [id(10), id(12)])
    const result = new CommandBus(before, { now: () => NOW }).execute({ id: id(40), origin: 'user', summary: '放入统一渲染', commands })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.scene.elements.map((element) => element.name)).toEqual(['形状10', '形状12', '统一渲染 1', '占位', '文字11', '文字14'])
    // The covered layers stay as they were.
    expect(result.scene.elements.filter((element) => element.type === 'shape').every((element) => element.visible)).toBe(true)
  })
})
