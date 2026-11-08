import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scene } from '../../src/domain'
import { editGuides } from '../../src/renderer/src/canvas/view-store'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { submitGenerativeFill } from '../../src/renderer/src/selection/generative-fill'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore, type WorkspaceSceneClient } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

/*
 * Guides changed in quick succession, and a generative fill whose canvas
 * changes while it is being sent: each works from the canvas it belongs to.
 */

vi.mock('../../src/renderer/src/generation/preferred-provider', () => ({
  preferredImageProvider: vi.fn(async () => ({ providerId: 'mock', model: 'mock-balanced', profileId: null, confirmed: true, note: null }))
}))

/** A scene client whose first batch waits until it is let go. */
function heldClient(scene: Scene): { readonly client: WorkspaceSceneClient; release(): void } {
  const local = createLocalWorkspaceSceneClient(scene)
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  return {
    client: {
      ...local,
      execute: async (input) => {
        if (first) {
          first = false
          await gate
        }
        return local.execute(input)
      }
    },
    release: () => release()
  }
}

afterEach(() => {
  setWorkspaceSceneClientForTests(null)
  vi.restoreAllMocks()
})

describe('guides changed in quick succession', () => {
  it('keeps both of two guides added before the first has landed', async () => {
    const scene = createNightVeilScene()
    const held = heldClient(scene)
    setWorkspaceSceneClientForTests(held.client)
    resetWorkspace(scene)
    const first = editGuides('新建参考线', (current) => [...current, { axis: 'x', position: 100 }])
    const second = editGuides('新建参考线', (current) => [...current, { axis: 'y', position: 200 }])
    held.release()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(useWorkspaceStore.getState().scene.canvas.guides).toEqual([{ axis: 'x', position: 100 }, { axis: 'y', position: 200 }])
  })

  it('keeps a canvas size changed ahead of it', async () => {
    const scene = createNightVeilScene()
    const held = heldClient(scene)
    setWorkspaceSceneClientForTests(held.client)
    resetWorkspace(scene)
    const canvas = useWorkspaceStore.getState().scene.canvas
    const resizing = useWorkspaceStore.getState().execute('画布大小', [{ kind: 'scene.set-canvas', canvas: { ...canvas, outputWidth: canvas.outputWidth + 200 } }])
    const adding = editGuides('新建参考线', (current) => [...current, { axis: 'x', position: 100 }])
    held.release()
    expect(await resizing).toBe(true)
    expect(await adding).toBe(true)
    const after = useWorkspaceStore.getState().scene.canvas
    expect(after.outputWidth).toBe(canvas.outputWidth + 200)
    expect(after.guides).toEqual([{ axis: 'x', position: 100 }])
  })
})

describe('generative fill while the canvas changes', () => {
  it('sends the scene the mask was drawn on, not one changed meanwhile', async () => {
    const scene = createNightVeilScene()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(scene))
    resetWorkspace(scene)
    const drawnOn = useWorkspaceStore.getState().scene.revision
    const sent: { revision: number | null } = { revision: null }
    const desktop = {
      // The canvas changes while the mask is being stored.
      importPixels: vi.fn(async () => {
        const title = useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!
        await useWorkspaceStore.getState().execute('移动', [{ kind: 'element.update', elementId: title.id, changes: { transform: { ...title.transform, x: title.transform.x + 0.1 } } }])
        return { id: '10000000-0000-4000-8000-000000000099', width: 4, height: 4, format: 'png', hasAlpha: false }
      }),
      editFromCanvas: vi.fn(async (input: { readonly scene: Scene }) => {
        sent.revision = input.scene.revision
        return { jobId: 'job' }
      })
    }
    Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
    expect(await submitGenerativeFill({ width: 4, height: 4, data: new Uint8Array(16).fill(255) }, '')).toBe(true)
    expect(useWorkspaceStore.getState().scene.revision).toBeGreaterThan(drawnOn)
    // Main compares this with the canvas it has and turns the request down when they differ.
    expect(sent.revision).toBe(drawnOn)
  })
})
