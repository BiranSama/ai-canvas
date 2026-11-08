import { describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene, type SceneElement } from '../../src/domain'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'
import { countLayers, layerArea, psdPlan, type LayerPlan } from '../../src/renderer/src/export/psd-plan'

const coffee = createMerchantExampleScene('coffee-poster')

function named(scene: Scene, name: string): SceneElement {
  return scene.elements.find((element) => element.name === name)!
}

/** The scene with a group of these layers, placed where the group command puts one: at its lowest member. */
function grouped(scene: Scene, name: string, members: readonly string[]): Scene {
  const ids = members.map((member) => named(scene, member).id)
  const groupId = '0f0f0f0f-0000-4000-8000-0000000000aa'
  const lowest = Math.min(...ids.map((id) => scene.elements.findIndex((element) => element.id === id)))
  const group: SceneElement = {
    id: groupId, version: ELEMENT_SCHEMA_VERSION, type: 'group', name, description: '', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    zIndex: 0, opacity: 1, visible: true, locked: false, groupId: null, semanticRole: 'composition', referencePolicy: 'include', childIds: ids
  }
  const elements = scene.elements.map((element) => ids.includes(element.id) ? { ...element, groupId } : element)
  elements.splice(lowest, 0, group)
  return sceneSchema.parse({ ...scene, elements: elements.map((element, zIndex) => ({ ...element, zIndex })) })
}

function names(plans: readonly LayerPlan[]): unknown[] {
  return plans.map((plan) => plan.kind === 'layer' ? plan.element.name : { [plan.element.name]: names(plan.children) })
}

describe('what a PSD gets', () => {
  it('keeps a group whose layers sit together, bottom first, without placeholders', () => {
    const plan = psdPlan(grouped(coffee, '标题组', ['标题', '副标题']))
    expect(plan.flattened).toEqual([])
    expect(names(plan.layers)).toEqual(['奶油色背景', '底部色块', { 标题组: ['标题', '副标题'] }, '价格圆标', '价格', '店名'])
    expect(countLayers(plan.layers)).toBe(7)
  })

  it('lays a group out flat when another layer sits between its layers, so the stack does not change', () => {
    // 副标题 lies between 标题 and 价格圆标.
    const plan = psdPlan(grouped(coffee, '交错的组', ['标题', '价格圆标']))
    expect(plan.flattened).toEqual(['交错的组'])
    expect(names(plan.layers)).toEqual(['奶油色背景', '底部色块', '标题', '副标题', '价格圆标', '价格', '店名'])
  })
})

describe('hidden groups laid out flat', () => {
  it('keep their layers hidden in the PSD, while a kept group hides its own', () => {
    const interleaved = grouped(coffee, '交错的组', ['标题', '价格圆标'])
    const hiddenGroup = sceneSchema.parse({ ...interleaved, elements: interleaved.elements.map((element) => element.name === '交错的组' ? { ...element, visible: false } : element) })
    const flat = psdPlan(hiddenGroup).layers
    const hidden = Object.fromEntries(flat.map((plan) => [plan.element.name, plan.hidden]))
    expect(hidden).toMatchObject({ 标题: true, 价格圆标: true, 副标题: false, 价格: false })

    const together = grouped(coffee, '标题组', ['标题', '副标题'])
    const hiddenTogether = sceneSchema.parse({ ...together, elements: together.elements.map((element) => element.name === '标题组' ? { ...element, visible: false } : element) })
    const group = psdPlan(hiddenTogether).layers.find((plan) => plan.kind === 'group')!
    expect(group.hidden).toBe(true)
    expect(group.kind === 'group' && group.children.map((child) => child.hidden)).toEqual([false, false])
  })
})

describe('where a PSD layer is drawn', () => {
  const box = (element: SceneElement, transform: SceneElement['transform']): SceneElement => ({ ...element, transform })

  it('reaches past the canvas for a layer partly outside it', () => {
    const bar = named(coffee, '底部色块')
    const area = layerArea(box(bar, { x: -0.1, y: 0.9, width: 1.2, height: 0.3, rotation: 0 }), 1000, 1000)
    expect(area.x).toBeLessThan(-100 + 1)
    expect(area.y + area.height).toBeGreaterThan(1200 - 1)
    expect(area.width).toBeGreaterThanOrEqual(1200)
  })

  it('covers a turned box and the text stroke and shadow around it', () => {
    const title = named(coffee, '标题')
    if (title.type !== 'text') throw new Error('the title is text')
    const turned = layerArea({ ...title, transform: { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 90 }, strokeWidth: 4, shadowBlur: 10 }, 1000, 1000)
    // Turned a quarter about its top-left corner, the box hangs to the left of it.
    expect(turned.x).toBeLessThanOrEqual(500 - 100 - 24)
    expect(turned.y + turned.height).toBeGreaterThanOrEqual(500 + 200 + 24)
  })

  it('takes a shape\'s stroke through its corners, as a skew stretches it with the box', () => {
    const base = named(coffee, '底部色块')
    // A 100-pixel square with a 10-pixel stroke, its bottom pushed four boxes to the right.
    const skewed = {
      ...base, type: 'shape', shape: 'rectangle', stroke: '#000000', strokeWidth: 0.1, cornerRadius: 0,
      transform: { x: 0.1, y: 0.1, width: 0.1, height: 0.1, rotation: 0 }, corners: [[0, 0], [1, 0], [5, 1], [4, 1]]
    } as unknown as SceneElement
    const area = layerArea(skewed, 1000, 1000)
    // The stroke's top-left corner lands at -10 - 4 × 10 = -50 from the box, its bottom-right at 110 + 4 × 110 = 550.
    expect(area.x).toBeLessThanOrEqual(100 - 50)
    expect(area.x + area.width).toBeGreaterThanOrEqual(100 + 550)
    expect(area.y).toBeLessThanOrEqual(100 - 10)
    expect(area.y + area.height).toBeGreaterThanOrEqual(100 + 110)
  })

  it('leaves room for a sketch stroke drawn to its box edges', () => {
    const base = named(coffee, '底部色块')
    const sketch = {
      ...base, type: 'sketch' as const, transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 }, fidelity: 1, finalVisible: true,
      strokes: [{ id: '0f0f0f0f-0000-4000-8000-0000000000cc', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#000000', width: 0.04, opacity: 1 }]
    } as unknown as SceneElement
    const area = layerArea(sketch, 1000, 1000)
    // The stroke is 20 pixels wide in a 500-pixel box; half of it, and its round cap, lie past the corner.
    expect(area.x).toBeLessThanOrEqual(250 - 10)
    expect(area.x + area.width).toBeGreaterThanOrEqual(750 + 10)
  })

  it('cuts an area too large for one picture to the canvas', () => {
    const bar = named(coffee, '底部色块')
    expect(layerArea(box(bar, { x: -10, y: 0, width: 30, height: 1, rotation: 0 }), 1000, 1000)).toMatchObject({ x: 0, width: 1000 })
  })
})
