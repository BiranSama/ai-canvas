import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankScene } from '../../src/renderer/src/scene/create-blank-scene'
import { defaultProjectWorkContext, projectWorkContextSchema } from '../../src/shared/project-work-context'
import { hydrateWorkspaceScene, resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { useGenerationDraftStore } from '../../src/renderer/src/store/generation-draft-store'
import { useCreationSessionStore } from '../../src/renderer/src/store/creation-session-store'
import { captureProjectWorkContext, flushProjectWorkContext, startProjectContextSync } from '../../src/renderer/src/store/project-context-sync'
import { RuntimeAssetSynchronizer } from '../../src/renderer/src/assets/RuntimeAssetSynchronizer'
import { clearRuntimeAssets, getRuntimeAssetUrl } from '../../src/renderer/src/assets/runtime-assets'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'
import { makeImage } from '../fixtures/scene-fixtures'
import { ImeSafeTextarea } from '../../src/renderer/src/components/ImeSafeTextField'

afterEach(() => { setWorkspaceSceneClientForTests(null); clearRuntimeAssets(); resetWorkspace() })

it('autosaves without blurring a Chinese composition; explicit departure still commits local drafts', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async () => undefined)
  Object.defineProperty(window, 'desktop', { configurable: true, value: { saveProjectWorkContext: save } })
  hydrateWorkspaceScene(createBlankScene(), 'IME')
  const stop = startProjectContextSync()
  const commit = vi.fn((value: string) => useCreationSessionStore.getState().setDraft(value))
  render(<ImeSafeTextarea aria-label="组合输入" value="" onCommit={commit} commitDelayMs={null} />)
  const field = screen.getByRole('textbox', { name: '组合输入' })
  try {
    act(() => field.focus())
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: 'shanhai' } })
    // A viewport change also schedules persistence while a local field is composing.
    useWorkspaceStore.getState().setViewport(1.2, { x: 10, y: 20 })
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(save).toHaveBeenCalled()
    expect(field).toHaveFocus()
    expect(field).toHaveValue('shanhai')
    expect(commit).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '山海' } })
    fireEvent.compositionEnd(field)
    await act(async () => flushProjectWorkContext())
    expect(commit).toHaveBeenCalledExactlyOnceWith('山海')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ conversationDraft: '山海' }))
  } finally { stop(); vi.useRealTimers() }
})

it('reports an invalid oversized draft once, refuses to save it, and recovers after correction', async () => {
  const save = vi.fn(async () => undefined)
  Object.defineProperty(window, 'desktop', { configurable: true, value: { saveProjectWorkContext: save } })
  hydrateWorkspaceScene(createBlankScene(), 'A')
  const stop = startProjectContextSync()
  try {
    expect(() => useGenerationDraftStore.getState().updateDraft({ prompt: '字'.repeat(8001) })).not.toThrow()
    expect(useWorkspaceStore.getState().workContextProblem).toContain('工作状态未保存')
    await expect(flushProjectWorkContext()).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
    useGenerationDraftStore.getState().updateDraft({ prompt: '修正后保留' })
    await flushProjectWorkContext()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ generation: expect.objectContaining({ prompt: '修正后保留' }) }))
  } finally { stop() }
})

it('restores only the owning project context and never restores a one-turn generation grant', () => {
  const a = createBlankScene(), b = createBlankScene()
  hydrateWorkspaceScene(a, 'A')
  useGenerationDraftStore.getState().updateDraft({ prompt: 'A 山海封面', quantity: 3, compareAId: crypto.randomUUID(), compareBId: crypto.randomUUID(), compareEnabled: true, compareActiveSide: 'B', resultScrollLeft: 128, expandedSections: ['references'] })
  useWorkspaceStore.getState().setViewport(1.7, { x: 48, y: -12 })
  useWorkspaceStore.getState().setActiveView('generate')
  useCreationSessionStore.getState().setDraft('A 的下一轮未发送文字')
  useCreationSessionStore.getState().setProviderAutoGenerationAllowed(true)
  useCreationSessionStore.getState().setAutoGenerateForNextTurn(true)
  const saved = captureProjectWorkContext()!
  expect(JSON.stringify(saved)).not.toContain('autoGenerate')
  hydrateWorkspaceScene(b, 'B')
  expect(useGenerationDraftStore.getState()).toMatchObject({ projectId: b.projectId, prompt: '', quantity: 1, compareEnabled: false, compareAId: null })
  expect(useCreationSessionStore.getState()).toMatchObject({ draft: '', autoGenerateForNextTurn: false })
  useGenerationDraftStore.getState().updateDraft({ prompt: 'late A' }, a.projectId)
  expect(useGenerationDraftStore.getState().prompt).toBe('')
  hydrateWorkspaceScene(a, 'A', undefined, saved)
  expect(captureProjectWorkContext()).toEqual(saved)
  expect(useCreationSessionStore.getState().autoGenerateForNextTurn).toBe(false)
  expect(projectWorkContextSchema.safeParse({ ...defaultProjectWorkContext(a.projectId), autoGenerate: true }).success).toBe(false)
})

it.each(['B', 'A-again'])('ignores old in-flight and queued Scene commands after %s hydration', async (destination) => {
  const a = createBlankScene(), b = createBlankScene()
  const local = createLocalWorkspaceSceneClient(a)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const execute = vi.fn(async (input: Parameters<typeof local.execute>[0]) => { await gate; return local.execute(input) })
  setWorkspaceSceneClientForTests({ ...local, execute })
  hydrateWorkspaceScene(a, 'A')
  const first = useWorkspaceStore.getState().addElement(makeImage(), 'old A insert')
  const second = useWorkspaceStore.getState().execute('old A queued', [{ kind: 'element.add', element: { ...makeImage(), id: crypto.randomUUID() } }])
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  hydrateWorkspaceScene(b, 'B')
  if (destination === 'A-again') hydrateWorkspaceScene(a, 'A')
  const before = useWorkspaceStore.getState().scene
  release()
  expect(await first).toBe(false)
  expect(await second).toBe(false)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(useWorkspaceStore.getState().scene).toEqual(before)
  expect(useWorkspaceStore.getState().selectedIds).toEqual([])
})

it('does not let an old image load overwrite the same asset ID in a newly opened project', async () => {
  const a = createBlankScene(), b = createBlankScene()
  const assetId = crypto.randomUUID()
  const image = makeImage()
  if (image.type !== 'image') throw new Error('Expected image fixture')
  a.elements = [{ ...image, assetId }]
  b.elements = [{ ...image, assetId }]
  let resolveA!: (value: string) => void
  const readGenerationAsset = vi.fn((_asset: string, _thumbnail: boolean, projectId: string) => projectId === a.projectId
    ? new Promise<string>((resolve) => { resolveA = resolve }) : Promise.resolve('data:image/png;base64,B'))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { readGenerationAsset } })
  hydrateWorkspaceScene(a, 'A')
  const view = render(<RuntimeAssetSynchronizer />)
  await waitFor(() => expect(readGenerationAsset).toHaveBeenCalledTimes(1))
  act(() => { clearRuntimeAssets(); hydrateWorkspaceScene(b, 'B') })
  await waitFor(() => expect(getRuntimeAssetUrl(assetId)).toBe('data:image/png;base64,B'))
  await act(async () => { resolveA('data:image/png;base64,A'); await Promise.resolve() })
  expect(getRuntimeAssetUrl(assetId)).toBe('data:image/png;base64,B')
  view.unmount()
})
