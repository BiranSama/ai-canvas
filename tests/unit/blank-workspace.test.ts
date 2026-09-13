import { afterEach, describe, expect, it } from 'vitest'
import { createBlankScene } from '../../src/renderer/src/scene/create-blank-scene'
import { createVisualExampleScene, VISUAL_EXAMPLE_KEYS } from '../../src/renderer/src/fixtures/visual-examples'
import { resetWorkspace, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'

describe('blank runtime workspace', () => {
  afterEach(() => resetWorkspace())

  it('starts without product-specific demo content', () => {
    const scene = createBlankScene({
      sceneId: '71000000-0000-4000-8000-000000000001',
      projectId: '71000000-0000-4000-8000-000000000002',
      now: '2026-08-11T00:00:00.000Z'
    })

    resetWorkspace(scene)

    const current = useWorkspaceStore.getState().scene
    expect(current.elements).toEqual([])
    expect(current.canvas.globalStyle).toBe('')
    expect(JSON.stringify(current)).not.toMatch(/night veil|香水|瓶盖/i)
  })
})

describe('visual example scenes', () => {
  it('remain explicit, deterministic and distinct from the blank runtime scene', () => {
    for (const key of VISUAL_EXAMPLE_KEYS) {
      const scene = createVisualExampleScene(key, {
        projectId: '30000000-0000-4000-8000-000000000001',
        sceneId: '30000000-0000-4000-8000-000000000002',
        now: '2026-08-11T00:00:00.000Z'
      })
      expect(scene.elements.length).toBeGreaterThanOrEqual(4)
      expect(scene.canvas.globalStyle).not.toBe('')
      expect(JSON.stringify(scene)).not.toMatch(/NIGHT VEIL|香水|瓶盖/)
    }
  })
})
