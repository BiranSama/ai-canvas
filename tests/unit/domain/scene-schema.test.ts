import { describe, expect, it } from 'vitest'
import {
  SCENE_SCHEMA_VERSION,
  createScene,
  deserializeSceneSnapshot,
  sceneSchema,
  serializeSceneSnapshot
} from '../../../src/domain'
import { IDS, makeAllElementTypesScene } from '../../fixtures/scene-fixtures'

describe('Scene schema and snapshots', () => {
  it('accepts every MVP element type and stable normalized geometry', () => {
    const parsed = sceneSchema.parse(makeAllElementTypesScene())

    expect(parsed.elements.map((element) => element.type)).toEqual([
      'image',
      'text',
      'sketch',
      'shape',
      'placeholder',
      'light',
      'mask'
    ])
    expect(parsed.elements[0]?.transform).toEqual({ x: 0.32, y: 0.32, width: 0.36, height: 0.54, rotation: 0 })
  })

  it('round-trips a snapshot with no field loss or coordinate drift', () => {
    const scene = makeAllElementTypesScene()
    const restored = deserializeSceneSnapshot(serializeSceneSnapshot(scene))

    expect(restored).toEqual(scene)
    expect(serializeSceneSnapshot(restored)).toBe(serializeSceneSnapshot(scene))
  })

  it('rejects a future scene schema version', () => {
    const scene = createScene({ id: IDS.scene, projectId: IDS.project, now: '2026-08-10T00:00:00.000Z' })
    expect(sceneSchema.safeParse({ ...scene, schemaVersion: 2 }).success).toBe(false)
  })

  it('rejects duplicate element IDs and noncanonical layer indexes', () => {
    const scene = makeAllElementTypesScene()
    expect(sceneSchema.safeParse({ ...scene, elements: [scene.elements[0], scene.elements[0]] }).success).toBe(false)
  })

  it('reads legacy elements without materializing blendMode and keeps the Scene version unchanged', () => {
    const legacy = makeAllElementTypesScene()
    const before = JSON.stringify(legacy)
    const parsed = sceneSchema.parse(legacy)

    expect(SCENE_SCHEMA_VERSION).toBe(1)
    expect(parsed.elements.every((element) => !Object.hasOwn(element, 'blendMode'))).toBe(true)
    expect(parsed).toEqual(legacy)
    expect(before).not.toContain('blendMode')
  })

  it('accepts only the five approved blend modes without changing the Scene version', () => {
    const source = makeAllElementTypesScene()
    for (const blendMode of ['normal', 'multiply', 'screen', 'overlay', 'soft-light'] as const) {
      const parsed = sceneSchema.parse({
        ...source,
        elements: source.elements.map((element, index) => index === 0 ? { ...element, blendMode } : element)
      })
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.elements[0]?.blendMode).toBe(blendMode)
    }
    expect(sceneSchema.safeParse({
      ...source,
      elements: source.elements.map((element, index) => index === 0 ? { ...element, blendMode: 'color-dodge' } : element)
    }).success).toBe(false)
    const placeholderIndex = source.elements.findIndex((element) => element.type === 'placeholder')
    expect(sceneSchema.safeParse({
      ...source,
      elements: source.elements.map((element, index) => index === placeholderIndex ? { ...element, blendMode: 'screen' } : element)
    }).success).toBe(false)
  })
})
