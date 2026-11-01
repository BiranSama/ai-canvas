import { describe, expect, it } from 'vitest'
import { preferredPlacementTarget } from '../../src/renderer/src/canvas/placement-target'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

describe('where a result from 出图 would like to go', () => {
  const scene = makeAllElementTypesScene()
  const subject = { ...scene.elements.find((element) => element.id === IDS.placeholder)!, semanticRole: 'subject' as const }
  const withSubject = { ...scene, elements: scene.elements.map((element) => element.id === IDS.placeholder ? subject : element) }

  it('takes the one placeholder or image selected', () => {
    expect(preferredPlacementTarget(scene, [IDS.image])).toBe(IDS.image)
    expect(preferredPlacementTarget(scene, [IDS.placeholder])).toBe(IDS.placeholder)
  })

  it('falls back to the only subject placeholder, and to the middle without one', () => {
    expect(preferredPlacementTarget(withSubject, [])).toBe(IDS.placeholder)
    expect(preferredPlacementTarget(withSubject, [IDS.text])).toBe(IDS.placeholder)
    expect(preferredPlacementTarget(scene, [])).toBeUndefined()
    expect(preferredPlacementTarget(withSubject, [IDS.image, IDS.text])).toBe(IDS.placeholder)
    const twoSubjects = { ...withSubject, elements: [...withSubject.elements, { ...subject, id: '00000000-0000-4000-8000-0000000000ff' }] }
    expect(preferredPlacementTarget(twoSubjects, [])).toBeUndefined()
  })
})
