import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHundredElementScene } from '../../src/renderer/src/fixtures/hundred-elements'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

describe('workspace CommandBus projection', () => {
  beforeEach(() => {
    const scene = createNightVeilScene()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(scene))
    resetWorkspace(scene)
  })
  afterEach(() => {
    setWorkspaceSceneClientForTests(null)
    resetWorkspace()
  })

  it('groups and ungroups through one reversible command boundary', async () => {
    const store = useWorkspaceStore.getState()
    store.setSelection([NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title])
    expect(await useWorkspaceStore.getState().groupSelection()).toBe(true)

    const grouped = useWorkspaceStore.getState()
    const group = grouped.scene.elements.find((element) => element.type === 'group')
    expect(group?.type).toBe('group')
    expect(group?.childIds).toEqual([NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title])
    expect(grouped.canUndo).toBe(true)

    await grouped.undo()
    expect(useWorkspaceStore.getState().scene.elements).toEqual(createNightVeilScene().elements)
  })

  it('enters a Group, edits one child atomically and recomputes the Group bounds', async () => {
    const store = useWorkspaceStore.getState()
    store.setSelection([NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title])
    expect(await useWorkspaceStore.getState().groupSelection()).toBe(true)
    const grouped = useWorkspaceStore.getState()
    const group = grouped.scene.elements.find((element) => element.type === 'group')
    if (group?.type !== 'group') throw new Error('Expected a Group.')

    grouped.enterGroupEditing(group.id)
    expect(useWorkspaceStore.getState().editingGroupId).toBe(group.id)
    useWorkspaceStore.getState().select(NIGHT_VEIL_IDS.bottle)
    const before = useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.bottle)!
    const nextTransform = { ...before.transform, x: before.transform.x + 0.08, width: before.transform.width * 0.82 }
    expect(await useWorkspaceStore.getState().updateElement(before.id, { transform: nextTransform }, '组内移动主体')).toBe(true)

    const after = useWorkspaceStore.getState()
    const updatedGroup = after.scene.elements.find((element) => element.id === group.id)
    const children = after.scene.elements.filter((element) => group.childIds.includes(element.id))
    expect(updatedGroup?.transform).toMatchObject({
      x: Math.min(...children.map((element) => element.transform.x)),
      y: Math.min(...children.map((element) => element.transform.y)),
      width: Math.max(...children.map((element) => element.transform.x + element.transform.width)) - Math.min(...children.map((element) => element.transform.x)),
      height: Math.max(...children.map((element) => element.transform.y + element.transform.height)) - Math.min(...children.map((element) => element.transform.y))
    })
    expect(after.canUndo).toBe(true)

    after.exitGroupEditing()
    expect(useWorkspaceStore.getState().editingGroupId).toBeNull()
    expect(useWorkspaceStore.getState().selectedIds).toEqual([group.id])
  })

  it('aligns and distributes selected elements atomically', async () => {
    const hundred = createHundredElementScene()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(hundred))
    resetWorkspace(hundred)
    const original = useWorkspaceStore.getState().scene
    const selected = original.elements.slice(0, 4).map((element) => element.id)
    useWorkspaceStore.getState().setSelection(selected)

    expect(await useWorkspaceStore.getState().alignSelection('left')).toBe(true)
    const aligned = useWorkspaceStore.getState().scene.elements.filter((element) => selected.includes(element.id))
    expect(new Set(aligned.map((element) => element.transform.x)).size).toBe(1)

    await useWorkspaceStore.getState().undo()
    expect(useWorkspaceStore.getState().scene.elements).toEqual(original.elements)

    expect(await useWorkspaceStore.getState().distributeSelection('horizontal')).toBe(true)
    const distributed = useWorkspaceStore.getState().scene.elements.filter((element) => selected.includes(element.id))
    const centers = distributed.map((element) => element.transform.x + element.transform.width / 2)
    const gaps = centers.slice(1).map((center, index) => Number((center - (centers[index] ?? 0)).toFixed(6)))
    expect(new Set(gaps).size).toBe(1)
  })

  it('copies and pastes a structured selection with remapped identities through one command batch', async () => {
    const originalCount = useWorkspaceStore.getState().scene.elements.length
    useWorkspaceStore.getState().setSelection([NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title])
    expect(useWorkspaceStore.getState().copySelection()).toBe(true)
    expect(await useWorkspaceStore.getState().pasteSelection()).toBe(true)

    const pasted = useWorkspaceStore.getState()
    expect(pasted.scene.elements).toHaveLength(originalCount + 2)
    expect(pasted.selectedIds).toHaveLength(2)
    expect(pasted.selectedIds).not.toContain(NIGHT_VEIL_IDS.bottle)
    expect(pasted.selectedIds).not.toContain(NIGHT_VEIL_IDS.title)
    expect(pasted.scene.elements.filter((element) => pasted.selectedIds.includes(element.id)).map((element) => element.name)).toEqual([
      '香水瓶 副本',
      '主标题 副本'
    ])

    await pasted.undo()
    expect(useWorkspaceStore.getState().scene.elements).toHaveLength(originalCount)
  })
})
