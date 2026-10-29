import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHundredElementScene } from '../../src/renderer/src/fixtures/hundred-elements'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { setSelectionMask, useSelectionStore } from '../../src/renderer/src/selection/selection-store'
import { rectMask } from '../../src/shared/mask-raster'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

describe('workspace CommandBus projection', () => {
  beforeEach(() => {
    const scene = createNightVeilScene()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(scene))
    resetWorkspace(scene)
  })
  afterEach(() => {
    setSelectionMask(null)
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

  it('works out a queued batch from the scene left by the changes before it, or sends nothing', async () => {
    const store = useWorkspaceStore.getState()
    const title = () => useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!
    expect(await store.execute('改名', [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题一' } }])).toBe(true)
    // An undo queued first lands before the batch is worked out, as a background bake meeting an undo would.
    const undone = store.undo()
    const seen: string[] = []
    const later = store.execute('跟着改', (scene) => {
      const current = scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!
      seen.push(current.name)
      return current.name === '标题一' ? [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题二' } }] : null
    })
    await undone
    expect(await later).toBe(false)
    expect(seen).toEqual([createNightVeilScene().elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!.name])
    expect(title().name).toBe(seen[0])
  })

  it('keeps a selection change made while a batch is on its way after that batch in the history', async () => {
    const scene = createNightVeilScene()
    const local = createLocalWorkspaceSceneClient(scene)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    setWorkspaceSceneClientForTests({ ...local, execute: async (input) => { await held; return local.execute(input) } })
    resetWorkspace(scene)
    const renamed = useWorkspaceStore.getState().execute('改名', [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题一' } }])
    // The person selects while Main has not answered yet.
    setSelectionMask(rectMask(scene.canvas.outputWidth, scene.canvas.outputHeight, { x: 10, y: 10, width: 50, height: 50 }))
    release()
    expect(await renamed).toBe(true)
    // Ctrl+Z takes back the selection, the later of the two, and leaves the rename.
    await useWorkspaceStore.getState().undo()
    expect(useSelectionStore.getState().mask).toBeNull()
    expect(useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)?.name).toBe('标题一')
    await useWorkspaceStore.getState().undo()
    expect(useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)?.name).not.toBe('标题一')
  })

  it('takes a batch that did not land out of the history again', async () => {
    const scene = createNightVeilScene()
    setWorkspaceSceneClientForTests({ ...createLocalWorkspaceSceneClient(scene), execute: async () => { throw new Error('Main is gone') } })
    resetWorkspace(scene)
    setSelectionMask(rectMask(scene.canvas.outputWidth, scene.canvas.outputHeight, { x: 10, y: 10, width: 50, height: 50 }))
    expect(await useWorkspaceStore.getState().execute('改名', [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题一' } }])).toBe(false)
    expect(useWorkspaceStore.getState().selectionUndo).toBe(true)
    await useWorkspaceStore.getState().undo()
    expect(useSelectionStore.getState().mask).toBeNull()
  })

  it('keeps what can be redone when a batch does not land', async () => {
    const scene = createNightVeilScene()
    setWorkspaceSceneClientForTests({ ...createLocalWorkspaceSceneClient(scene), execute: async () => { throw new Error('Main is gone') } })
    resetWorkspace(scene)
    setSelectionMask(rectMask(scene.canvas.outputWidth, scene.canvas.outputHeight, { x: 10, y: 10, width: 50, height: 50 }))
    await useWorkspaceStore.getState().undo()
    expect(useWorkspaceStore.getState().selectionRedo).toBe(true)
    expect(await useWorkspaceStore.getState().execute('改名', [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题一' } }])).toBe(false)
    expect(useWorkspaceStore.getState().selectionRedo).toBe(true)
    await useWorkspaceStore.getState().redo()
    expect(useSelectionStore.getState().mask).not.toBeNull()
  })

  it('takes back the step an undo was for, though a later batch holds a place above it', async () => {
    const scene = createNightVeilScene()
    const local = createLocalWorkspaceSceneClient(scene)
    setWorkspaceSceneClientForTests({ ...local, undo: async (input) => { await new Promise((resolve) => setTimeout(resolve, 20)); return local.undo(input) } })
    resetWorkspace(scene)
    setSelectionMask(rectMask(scene.canvas.outputWidth, scene.canvas.outputHeight, { x: 10, y: 10, width: 50, height: 50 }))
    expect(await useWorkspaceStore.getState().execute('改名', [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { name: '标题一' } }])).toBe(true)
    // An undo is on its way when a background batch that will send nothing is asked for.
    const undone = useWorkspaceStore.getState().undo()
    const nothing = useWorkspaceStore.getState().execute('合并', () => null)
    await Promise.all([undone, nothing])
    expect(useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)?.name).not.toBe('标题一')
    // What is left is the selection, and the next undo takes it back.
    expect(useWorkspaceStore.getState().selectionUndo).toBe(true)
    await useWorkspaceStore.getState().undo()
    expect(useSelectionStore.getState().mask).toBeNull()
  })

  it('lands two additions queued before either is answered, each on the record the other left', async () => {
    const scene = createNightVeilScene()
    const local = createLocalWorkspaceSceneClient(scene)
    setWorkspaceSceneClientForTests({ ...local, execute: async (input) => { await new Promise((resolve) => setTimeout(resolve, 20)); return local.execute(input) } })
    resetWorkspace(scene)
    const append = (word: string) => useWorkspaceStore.getState().execute(word, (current) => {
      const title = current.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!
      return [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { description: `${title.description}${word}` } }]
    })
    const before = scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)!.description
    expect(await Promise.all([append('一'), append('二')])).toEqual([true, true])
    expect(useWorkspaceStore.getState().scene.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)?.description).toBe(`${before}一二`)
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
