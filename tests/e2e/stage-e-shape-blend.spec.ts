import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { waitForPaintedShape } from '../helpers/canvas-hit-readiness'

test('Stage E edits shapes in place and preserves controlled blend semantics offline', async ({ browserName }, testInfo) => {
  void browserName
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-stage-e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.bringToFront()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
    const stage = window.getByTestId('canvas-stage')
    await expect(stage).toBeVisible()

    await window.getByRole('button', { name: '形状', exact: true }).click()
    const shapeInfo = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const shape = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'shape')
      if (shape?.type !== 'shape') throw new Error('Shape was not created.')
      return { id: shape.id, cornerRadius: shape.cornerRadius }
    })

    const shapePoint = await waitForPaintedShape(window)
    await window.mouse.dblclick(shapePoint.x, shapePoint.y)
    const directToolbar = stage.getByRole('toolbar', { name: '形状直接编辑' })
    await expect(directToolbar).toBeVisible()
    await expect(stage).toHaveAttribute('data-shape-edit-kind', 'rectangle')
    await expect(stage).toHaveAttribute('data-shape-edit-anchors', 'top-left,top-center,top-right,middle-left,middle-right,bottom-left,bottom-center,bottom-right')

    const revisionBeforeShapeSwitch = Number(await stage.getAttribute('data-scene-revision'))
    await directToolbar.getByRole('button', { name: '椭圆', exact: true }).click()
    await expect(stage).toHaveAttribute('data-shape-edit-kind', 'ellipse')
    await expect(stage).toHaveAttribute('data-shape-edit-anchors', 'top-center,middle-left,middle-right,bottom-center')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(revisionBeforeShapeSwitch + 1)
    await window.getByLabel('撤销', { exact: true }).click()
    await expect(stage).toHaveAttribute('data-shape-edit-kind', 'rectangle')

    const radiusHandle = await window.evaluate(`(async () => {
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surface = root?.querySelector('.konvajs-content')
      const shape = (await window.desktop.getWorkspaceBootstrap()).scene.elements.find((element) => element.type === 'shape')
      if (!(root instanceof HTMLElement) || !(surface instanceof HTMLElement) || shape?.type !== 'shape') throw new Error('Radius geometry is unavailable.')
      const rect = surface.getBoundingClientRect()
      const artboardX = Number(root.dataset.artboardX)
      const artboardY = Number(root.dataset.artboardY)
      const artboardWidth = Number(root.dataset.artboardWidth)
      const artboardHeight = Number(root.dataset.artboardHeight)
      const width = shape.transform.width * artboardWidth
      const height = shape.transform.height * artboardHeight
      const radius = shape.cornerRadius * Math.min(width, height)
      return {
        x: rect.left + artboardX + shape.transform.x * artboardWidth + width - radius,
        y: rect.top + artboardY + shape.transform.y * artboardHeight + radius
      }
    })()`) as { readonly x: number; readonly y: number }
    const revisionBeforeRadius = Number(await stage.getAttribute('data-scene-revision'))
    await window.mouse.move(radiusHandle.x, radiusHandle.y)
    await window.mouse.down()
    await window.mouse.move(radiusHandle.x - 24, radiusHandle.y + 24, { steps: 5 })
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async (input) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const shape = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === input.id)
      return shape?.type === 'shape' ? shape.cornerRadius : input.cornerRadius
    }, shapeInfo)).toBeGreaterThan(shapeInfo.cornerRadius)
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(revisionBeforeRadius + 1)
    await window.getByLabel('撤销', { exact: true }).click()
    await expect.poll(async () => window.evaluate(async (input) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const shape = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === input.id)
      return shape?.type === 'shape' ? shape.cornerRadius : -1
    }, shapeInfo)).toBe(shapeInfo.cornerRadius)

    await directToolbar.getByRole('button', { name: '直线', exact: true }).click()
    await expect(stage).toHaveAttribute('data-shape-edit-kind', 'line')
    await expect(stage).toHaveAttribute('data-shape-edit-anchors', 'middle-left,middle-right')
    await expect(stage).toHaveAttribute('data-shape-line-end-x', /\d/)
    await expect(stage).toHaveAttribute('data-shape-line-end-y', /\d/)

    const lineBefore = await window.evaluate(async (id) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const shape = scene.elements.find((element) => element.id === id)
      if (shape?.type !== 'shape') throw new Error('Line disappeared.')
      return { revision: scene.revision, transform: shape.transform }
    }, shapeInfo.id)
    const stageBox = await stage.boundingBox()
    if (stageBox === null) throw new Error('Line endpoint geometry is unavailable.')
    const lineEnd = {
      x: stageBox.x + Number(await stage.getAttribute('data-shape-line-end-x')),
      y: stageBox.y + Number(await stage.getAttribute('data-shape-line-end-y'))
    }
    await window.mouse.move(lineEnd.x, lineEnd.y)
    await window.mouse.down()
    await window.mouse.move(lineEnd.x + 34, lineEnd.y - 28, { steps: 6 })
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async (input) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const shape = scene.elements.find((element) => element.id === input.id)
      return shape?.type === 'shape'
        ? { revision: scene.revision, changed: shape.transform.width !== input.width && shape.transform.rotation !== input.rotation }
        : { revision: -1, changed: false }
    }, { id: shapeInfo.id, width: lineBefore.transform.width, rotation: lineBefore.transform.rotation })).toEqual({ revision: lineBefore.revision + 1, changed: true })
    await window.getByLabel('撤销', { exact: true }).click()
    await expect.poll(async () => window.evaluate(async (input) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const shape = (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === input.id)
      return shape?.type === 'shape' ? shape.transform : null
    }, { id: shapeInfo.id, transform: lineBefore.transform })).toEqual(lineBefore.transform)
    await window.screenshot({ path: testInfo.outputPath('stage-e-line-endpoints.png') })

    await window.getByRole('tab', { name: '属性', exact: true }).click()
    const blendSelect = window.getByLabel('混合').first()
    await expect(blendSelect).toBeVisible()
    const revisionBeforeBlend = Number(await stage.getAttribute('data-scene-revision'))
    await blendSelect.selectOption('screen')
    await expect.poll(async () => window.evaluate(async (id) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === id)?.blendMode
    }, shapeInfo.id)).toBe('screen')
    await expect.poll(() => stage.evaluate((element) => Number(element.dataset.sceneRevision))).toBe(revisionBeforeBlend + 1)
    await window.getByRole('tab', { name: '图层', exact: true }).click()
    await expect(window.locator(`[data-layer-id="${shapeInfo.id}"]`)).toContainText('滤色')
    await window.screenshot({ path: testInfo.outputPath('stage-e-blend-layer.png') })
    await window.getByLabel('撤销', { exact: true }).click()
    await expect.poll(async () => window.evaluate(async (id) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === id)?.blendMode
    }, shapeInfo.id)).toBe('normal')

    await directToolbar.getByRole('button', { name: '矩形', exact: true }).click()
    await expect(stage).toHaveAttribute('data-shape-edit-kind', 'rectangle')
    await stage.focus()
    await window.keyboard.press('Enter')
    await expect(directToolbar).toHaveCount(0)
    await expect(stage).toHaveAttribute('data-shape-editing', '')

    await window.mouse.dblclick(shapePoint.x, shapePoint.y)
    await expect(directToolbar).toBeVisible()
    const beforeCancelledRadius = await window.evaluate(async (id) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const shape = scene.elements.find((element) => element.id === id)
      if (shape?.type !== 'shape') throw new Error('Shape disappeared.')
      return { revision: scene.revision, cornerRadius: shape.cornerRadius }
    }, shapeInfo.id)
    await window.mouse.move(radiusHandle.x, radiusHandle.y)
    await window.mouse.down()
    await window.mouse.move(radiusHandle.x - 18, radiusHandle.y + 18, { steps: 4 })
    await window.keyboard.press('Escape')
    await window.mouse.up()
    await expect(directToolbar).toHaveCount(0)
    await expect.poll(async () => window.evaluate(async (input) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const shape = scene.elements.find((element) => element.id === input.id)
      return { revision: scene.revision, cornerRadius: shape?.type === 'shape' ? shape.cornerRadius : -1 }
    }, { id: shapeInfo.id, ...beforeCancelledRadius })).toEqual(beforeCancelledRadius)

    await window.mouse.dblclick(shapePoint.x, shapePoint.y)
    await expect(directToolbar).toBeVisible()
    const blankPoint = await stage.evaluate((element) => {
      const surface = element.querySelector('.konvajs-content')
      if (surface === null) throw new Error('Canvas surface is unavailable.')
      const rect = surface.getBoundingClientRect()
      return {
        x: rect.left + Number(element.dataset.artboardX) + Number(element.dataset.artboardWidth) * .06,
        y: rect.top + Number(element.dataset.artboardY) + Number(element.dataset.artboardHeight) * .06
      }
    })
    await window.mouse.click(blankPoint.x, blankPoint.y)
    await expect(directToolbar).toHaveCount(0)

    await window.mouse.dblclick(shapePoint.x, shapePoint.y)
    await expect(directToolbar).toBeVisible()
    await window.evaluate("globalThis.dispatchEvent(new Event('blur'))")
    await expect(directToolbar).toHaveCount(0)

    await window.getByRole('tab', { name: '图层', exact: true }).click()
    await window.getByLabel('锁定形状', { exact: true }).click()
    await window.mouse.dblclick(shapePoint.x, shapePoint.y)
    await expect(directToolbar).toHaveCount(0)
    await expect(stage).toHaveAttribute('data-shape-editing', '')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
