import { describe, expect, it } from 'vitest'
import type { SceneElement } from '../../src/domain'
import { createSemanticSketchRecipe } from '../../src/renderer/src/canvas/semantic-sketch'

function placeholder(visualKind: Extract<SceneElement, { type: 'placeholder' }>['visualKind'], subject = '结构化主体'): Extract<SceneElement, { type: 'placeholder' }> {
  return {
    version: 1,
    id: '9f000000-0000-4000-8000-000000000001',
    type: 'placeholder',
    name: subject,
    description: '用于验证确定性艺术草图投影',
    semanticRole: 'subject',
    groupId: null,
    locked: false,
    visible: true,
    opacity: 1,
    zIndex: 1,
    referencePolicy: 'include',
    transform: { x: .2, y: .2, width: .6, height: .6, rotation: 0 },
    subject,
    pose: '静态构图',
    facing: '正面',
    allowOverflow: false,
    transparentBackground: true,
    frameShape: 'free',
    visualKind,
    generationNotes: '材质、负空间、光向与结构节奏都要可读'
  }
}

describe('semantic sketch projection', () => {
  it.each(['botanical', 'architecture', 'abstract', 'product', 'portrait', 'album', 'coffee', 'landscape'] as const)(
    'builds a layered, editable %s recipe instead of a single fixed stencil',
    (kind) => {
      const recipe = createSemanticSketchRecipe(placeholder(kind))
      expect(recipe).not.toBeNull()
      expect(recipe!.patches.length).toBeGreaterThan(0)
      expect(recipe!.paths.some((item) => item.role === 'primary')).toBe(true)
      expect(recipe!.paths.some((item) => item.role === 'construction')).toBe(true)
      expect(recipe!.paths.some((item) => item.role === 'hatch')).toBe(true)
      expect(recipe!.paths.some((item) => item.role === 'light')).toBe(true)
      expect(recipe!.paths.length + recipe!.ellipses.length + recipe!.rects.length).toBeGreaterThanOrEqual(7)
    }
  )

  it('is deterministic and does not treat every product as a perfume bottle', () => {
    const stillLife = placeholder('product', '陶瓷静物组合')
    const first = createSemanticSketchRecipe(stillLife)
    const second = createSemanticSketchRecipe(structuredClone(stillLife))
    expect(second).toEqual(first)
    expect(first?.rects).toHaveLength(0)

    const bottle = createSemanticSketchRecipe({ ...stillLife, subject: '玻璃香水瓶' })
    expect(bottle?.rects.length).toBeGreaterThan(0)
    expect(bottle).not.toEqual(first)
  })

  it('leaves generic placeholders to the neutral frame renderer', () => {
    expect(createSemanticSketchRecipe(placeholder('generic'))).toBeNull()
  })
})
