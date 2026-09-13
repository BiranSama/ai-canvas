import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('Direct Canvas supports inline editing, viewport conventions, clipboard and focus mode offline', async ({ browserName }, testInfo) => {
  void browserName
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-direct-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.bringToFront()
    await window.setViewportSize({ width: 1280, height: 800 })
    const stage = window.getByTestId('canvas-stage')
    await expect(stage).toBeVisible()
    const surface = stage.locator('.konvajs-content')
    const dispatchCanvasMouse = async (type: 'mousedown' | 'mousemove' | 'mouseup', point: { readonly x: number; readonly y: number }): Promise<void> => {
      await surface.evaluate((element, input) => {
        const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (type: string, init: unknown) => Parameters<typeof element.dispatchEvent>[0]
        element.dispatchEvent(new BrowserMouseEvent(input.type, {
          bubbles: true,
          cancelable: true,
          clientX: input.point.x,
          clientY: input.point.y,
          button: 0,
          buttons: input.type === 'mouseup' ? 0 : 1
        }))
      }, { type, point })
    }

    await window.getByRole('button', { name: '文字 T' }).click()
    await expect(stage.getByRole('button', { name: /编辑文字/ })).toBeVisible()
    await stage.getByRole('button', { name: /编辑文字/ }).click()
    const inlineEditor = stage.getByRole('textbox', { name: /编辑文字/ })
    await expect(inlineEditor).toBeVisible()
    await inlineEditor.fill('画布正文')
    await inlineEditor.press('Control+Enter')
    await expect(inlineEditor).toHaveCount(0)
    await expect(window.getByRole('listbox', { name: '图层' }).locator('strong', { hasText: /^文字$/ })).toBeVisible()

    const beforeTransform = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const text = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'text')
      if (text?.type !== 'text') throw new Error('Text transform is unavailable.')
      return { id: text.id, width: text.transform.width }
    })
    await window.waitForTimeout(600)
    const resizeAnchor = await window.evaluate(`(async () => {
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surfaceElement = root?.querySelector('.konvajs-content')
      const element = (await window.desktop.getWorkspaceBootstrap()).scene.elements.find((candidate) => candidate.type === 'text')
      if (!(root instanceof HTMLElement) || !(surfaceElement instanceof HTMLElement) || element?.type !== 'text') throw new Error('Resize geometry is unavailable.')
      const surfaceRect = surfaceElement.getBoundingClientRect()
      return {
        x: surfaceRect.left + Number(root.dataset.artboardX) + (element.transform.x + element.transform.width) * Number(root.dataset.artboardWidth),
        y: surfaceRect.top + Number(root.dataset.artboardY) + (element.transform.y + element.transform.height / 2) * Number(root.dataset.artboardHeight)
      }
    })()`) as { readonly x: number; readonly y: number }
    // Capturing the interaction baseline also flushes Electron's off-screen
    // compositor so Konva's visual and hit canvases are sampled in the same frame.
    await window.screenshot({ path: testInfo.outputPath('before-transform.png') })
    await window.mouse.move(resizeAnchor.x, resizeAnchor.y)
    await window.mouse.down()
    await window.mouse.move(resizeAnchor.x + 28, resizeAnchor.y, { steps: 3 })
    await window.mouse.move(resizeAnchor.x + 64, resizeAnchor.y, { steps: 3 })
    await expect(stage.locator('.canvas-transform-hud')).toBeVisible({ timeout: 1_000 })
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const text = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === before.id)
      return text?.transform.width ?? before.width
    }, beforeTransform)).toBeGreaterThan(beforeTransform.width)
    const resizeUndo = window.getByLabel('撤销', { exact: true })
    await expect(resizeUndo).toBeEnabled()
    await resizeUndo.click()
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const text = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === before.id)
      return text?.transform.width ?? 0
    }, beforeTransform)).toBe(beforeTransform.width)

    const layerOptions = window.getByRole('listbox', { name: '图层' }).getByRole('option')
    const beforeDuplicate = await layerOptions.count()
    await window.keyboard.press('Control+J')
    await expect(layerOptions).toHaveCount(beforeDuplicate + 1)

    await window.keyboard.press('Control+C')
    await window.evaluate(`(() => {
      const transfer = new DataTransfer()
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })()`)
    await expect(layerOptions).toHaveCount(beforeDuplicate + 2)

    const overlapPoint = await window.evaluate(`(async () => {
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surfaceElement = root?.querySelector('.konvajs-content')
      const texts = (await window.desktop.getWorkspaceBootstrap()).scene.elements.filter((element) => element.type === 'text')
      if (!(root instanceof HTMLElement) || !(surfaceElement instanceof HTMLElement) || texts.length < 3) throw new Error('Overlap selection geometry is unavailable.')
      const left = Math.max(...texts.map((element) => element.transform.x))
      const top = Math.max(...texts.map((element) => element.transform.y))
      const right = Math.min(...texts.map((element) => element.transform.x + element.transform.width))
      const bottom = Math.min(...texts.map((element) => element.transform.y + element.transform.height))
      const surfaceRect = surfaceElement.getBoundingClientRect()
      return {
        x: surfaceRect.left + Number(root.dataset.artboardX) + (left + right) / 2 * Number(root.dataset.artboardWidth),
        y: surfaceRect.top + Number(root.dataset.artboardY) + (top + bottom) / 2 * Number(root.dataset.artboardHeight)
      }
    })()`) as { readonly x: number; readonly y: number }
    await window.screenshot({ path: testInfo.outputPath('before-overlap-cycle.png') })
    await window.mouse.click(overlapPoint.x, overlapPoint.y)
    const selectedLayerOption = window.getByRole('listbox', { name: '图层' }).getByRole('option', { selected: true })
    await expect(selectedLayerOption).toHaveCount(1)
    const firstOverlapSelection = await selectedLayerOption.getAttribute('data-layer-id')
    await window.evaluate("globalThis.__aiCanvasLastAltKey = null; document.querySelector('.konvajs-content')?.addEventListener('mousedown', (event) => { globalThis.__aiCanvasLastAltKey = event.altKey }, { capture: true, once: true })")
    await window.keyboard.down('Alt')
    await window.mouse.click(overlapPoint.x, overlapPoint.y)
    await window.keyboard.up('Alt')
    expect(await window.evaluate('globalThis.__aiCanvasLastAltKey')).toBe(true)
    await expect.poll(() => selectedLayerOption.getAttribute('data-layer-id')).not.toBe(firstOverlapSelection)

    await window.keyboard.press('Escape')
    const stageBox = await stage.boundingBox()
    if (stageBox === null) throw new Error('Canvas stage is not measurable.')
    const start = { x: stageBox.x + stageBox.width * 0.27, y: stageBox.y + stageBox.height * 0.08 }
    const end = { x: stageBox.x + stageBox.width * 0.73, y: stageBox.y + stageBox.height * 0.92 }
    await dispatchCanvasMouse('mousedown', start)
    await dispatchCanvasMouse('mousemove', end)
    await dispatchCanvasMouse('mouseup', end)
    await expect(stage.getByRole('button', { name: '编组所选元素' })).toBeVisible()

    const selectedBeforeMove = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements
        .filter((element) => element.type === 'text')
        .map((element) => ({ id: element.id, transform: { ...element.transform } }))
    })
    expect(selectedBeforeMove.length).toBeGreaterThanOrEqual(3)
    const sceneRevisionBeforeMultiMove = await stage.evaluate((element) => Number(element.dataset.sceneRevision))
    const selectedDragPoint = await window.evaluate(`(async () => {
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surfaceElement = root?.querySelector('.konvajs-content')
      const text = (await window.desktop.getWorkspaceBootstrap()).scene.elements
        .filter((element) => element.type === 'text')
        .sort((left, right) => right.zIndex - left.zIndex)[0]
      if (!(root instanceof HTMLElement) || !(surfaceElement instanceof HTMLElement) || text?.type !== 'text') throw new Error('Multi-selection drag geometry is unavailable.')
      const surfaceRect = surfaceElement.getBoundingClientRect()
      return {
        x: surfaceRect.left + Number(root.dataset.artboardX) + (text.transform.x + text.transform.width / 2) * Number(root.dataset.artboardWidth),
        y: surfaceRect.top + Number(root.dataset.artboardY) + (text.transform.y + text.transform.height / 2) * Number(root.dataset.artboardHeight)
      }
    })()`) as { readonly x: number; readonly y: number }
    await window.screenshot({ path: testInfo.outputPath('before-multi-move.png') })
    await window.mouse.move(selectedDragPoint.x, selectedDragPoint.y)
    await window.mouse.down()
    await window.mouse.move(selectedDragPoint.x + 34, selectedDragPoint.y + 22, { steps: 4 })
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const deltas = before.map((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return element === undefined ? null : {
          x: element.transform.x - item.transform.x,
          y: element.transform.y - item.transform.y
        }
      }).filter((delta): delta is { x: number; y: number } => delta !== null)
      const xValues = deltas.map((delta) => delta.x)
      const yValues = deltas.map((delta) => delta.y)
      return {
        moved: deltas.length === before.length && deltas.every((delta) => Math.hypot(delta.x, delta.y) > 0.005),
        rigid: Math.max(...xValues) - Math.min(...xValues) < 0.0001 && Math.max(...yValues) - Math.min(...yValues) < 0.0001
      }
    }, selectedBeforeMove)).toEqual({ moved: true, rigid: true })
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBeGreaterThan(sceneRevisionBeforeMultiMove)
    await window.waitForTimeout(150)
    const sceneRevisionAfterMultiMove = await stage.evaluate((element) => Number(element.dataset.sceneRevision))
    expect(sceneRevisionAfterMultiMove - sceneRevisionBeforeMultiMove).toBe(1)
    await window.keyboard.press('Control+Z')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBeGreaterThan(sceneRevisionAfterMultiMove)
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return before.map((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return {
          id: item.id,
          xError: element === undefined ? null : Number((element.transform.x - item.transform.x).toFixed(6)),
          yError: element === undefined ? null : Number((element.transform.y - item.transform.y).toFixed(6))
        }
      })
    }, selectedBeforeMove)).toEqual(selectedBeforeMove.map((item) => ({ id: item.id, xError: 0, yError: 0 })))

    await window.mouse.move(selectedDragPoint.x, selectedDragPoint.y)
    await window.mouse.down()
    await window.mouse.move(selectedDragPoint.x - 28, selectedDragPoint.y + 18, { steps: 4 })
    await window.keyboard.press('Escape')
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return before.every((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return element !== undefined
          && Math.abs(element.transform.x - item.transform.x) < 0.0001
          && Math.abs(element.transform.y - item.transform.y) < 0.0001
      })
    }, selectedBeforeMove)).toBe(true)

    const sceneRevisionBeforeBlurCancel = await stage.evaluate((element) => Number(element.dataset.sceneRevision))
    await window.mouse.move(selectedDragPoint.x, selectedDragPoint.y)
    await window.mouse.down()
    await window.mouse.move(selectedDragPoint.x + 26, selectedDragPoint.y - 18, { steps: 4 })
    await window.evaluate("globalThis.dispatchEvent(new Event('blur'))")
    await window.mouse.up()
    await window.waitForTimeout(150)
    await expect(stage).toHaveAttribute('data-scene-revision', String(sceneRevisionBeforeBlurCancel))
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return before.every((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return element !== undefined
          && Math.abs(element.transform.x - item.transform.x) < 0.0001
          && Math.abs(element.transform.y - item.transform.y) < 0.0001
      })
    }, selectedBeforeMove)).toBe(true)

    await window.mouse.move(selectedDragPoint.x, selectedDragPoint.y)
    await window.mouse.down()
    await window.mouse.move(selectedDragPoint.x + 24, selectedDragPoint.y - 16, { steps: 4 })
    await window.mouse.up()
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(sceneRevisionBeforeBlurCancel + 1)
    await window.keyboard.press('Control+Z')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(sceneRevisionBeforeBlurCancel + 2)
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return before.every((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return element !== undefined
          && Math.abs(element.transform.x - item.transform.x) < 0.0001
          && Math.abs(element.transform.y - item.transform.y) < 0.0001
      })
    }, selectedBeforeMove)).toBe(true)

    await stage.getByRole('button', { name: '水平居中' }).click()
    await expect.poll(async () => window.evaluate(async (ids: string[]) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const centers = ids.flatMap((id) => {
        const element = scene.elements.find((candidate) => candidate.id === id)
        return element === undefined ? [] : [element.transform.x + element.transform.width / 2]
      })
      return centers.length === ids.length && Math.max(...centers) - Math.min(...centers) < 0.0001
    }, selectedBeforeMove.map((item) => item.id))).toBe(true)
    await window.keyboard.press('Control+Z')
    await expect.poll(async () => window.evaluate(async (before) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return before.every((item) => {
        const element = scene.elements.find((candidate) => candidate.id === item.id)
        return element !== undefined
          && Math.abs(element.transform.x - item.transform.x) < 0.0001
          && Math.abs(element.transform.y - item.transform.y) < 0.0001
      })
    }, selectedBeforeMove)).toBe(true)

    const selectedElementIds = await window.getByRole('listbox', { name: '图层' }).getByRole('option', { selected: true }).evaluateAll((rows) => rows.flatMap((row) => {
      const id = row.getAttribute('data-layer-id')
      return id === null ? [] : [id]
    }))
    expect(selectedElementIds.length).toBeGreaterThan(1)
    const rotationIdsJson = JSON.stringify(selectedElementIds)
    const rotationGesture = await window.evaluate(`(async () => {
      const ids = ${rotationIdsJson}
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surfaceElement = root?.querySelector('.konvajs-content')
      const scene = (await window.desktop.getWorkspaceBootstrap()).scene
      const elements = scene.elements.filter((element) => ids.includes(element.id))
      if (!(root instanceof HTMLElement) || !(surfaceElement instanceof HTMLElement) || elements.length < 2) throw new Error('Multi-rotation geometry is unavailable.')
      const surfaceRect = surfaceElement.getBoundingClientRect()
      const artboardX = Number(root.dataset.artboardX)
      const artboardY = Number(root.dataset.artboardY)
      const artboardWidth = Number(root.dataset.artboardWidth)
      const artboardHeight = Number(root.dataset.artboardHeight)
      const left = Math.min(...elements.map((element) => element.transform.x))
      const top = Math.min(...elements.map((element) => element.transform.y))
      const right = Math.max(...elements.map((element) => element.transform.x + element.transform.width))
      const bottom = Math.max(...elements.map((element) => element.transform.y + element.transform.height))
      const center = {
        x: surfaceRect.left + artboardX + (left + right) / 2 * artboardWidth,
        y: surfaceRect.top + artboardY + (top + bottom) / 2 * artboardHeight
      }
      const radius = (bottom - top) * artboardHeight / 2 + 22
      return {
        start: { x: center.x, y: center.y - radius },
        end: {
          x: center.x + Math.cos(-75 * Math.PI / 180) * radius,
          y: center.y + Math.sin(-75 * Math.PI / 180) * radius
        }
      }
    })()` ) as { readonly start: { readonly x: number; readonly y: number }; readonly end: { readonly x: number; readonly y: number } }
    const contextBarBox = await stage.locator('.canvas-context-bar').boundingBox()
    if (contextBarBox === null) throw new Error('Selection context bar is not measurable.')
    expect(
      rotationGesture.start.y + 12 <= contextBarBox.y
      || rotationGesture.start.y - 12 >= contextBarBox.y + contextBarBox.height
      || rotationGesture.start.x + 12 <= contextBarBox.x
      || rotationGesture.start.x - 12 >= contextBarBox.x + contextBarBox.width
    ).toBe(true)

    const sceneRevisionBeforeRotation = await stage.evaluate((element) => Number(element.dataset.sceneRevision))
    await window.screenshot({ path: testInfo.outputPath('before-multi-rotation.png') })
    await window.mouse.move(rotationGesture.start.x, rotationGesture.start.y)
    await window.keyboard.down('Shift')
    await window.mouse.down()
    await window.mouse.move(rotationGesture.end.x, rotationGesture.end.y, { steps: 6 })
    await expect(stage.locator('.canvas-transform-hud')).toBeVisible({ timeout: 1_500 })
    await window.mouse.up()
    await window.keyboard.up('Shift')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(sceneRevisionBeforeRotation + 1)
    await expect.poll(async () => window.evaluate(async (ids: string[]) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const rotations = ids.flatMap((id) => {
        const element = scene.elements.find((candidate) => candidate.id === id)
        return element === undefined ? [] : [element.transform.rotation]
      })
      return rotations.length === ids.length && rotations.every((rotation) => Math.abs(Math.abs(rotation) - 15) < 0.75)
    }, selectedElementIds)).toBe(true)
    await window.keyboard.press('Control+Z')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(sceneRevisionBeforeRotation + 2)
    await expect.poll(async () => window.evaluate(async (ids: string[]) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return ids.every((id) => {
        const element = scene.elements.find((candidate) => candidate.id === id)
        return element !== undefined && Math.abs(element.transform.rotation) < 0.0001
      })
    }, selectedElementIds)).toBe(true)

    const viewportScale = window.getByTestId('viewport-scale')
    const initialScale = await viewportScale.textContent()
    const initialArtboardPosition = await stage.evaluate((element) => ({
      x: Number(element.dataset.artboardX),
      y: Number(element.dataset.artboardY)
    }))
    await surface.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const BrowserWheelEvent = Reflect.get(globalThis, 'WheelEvent') as new (type: string, init: unknown) => Parameters<typeof element.dispatchEvent>[0]
      element.dispatchEvent(new BrowserWheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaY: 80
      }))
    })
    if (initialScale !== null) await expect(viewportScale).toHaveText(initialScale)
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.artboardY))).not.toBe(initialArtboardPosition.y)
    await surface.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const BrowserWheelEvent = Reflect.get(globalThis, 'WheelEvent') as new (type: string, init: unknown) => Parameters<typeof element.dispatchEvent>[0]
      element.dispatchEvent(new BrowserWheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaY: -80
      }))
    })
    if (initialScale !== null) await expect(viewportScale).not.toHaveText(initialScale)

    await window.keyboard.press('Control+1')
    await expect(viewportScale).toHaveText('100%')
    await window.keyboard.press('Control+0')
    if (initialScale !== null) await expect(viewportScale).toHaveText(initialScale)

    const surfaceBox = await surface.boundingBox()
    if (surfaceBox === null) throw new Error('Canvas surface is not measurable.')
    const panStart = { x: surfaceBox.x + surfaceBox.width / 2, y: surfaceBox.y + surfaceBox.height / 2 }
    const beforeSpacePan = await stage.evaluate((element) => Number(element.dataset.artboardX))
    await window.keyboard.down('Space')
    await window.mouse.move(panStart.x, panStart.y)
    await window.mouse.down()
    await window.mouse.move(panStart.x + 42, panStart.y + 12, { steps: 3 })
    await window.mouse.up()
    await window.keyboard.up('Space')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.artboardX))).not.toBe(beforeSpacePan)

    const beforeMiddlePan = await stage.evaluate((element) => Number(element.dataset.artboardX))
    await window.mouse.move(panStart.x, panStart.y)
    await window.mouse.down({ button: 'middle' })
    await window.mouse.move(panStart.x - 36, panStart.y, { steps: 3 })
    await window.mouse.up({ button: 'middle' })
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.artboardX))).not.toBe(beforeMiddlePan)

    await window.keyboard.press('h')
    await expect(window.getByRole('button', { name: '抓手 H' })).toHaveAttribute('aria-pressed', 'true')
    await window.keyboard.press('v')
    await expect(window.getByRole('button', { name: '选择 V' })).toHaveAttribute('aria-pressed', 'true')

    const toolsIsland = window.locator('[data-island-id="tools"]')
    const selectTool = window.getByRole('button', { name: '选择 V' })
    await selectTool.focus()
    await window.keyboard.press('Tab')
    await expect(window.getByRole('button', { name: '抓手 H' })).toBeFocused()
    await expect(toolsIsland).toBeVisible()
    await window.getByRole('button', { name: '进入专注' }).focus()
    await window.keyboard.press('Enter')
    await expect(window.locator('.canvas-workspace')).toHaveClass(/is-focus-mode/)
    await expect(toolsIsland).toBeHidden()
    await expect(window.getByRole('button', { name: '退出专注' })).toBeVisible()
    await window.keyboard.press('Space')
    await expect(toolsIsland).toBeVisible()

    await window.locator('input[type="file"]').last().setInputFiles(resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png'))
    await expect(stage.getByRole('button', { name: '裁剪' })).toBeVisible()
    await stage.getByRole('button', { name: '裁剪' }).evaluate((button: { click(): void }) => button.click())
    const cropPoint = await window.evaluate(`(async () => {
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surfaceElement = root?.querySelector('.konvajs-content')
      const image = (await window.desktop.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'image')
      if (!(root instanceof HTMLElement) || !(surfaceElement instanceof HTMLElement) || image?.type !== 'image') throw new Error('Crop geometry is unavailable.')
      const surfaceRect = surfaceElement.getBoundingClientRect()
      const x = Number(root.dataset.artboardX)
      const y = Number(root.dataset.artboardY)
      const width = Number(root.dataset.artboardWidth)
      const height = Number(root.dataset.artboardHeight)
      return {
        x: surfaceRect.left + x + (image.transform.x + image.transform.width / 2) * width,
        y: surfaceRect.top + y + (image.transform.y + image.transform.height / 2) * height
      }
    })()`) as { readonly x: number; readonly y: number }
    await expect(stage).toHaveClass(/is-cropping/)
    await stage.focus()
    await window.mouse.move(cropPoint.x, cropPoint.y)
    await window.mouse.wheel(0, -80)
    await window.keyboard.press('Enter')
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const image = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'image')
      return image?.type === 'image' ? image.crop.width : 1
    })).toBeLessThan(1)
    await window.getByLabel('撤销', { exact: true }).evaluate((button: { click(): void }) => button.click())
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const image = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'image')
      return image?.type === 'image' ? image.crop.width : 0
    })).toBe(1)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('header actions and project-card actions stay separate and More opens a real menu', async () => {
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-direct-menu-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
  })
  try {
    const window = await app.firstWindow()
    const viewports = [
      { width: 1024, height: 700 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 }
    ]
    for (const viewport of viewports) {
      await window.setViewportSize(viewport)
      const librarySettingsBox = await window.getByRole('button', { name: '打开设置' }).boundingBox()
      if (librarySettingsBox === null) throw new Error('Library settings are not measurable.')
      expect(librarySettingsBox.x + librarySettingsBox.width).toBeLessThanOrEqual(viewport.width - 152)
    }
    await window.setViewportSize(viewports[0]!)
    await window.locator('.new-project-main').click({ force: true })
    await expect(window.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible({ timeout: 10_000 })
    const settings = window.getByTestId('open-settings')
    const exportControl = window.locator('.export-control')
    for (const viewport of viewports) {
      await window.setViewportSize(viewport)
      const settingsBox = await settings.boundingBox()
      const exportBox = await exportControl.boundingBox()
      if (settingsBox === null || exportBox === null) throw new Error('Header actions are not measurable.')
      expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(exportBox.x)
      expect(exportBox.x + exportBox.width).toBeLessThanOrEqual(viewport.width - 152)
    }
    await window.setViewportSize(viewports[0]!)
    await settings.evaluate((button: { click(): void }) => button.click())
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await window.getByRole('button', { name: '关闭供应商设置' }).click()

    await window.getByRole('button', { name: '返回项目库' }).click()
    const favorite = window.getByRole('button', { name: /收藏项目：未命名创作/ })
    const more = window.getByRole('button', { name: /更多项目操作：未命名创作/ })
    await expect(favorite).toBeVisible()
    await expect(more).toBeVisible()
    const favoriteBox = await favorite.boundingBox()
    const moreBox = await more.boundingBox()
    if (favoriteBox === null || moreBox === null) throw new Error('Project actions are not measurable.')
    expect(favoriteBox.x + favoriteBox.width).toBeLessThanOrEqual(moreBox.x)
    await more.click()
    const menu = window.getByRole('menu', { name: '未命名创作 项目操作' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '打开项目' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '加入收藏' })).toBeVisible()
    await menu.getByRole('menuitem', { name: '删除项目…' }).click()
    const confirmation = window.getByRole('alertdialog', { name: /移到回收站/ })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '取消' }).click()
    await expect(confirmation).toBeHidden()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
