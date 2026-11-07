import { describe, expect, it } from 'vitest'
import { clipBases, clipStacks, sceneSchema, type SceneElement } from '../../src/domain'
import { compositeOver } from '../../src/shared/blend-mode'
import { makeAllElementTypesScene } from '../fixtures/scene-fixtures'

/** Just what the stacks read: id, type, order, group, clipping and a shape's role. */
function layer(id: string, type: SceneElement['type'], extra: Record<string, unknown> = {}): SceneElement {
  return { id, type, groupId: null, clipped: false, ...(type === 'shape' ? { role: 'final' } : {}), ...extra } as unknown as SceneElement
}

function ordered(...elements: SceneElement[]): SceneElement[] {
  return elements.map((element, zIndex) => ({ ...element, zIndex }) as SceneElement)
}

describe('clipping masks', () => {
  it('clips each clipped layer to the nearest unclipped layer below it, in order', () => {
    const elements = ordered(
      layer('base', 'image'),
      layer('a', 'text', { clipped: true }),
      layer('b', 'adjustment', { clipped: true }),
      layer('c', 'shape', { clipped: true }),
      layer('next', 'image'),
      layer('d', 'image', { clipped: true })
    )
    const stacks = clipStacks(elements)
    expect([...stacks.values()]).toEqual([{ baseId: 'base', memberIds: ['a', 'b', 'c'] }, { baseId: 'next', memberIds: ['d'] }])
    expect(clipBases(elements).get('b')).toBe('base')
    // Order in the scene is by zIndex, not by position in the array.
    expect([...clipStacks([...elements].reverse()).keys()]).toEqual(['base', 'next'])
  })

  it('leaves a clipped layer with nothing to clip to drawn as it is', () => {
    const elements = ordered(
      layer('first', 'image', { clipped: true }),
      layer('adjust', 'adjustment'),
      layer('afterAdjust', 'image', { clipped: true }),
      layer('placeholder', 'shape', { role: 'placeholder' }),
      layer('afterPlaceholder', 'text', { clipped: true }),
      layer('alone', 'image')
    )
    expect(clipStacks(elements).size).toBe(0)
    expect(clipBases(elements).size).toBe(0)
  })

  it('keeps a stack inside one group', () => {
    const elements = ordered(
      layer('base', 'image', { groupId: 'g' }),
      layer('inside', 'text', { clipped: true, groupId: 'g' }),
      layer('outside', 'text', { clipped: true }),
      layer('group', 'group'),
      layer('afterGroup', 'image', { clipped: true })
    )
    expect([...clipStacks(elements).values()]).toEqual([{ baseId: 'base', memberIds: ['inside'] }])
  })

  it('takes clipping on layers with pixels and adjustment layers only', () => {
    const scene = makeAllElementTypesScene()
    for (const element of scene.elements) {
      const clipped = { ...scene, elements: scene.elements.map((candidate) => candidate.id === element.id ? { ...candidate, clipped: true } : candidate) }
      const allowed = ['image', 'text', 'shape', 'adjustment'].includes(element.type)
      expect(sceneSchema.safeParse(clipped).success, element.type).toBe(allowed)
    }
  })

  it('lays a picture over another as source-over with blending', () => {
    // Opaque over opaque: the blend itself.
    const below = new Uint8ClampedArray([200, 80, 40, 255, 200, 80, 40, 255, 200, 80, 40, 0, 10, 20, 30, 255])
    const above = new Uint8ClampedArray([60, 150, 220, 255, 60, 150, 220, 128, 60, 150, 220, 255, 0, 0, 0, 0])
    compositeOver(below, above, 'multiply')
    expect([...below.slice(0, 4)]).toEqual([47, 47, 35, 255])
    // Half over opaque: about halfway between the backdrop and the blend.
    const half = (backdrop: number, blended: number): number => Math.round(backdrop + (blended - backdrop) * 128 / 255)
    expect([...below.slice(4, 8)]).toEqual([half(200, 47), half(80, 47), half(40, 35), 255])
    // Over nothing: the source as it is, the mode has nothing to blend with.
    expect([...below.slice(8, 12)]).toEqual([60, 150, 220, 255])
    // Nothing over: unchanged.
    expect([...below.slice(12, 16)]).toEqual([10, 20, 30, 255])
    // Half over half: alpha 0.75, the colour weighted by what each brings.
    const halfBelow = new Uint8ClampedArray([255, 0, 0, 128])
    compositeOver(halfBelow, new Uint8ClampedArray([0, 0, 255, 128]), 'normal')
    expect(halfBelow[3]).toBe(Math.round((0.502 + 0.502 * 0.498) * 255))
    expect(halfBelow[2]!).toBeGreaterThan(halfBelow[0]!)
  })
})
