import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'
import { useMaskState } from '../../src/renderer/src/canvas/mask-state'
import { useEditDialog } from '../../src/renderer/src/components/edit-dialog-store'
import { rectMask } from '../../src/shared/mask-raster'
import { setSelectionMask, useSelectionStore } from '../../src/renderer/src/selection/selection-store'

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
  saveProjectAs: vi.fn(),
  importPixels: vi.fn()
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
    desktop.importPixels.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000099', width: 1024, height: 1280, format: 'png', hasAlpha: true })
    Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  })

  afterEach(() => {
    setSelectionMask(null)
    useEditDialog.getState().close()
    useMaskState.setState({ editing: null, view: null })
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

  it('picks the painting tools with B, E, G and Shift+G, and sets the brush with brackets and digits', async () => {
    await renderWorkspace()
    press({ key: 'b', code: 'KeyB' })
    expect(useWorkspaceStore.getState().activeTool).toBe('brush')
    const options = screen.getByRole('toolbar', { name: '画笔选项' })
    press({ key: ']', code: 'BracketRight' })
    expect(useWorkspaceStore.getState().paintSettings.brush.size).toBe(34)
    press({ key: '[', code: 'BracketLeft' })
    press({ key: '[', code: 'BracketLeft' })
    expect(useWorkspaceStore.getState().paintSettings.brush.size).toBe(14)
    press({ key: '{', code: 'BracketLeft', shiftKey: true })
    expect(useWorkspaceStore.getState().paintSettings.brush.hardness).toBe(0.55)
    press({ key: '}', code: 'BracketRight', shiftKey: true })
    press({ key: '}', code: 'BracketRight', shiftKey: true })
    expect(useWorkspaceStore.getState().paintSettings.brush.hardness).toBe(1)
    press({ key: '5', code: 'Digit5' })
    expect(useWorkspaceStore.getState().paintSettings.brush.opacity).toBe(0.5)
    vi.setSystemTime(new Date('2026-10-24T08:00:01Z'))
    press({ key: '#', code: 'Digit3', shiftKey: true })
    expect(useWorkspaceStore.getState().paintSettings.brush.flow).toBe(0.3)
    expect(within(options).getByRole('spinbutton', { name: '不透明度' })).toHaveValue(50)
    expect(within(options).getByRole('spinbutton', { name: '流量' })).toHaveValue(30)

    press({ key: 'e', code: 'KeyE' })
    expect(useWorkspaceStore.getState().activeTool).toBe('eraser')
    press({ key: 'g', code: 'KeyG' })
    expect(useWorkspaceStore.getState().activeTool).toBe('bucket')
    press({ key: 'G', code: 'KeyG', shiftKey: true })
    expect(useWorkspaceStore.getState().activeTool).toBe('gradient')
    press({ key: 'v', code: 'KeyV' })
    // G brings back whichever of the two was used last, as Photoshop's shared slot does.
    press({ key: 'g', code: 'KeyG' })
    expect(useWorkspaceStore.getState().activeTool).toBe('gradient')
    expect(screen.getByRole('button', { name: '渐变' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('makes a blank layer with Ctrl+Shift+N, locks its transparency with / and fills it with Alt+Backspace', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.bottle])
    press({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(useWorkspaceStore.getState().scene.elements.some((candidate) => candidate.name === '图层 1')).toBe(true))
    expect(desktop.importPixels).toHaveBeenCalledWith(expect.objectContaining({ width: 1024, height: 1280 }))
    const elements = useWorkspaceStore.getState().scene.elements
    const layer = elements.find((candidate) => candidate.name === '图层 1')!
    // Directly above the selected layer, and selected.
    expect(elements.indexOf(layer)).toBe(elements.findIndex((candidate) => candidate.id === NIGHT_VEIL_IDS.bottle) + 1)
    expect(useWorkspaceStore.getState().selectedIds).toEqual([layer.id])
    expect(layer).toMatchObject({ type: 'image', fit: 'fill', transform: { x: 0, y: 0, width: 1, height: 1 } })

    press({ key: '/', code: 'Slash' })
    await waitFor(() => expect(element(layer.id)).toMatchObject({ transparencyLocked: true }))
    useWorkspaceStore.getState().setForegroundColor('#336699')
    press({ key: 'Backspace', code: 'Backspace', altKey: true })
    await waitFor(() => expect(element(layer.id)).toMatchObject({ paint: [{ kind: 'fill-all', color: '#336699', lockAlpha: true }] }))
  })

  it('merges with Ctrl+E, Ctrl+Shift+E and Ctrl+Alt+Shift+E, refusing what Photoshop would not merge', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    press({ key: 'e', code: 'KeyE', ctrlKey: true })
    expect(await screen.findByText('下面的「香水瓶」是 AI 标注，不能合并。')).toBeInTheDocument()
    act(() => useWorkspaceStore.getState().setSelection([NIGHT_VEIL_IDS.background]))
    press({ key: 'e', code: 'KeyE', ctrlKey: true })
    expect(await screen.findByText('「背景」下面没有可以合并进去的图层。')).toBeInTheDocument()
    act(() => useWorkspaceStore.getState().setSelection([]))
    press({ key: 'e', code: 'KeyE', ctrlKey: true })
    expect(await screen.findByText('先选中要合并的图层。')).toBeInTheDocument()
    press({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })
    expect(await screen.findByText('「背景」已锁定，解锁或隐藏它后再合并可见图层。')).toBeInTheDocument()
    // Stamping draws the layers on the canvas, which this test does not have.
    press({ key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true })
    expect(await screen.findByText('没能盖印可见图层：画布上的图层还没画好，稍后再试。')).toBeInTheDocument()
    expect(useWorkspaceStore.getState().scene.elements).toHaveLength(4)
  })
  it('selects pixels with Ctrl+A, inverts with Ctrl+Shift+I, drops them with Ctrl+D and brings them back with Ctrl+Shift+D', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    const selection = () => useSelectionStore.getState().mask
    press({ key: 'a', code: 'KeyA', ctrlKey: true })
    expect(selection()).toMatchObject({ width: 1024, height: 1280 })
    expect(selection()!.data.every((value) => value === 255)).toBe(true)
    // Ctrl+A selects pixels now; the layers stay as they were.
    expect(useWorkspaceStore.getState().selectedIds).toEqual([NIGHT_VEIL_IDS.title])

    act(() => setSelectionMask(rectMask(1024, 1280, { x: 100, y: 100, width: 200, height: 200 })))
    press({ key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true })
    expect([selection()!.data[0], selection()!.data[150 * 1024 + 150]]).toEqual([255, 0])

    press({ key: 'd', code: 'KeyD', ctrlKey: true })
    expect(selection()).toBeNull()
    expect(useWorkspaceStore.getState().selectedIds).toEqual([NIGHT_VEIL_IDS.title])
    press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })
    expect(selection()!.data[150 * 1024 + 150]).toBe(0)
    // Ctrl+Z steps back through the selection like any other change.
    press({ key: 'z', code: 'KeyZ', ctrlKey: true })
    await waitFor(() => expect(selection()).toBeNull())
    press({ key: 'd', code: 'KeyD', ctrlKey: true })
    expect(useWorkspaceStore.getState().selectedIds).toEqual([])
  })

  it('picks the selection tools with M, L and W, Shift moving to the other tool in the slot', async () => {
    await renderWorkspace()
    const tool = () => useWorkspaceStore.getState().activeTool
    press({ key: 'm', code: 'KeyM' })
    expect(tool()).toBe('marquee-rect')
    expect(screen.getByRole('toolbar', { name: '矩形选框选项' })).toBeInTheDocument()
    press({ key: 'M', code: 'KeyM', shiftKey: true })
    expect(tool()).toBe('marquee-ellipse')
    press({ key: 'v', code: 'KeyV' })
    press({ key: 'm', code: 'KeyM' })
    expect(tool()).toBe('marquee-ellipse')
    press({ key: 'l', code: 'KeyL' })
    expect(tool()).toBe('lasso')
    press({ key: 'L', code: 'KeyL', shiftKey: true })
    expect(tool()).toBe('lasso-polygon')
    press({ key: 'w', code: 'KeyW' })
    expect(tool()).toBe('object-select')
    press({ key: 'W', code: 'KeyW', shiftKey: true })
    expect(tool()).toBe('magic-wand')
  })

  it('opens Feather with Shift+F6 and Fill with Shift+F5', async () => {
    await renderWorkspace()
    press({ key: 'F6', code: 'F6', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: '羽化选区' })).toBeInTheDocument()
    act(() => useEditDialog.getState().close())
    press({ key: 'F5', code: 'F5', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: '填充' })).toBeInTheDocument()
  })

  it('with a selection, Delete clears pixels instead of deleting the layer, and asks for a raster layer first', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    act(() => setSelectionMask(rectMask(1024, 1280, { x: 0, y: 0, width: 512, height: 512 })))
    press({ key: 'Delete', code: 'Delete' })
    expect(await screen.findByText('「主标题」要先栅格化（图层右键菜单），才能清除选区里的像素。')).toBeInTheDocument()
    expect(element(NIGHT_VEIL_IDS.title)).toBeDefined()
  })

  it('lays a layer\'s mask over it in red with \\ and takes it off again', async () => {
    await renderWorkspace([NIGHT_VEIL_IDS.title])
    press({ key: '\\', code: 'Backslash' })
    expect(useMaskState.getState().view).toBeNull()
    await act(async () => { await useWorkspaceStore.getState().updateElement(NIGHT_VEIL_IDS.title, { mask: { assetId: '10000000-0000-4000-8000-000000000098', enabled: true } }, '添加蒙版') })
    press({ key: '\\', code: 'Backslash' })
    expect(useMaskState.getState().view).toEqual({ elementId: NIGHT_VEIL_IDS.title, mode: 'overlay' })
    press({ key: '\\', code: 'Backslash' })
    expect(useMaskState.getState().view).toBeNull()
  })
})
