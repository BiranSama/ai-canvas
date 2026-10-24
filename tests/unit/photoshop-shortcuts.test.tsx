import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

vi.mock('../../src/renderer/src/canvas/CanvasStage', async () => {
  const React = await import('react')
  return {
    CanvasStage: React.forwardRef(function MockCanvasStage() {
      return <div data-testid="canvas-stage" />
    })
  }
})

const desktop = {
  getRuntimeInfo: vi.fn(),
  createProject: vi.fn(),
  saveProjectAs: vi.fn()
}

function element(id: string) {
  const found = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`No element ${id}`)
  return found
}

function press(init: KeyboardEventInit & { key: string }): void {
  fireEvent.keyDown(window, init)
}

async function renderWorkspace(selected: readonly string[] = []): Promise<void> {
  const scene = createNightVeilScene()
  setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(scene))
  resetWorkspace(scene)
  useWorkspaceStore.getState().setSelection(selected)
  render(<App />)
  await screen.findByTestId('canvas-stage')
}

describe('Photoshop shortcuts on the canvas', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T08:00:00Z'))
    desktop.getRuntimeInfo.mockResolvedValue({ appVersion: '0.1.0', electronVersion: '43.3.0', platform: 'win32', systemTheme: 'light', backgroundMaterial: 'mica', startupRoute: 'workspace', projectLibraryPath: 'C:\\AI Canvas', nativeModules: { betterSqlite3: true, sharp: true } })
    desktop.createProject.mockResolvedValue({ cancelled: true, bootstrap: null })
    desktop.saveProjectAs.mockResolvedValue({ cancelled: true, bootstrap: null })
    Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  })

  afterEach(() => {
    setWorkspaceSceneClientForTests(null)
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('picks tools with U, I and Ctrl+T and toggles focus with F', async () => {
    await renderWorkspace()
    const before = useWorkspaceStore.getState().scene.elements.length
    press({ key: 'u', code: 'KeyU' })
    await waitFor(() => expect(useWorkspaceStore.getState().scene.elements).toHaveLength(before + 1))
    expect(useWorkspaceStore.getState().scene.elements.at(-1)?.type).toBe('shape')

    press({ key: 'i', code: 'KeyI' })
    expect(useWorkspaceStore.getState().activeTool).toBe('eyedropper')
    expect(screen.getByRole('button', { name: '吸管' })).toHaveAttribute('aria-pressed', 'true')
    press({ key: 't', code: 'KeyT', ctrlKey: true })
    expect(useWorkspaceStore.getState().activeTool).toBe('select')

    press({ key: 'f', code: 'KeyF' })
    expect(document.querySelector('.canvas-workspace')).toHaveClass('is-focus-mode')
    press({ key: 'f', code: 'KeyF' })
    expect(document.querySelector('.canvas-workspace')).not.toHaveClass('is-focus-mode')
  })

  it('swaps colours with X, resets them with D and fills text and shapes with Alt or Ctrl+Backspace', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    useWorkspaceStore.getState().setForegroundColor('#C0392B')
    press({ key: 'x', code: 'KeyX' })
    expect(useWorkspaceStore.getState()).toMatchObject({ foregroundColor: '#FFFFFF', backgroundColor: '#C0392B' })

    press({ key: 'Backspace', code: 'Backspace', ctrlKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title)).toMatchObject({ fill: '#C0392B' }))
    press({ key: 'Backspace', code: 'Backspace', altKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title)).toMatchObject({ fill: '#FFFFFF' }))
    expect(element(NIGHT_VEIL_IDS.title)).toBeDefined()

    press({ key: 'd', code: 'KeyD' })
    expect(useWorkspaceStore.getState()).toMatchObject({ foregroundColor: '#000000', backgroundColor: '#FFFFFF' })
    expect(screen.getByRole('button', { name: '交换前景色和背景色' })).toHaveAttribute('aria-keyshortcuts', 'X')
  })

  it('selects all layers with Ctrl+Alt+A and none with Ctrl+D', async () => {
    await renderWorkspace()
    press({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true })
    expect([...useWorkspaceStore.getState().selectedIds].sort()).toEqual([NIGHT_VEIL_IDS.background, NIGHT_VEIL_IDS.light, NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title].sort())
    press({ key: 'd', code: 'KeyD', ctrlKey: true })
    expect(useWorkspaceStore.getState().selectedIds).toEqual([])
  })

  it('hides with Ctrl+, and locks with Ctrl+/, both as toggles', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.bottle])
    press({ key: ',', code: 'Comma', ctrlKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).visible).toBe(false))
    press({ key: ',', code: 'Comma', ctrlKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).visible).toBe(true))
    press({ key: '/', code: 'Slash', ctrlKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).locked).toBe(true))
    press({ key: '/', code: 'Slash', ctrlKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).locked).toBe(false))
  })

  it('sets opacity from number keys, taking two quick digits as one value', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    press({ key: '5', code: 'Digit5' })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).opacity).toBe(0.5))
    vi.setSystemTime(new Date('2026-10-24T08:00:01Z'))
    press({ key: '0', code: 'Digit0' })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).opacity).toBe(1))
    vi.setSystemTime(new Date('2026-10-24T08:00:02Z'))
    press({ key: '4', code: 'Digit4' })
    press({ key: '5', code: 'Numpad5' })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).opacity).toBe(0.45))
  })

  it('steps blend modes with Shift+plus and minus and picks one with Alt+Shift+letter', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    press({ key: '+', code: 'Equal', shiftKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).blendMode).toBe('multiply'))
    press({ key: '_', code: 'Minus', shiftKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).blendMode).toBe('normal'))
    press({ key: 'S', code: 'KeyS', shiftKey: true, altKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).blendMode).toBe('screen'))
    press({ key: 'F', code: 'KeyF', shiftKey: true, altKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.title).blendMode).toBe('soft-light'))
  })

  it('duplicates in place with Ctrl+J, directly above the source', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.bottle])
    const source = element(NIGHT_VEIL_IDS.bottle)
    press({ key: 'j', code: 'KeyJ', ctrlKey: true })
    await waitFor(() => expect(useWorkspaceStore.getState().selectedIds).not.toContain(NIGHT_VEIL_IDS.bottle))
    const copy = element(useWorkspaceStore.getState().selectedIds[0]!)
    expect(copy).toMatchObject({ name: '香水瓶 副本', transform: source.transform, zIndex: source.zIndex + 1 })
  })

  it('opens the shortcut sheet with Ctrl+Alt+Shift+K and the file commands with Ctrl+N, Ctrl+O and Ctrl+Shift+S', async () => {
    await renderWorkspace()
    press({ key: 'K', code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true })
    const sheet = screen.getByRole('dialog', { name: '快捷键' })
    expect(within(sheet).getByText('吸管：单击取前景色，Alt+单击取背景色')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷键' })).not.toBeInTheDocument())

    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    press({ key: 'o', code: 'KeyO', ctrlKey: true })
    expect(click).toHaveBeenCalledTimes(1)
    expect((click.mock.contexts[0] as HTMLInputElement).accept).toBe('image/png,image/jpeg,image/webp,.psd')
    click.mockRestore()

    await act(async () => { press({ key: 'n', code: 'KeyN', ctrlKey: true }) })
    await waitFor(() => expect(desktop.createProject).toHaveBeenCalledWith({ suggestedName: 'Untitled' }))
    await act(async () => { press({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }) })
    await waitFor(() => expect(desktop.saveProjectAs).toHaveBeenCalledTimes(1))
  })

  it('shows only one layer on Alt+click of its eye, and everything again on the next', async () => {
    await renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '隐藏主标题' }), { altKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).visible).toBe(false))
    expect(element(NIGHT_VEIL_IDS.light).visible).toBe(false)
    expect(element(NIGHT_VEIL_IDS.title).visible).toBe(true)
    expect(element(NIGHT_VEIL_IDS.background).visible).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '隐藏主标题' }), { altKey: true })
    await waitFor(() => expect(element(NIGHT_VEIL_IDS.bottle).visible).toBe(true))
    expect(element(NIGHT_VEIL_IDS.light).visible).toBe(true)
  })
})
