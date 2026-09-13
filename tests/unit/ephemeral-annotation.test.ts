import { describe, expect, it } from 'vitest'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { buildEphemeralAnnotationSaveCommands } from '../../src/renderer/src/agent/ephemeral-annotation'
import type { EphemeralAnnotation } from '../../src/shared/agent'
import type { SceneElement } from '../../src/domain'

const ids = Array.from({ length: 20 }, (_, index) => `22000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)

function annotation(targetElementId: string | null): EphemeralAnnotation {
  const regions = [
    { id: ids[1]!, mode: 'generate' as const, points: [{ x: .1, y: .1 }, { x: .5, y: .1 }, { x: .4, y: .5 }], closed: true, width: .015 },
    { id: ids[2]!, mode: 'protect' as const, points: [{ x: .3, y: .3 }, { x: .7, y: .3 }, { x: .6, y: .7 }], closed: true, width: .02 }
  ]
  return { ...regions[0]!, id: ids[0]!, targetElementId, regions }
}

describe('ephemeral annotation explicit save boundary', () => {
  it('saves all semantic regions as one command list without mutating the source scene', () => {
    const fixture = createNightVeilScene()
    const placeholder = fixture.elements.find((element) => element.type === 'placeholder')
    if (placeholder === undefined) throw new Error('Fixture is incomplete.')
    const image: SceneElement = {
      ...placeholder,
      id: ids[3]!, type: 'image', assetId: ids[4]!, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover', referenceRole: 'general'
    }
    const scene = { ...fixture, elements: [image], relations: [] }
    let cursor = 5
    const saved = buildEphemeralAnnotationSaveCommands(scene, annotation(image.id), 'mask', () => ids[cursor++]!)

    expect(saved.commands).toHaveLength(2)
    expect(saved.commands.map((command) => command.kind === 'element.add' && command.element.type === 'mask' ? command.element.mode : null)).toEqual(['generate', 'protect'])
    expect(saved.commands.every((command) => command.kind === 'element.add' && command.element.referencePolicy === 'exclude')).toBe(true)
    expect(scene.elements).toEqual([image])
  })

  it('saves the whole turn as one non-final reference sketch', () => {
    const saved = buildEphemeralAnnotationSaveCommands(createNightVeilScene(), annotation(null), 'sketch', () => ids[10]!)
    expect(saved.commands).toHaveLength(1)
    expect(saved.commands[0]).toMatchObject({ kind: 'element.add', element: { type: 'sketch', finalVisible: false, referencePolicy: 'include' } })
  })

  it('refuses a formal mask when no image target exists', () => {
    expect(buildEphemeralAnnotationSaveCommands(createNightVeilScene(), annotation(null), 'mask')).toEqual({ commands: [], elementIds: [] })
  })
})
