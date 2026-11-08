import { afterEach, describe, expect, it } from 'vitest'
import type { Quad, Scene, SceneElement } from '../../src/domain'
import { transformSelection, useFreeTransform } from '../../src/renderer/src/canvas/free-transform-store'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore, type WorkspaceSceneClient } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

/*
 * A free transform, or a flip from the menu, applied while an earlier change
 * is still on its way to Main: worked out when its own turn comes, so it
 * never puts back what that change did.
 */

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

function layer(id: string): SceneElement {
  return useWorkspaceStore.getState().scene.elements.find((element) => element.id === id)!
}

/** Moves a layer a tenth of the canvas to the right, without waiting for it to land. */
function moveRight(id: string): Promise<boolean> {
  const transform = layer(id).transform
  return useWorkspaceStore.getState().execute('移动', [{ kind: 'element.update', elementId: id, changes: { transform: { ...transform, x: transform.x + 0.1 } } }])
}

describe('free transform behind a change on its way', () => {
  afterEach(() => {
    useFreeTransform.getState().cancel()
    setWorkspaceSceneClientForTests(null)
  })

  it('does not apply a box drawn on the canvas before the change landed', async () => {
    const scene = createNightVeilScene()
    const held = heldClient(scene)
    setWorkspaceSceneClientForTests(held.client)
    resetWorkspace(scene)
    useWorkspaceStore.getState().setSelection([NIGHT_VEIL_IDS.title])
    const before = layer(NIGHT_VEIL_IDS.title).transform
    const moving = moveRight(NIGHT_VEIL_IDS.title)
    expect(useFreeTransform.getState().start()).toBe(true)
    const source = useFreeTransform.getState().session!.source
    expect(useFreeTransform.getState().setTarget(source.map(([x, y]) => [x, y + 40]) as unknown as Quad)).toBe(true)
    const applying = useFreeTransform.getState().apply()
    held.release()
    expect(await moving).toBe(true)
    expect(await applying).toBe(false)
    // The move stands; the transform worked out before it was not laid over it.
    expect(layer(NIGHT_VEIL_IDS.title).transform).toEqual({ ...before, x: before.x + 0.1 })
  })

  it('flips the layer where the change left it', async () => {
    const scene = createNightVeilScene()
    const held = heldClient(scene)
    setWorkspaceSceneClientForTests(held.client)
    resetWorkspace(scene)
    useWorkspaceStore.getState().setSelection([NIGHT_VEIL_IDS.title])
    const before = layer(NIGHT_VEIL_IDS.title).transform
    const moving = moveRight(NIGHT_VEIL_IDS.title)
    const flipping = transformSelection('flip-horizontal')
    held.release()
    expect(await moving).toBe(true)
    expect(await flipping).toBe(true)
    const flipped = layer(NIGHT_VEIL_IDS.title)
    expect(flipped.transform.x).toBeCloseTo(before.x + 0.1, 6)
    expect(flipped.type === 'text' ? flipped.corners : null).toEqual([[1, 0], [0, 0], [0, 1], [1, 1]])
  })
})
