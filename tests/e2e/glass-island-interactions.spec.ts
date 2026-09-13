import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function dragGripTo(window: Page, islandId: 'tools' | 'inspector' | 'composer', x: number, y: number): Promise<void> {
  const island = window.locator(`[data-island-id="${islandId}"]`)
  const grip = island.getByRole('toolbar', { name: /布局控制/ })
  const box = await grip.boundingBox()
  if (box === null) throw new Error(`${islandId} grip is not measurable.`)
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(x, y)
  await window.mouse.up()
}

test('Glass Islands use real pointer interactions for resize, four-edge docking, orb reload and clicks', async () => {
  test.setTimeout(150_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-glass-islands-'))
  let app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
  })
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: '项目' })).toBeVisible()
    await window.getByRole('button', { name: /新建项目/ }).click({ force: true })
    await expect(window.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible()

    const workspace = window.locator('.canvas-workspace')
    const workspaceBox = await workspace.boundingBox()
    if (workspaceBox === null) throw new Error('Canvas workspace is not measurable.')

    const composer = window.locator('[data-island-id="composer"]')
    const stage = window.getByTestId('canvas-stage')
    const artboardBefore = {
      x: Number(await stage.getAttribute('data-artboard-x')),
      y: Number(await stage.getAttribute('data-artboard-y')),
      width: Number(await stage.getAttribute('data-artboard-width')),
      height: Number(await stage.getAttribute('data-artboard-height'))
    }
    const composerBeforeResize = await composer.boundingBox()
    const composerResize = composer.getByRole('separator', { name: '调整Agent 创作大小' })
    const composerResizeBox = await composerResize.boundingBox()
    if (composerBeforeResize === null || composerResizeBox === null) throw new Error('Composer resize geometry is not measurable.')
    await window.mouse.move(composerResizeBox.x + composerResizeBox.width / 2, composerResizeBox.y + composerResizeBox.height / 2)
    await window.mouse.down()
    await window.mouse.move(composerResizeBox.x + 82, composerResizeBox.y + 42)
    await window.mouse.up()
    const composerAfterResize = await composer.boundingBox()
    expect(composerAfterResize?.width).toBeGreaterThan((composerBeforeResize?.width ?? 0) + 50)
    expect(composerAfterResize?.height).toBeGreaterThan((composerBeforeResize?.height ?? 0) + 20)
    expect({
      x: Number(await stage.getAttribute('data-artboard-x')),
      y: Number(await stage.getAttribute('data-artboard-y')),
      width: Number(await stage.getAttribute('data-artboard-width')),
      height: Number(await stage.getAttribute('data-artboard-height'))
    }).toEqual(artboardBefore)

    await dragGripTo(window, 'composer', workspaceBox.x + 4, workspaceBox.y + workspaceBox.height / 2)
    await expect(composer).toHaveAttribute('data-island-mode', 'docked-left')
    await dragGripTo(window, 'composer', workspaceBox.x + workspaceBox.width - 4, workspaceBox.y + workspaceBox.height / 2)
    await expect(composer).toHaveAttribute('data-island-mode', 'docked-right')
    await dragGripTo(window, 'composer', workspaceBox.x + workspaceBox.width / 2, workspaceBox.y + 4)
    await expect(composer).toHaveAttribute('data-island-mode', 'docked-top')
    await dragGripTo(window, 'composer', workspaceBox.x + workspaceBox.width / 2, workspaceBox.y + workspaceBox.height - 4)
    await expect(composer).toHaveAttribute('data-island-mode', 'docked-bottom')

    const tools = window.locator('[data-island-id="tools"]')
    const toolsBeforeResize = await tools.boundingBox()
    const toolsResize = tools.getByRole('separator', { name: '调整画布工具大小' })
    await expect(toolsResize).toBeVisible()
    const toolsResizeBox = await toolsResize.boundingBox()
    if (toolsBeforeResize === null || toolsResizeBox === null) throw new Error('Tools resize geometry is not measurable.')
    await window.mouse.move(toolsResizeBox.x + toolsResizeBox.width / 2, toolsResizeBox.y + toolsResizeBox.height / 2)
    await window.mouse.down()
    await window.mouse.move(toolsResizeBox.x + 270, toolsResizeBox.y)
    await window.mouse.up()
    await expect.poll(async () => (await tools.boundingBox())?.width ?? 0).toBeGreaterThan(280)
    expect(await tools.getAttribute('data-island-breakpoint')).toBe('standard')
    expect(await tools.locator('.canvas-toolbar').evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).flexDirection ?? '')).toBe('row')
    const textTool = tools.getByRole('button', { name: '文字 T' })
    const textToolBox = await textTool.boundingBox()
    if (textToolBox === null) throw new Error('Text tool is not measurable after resizing the tools island.')
    await window.mouse.move(textToolBox.x + textToolBox.width / 2, textToolBox.y + textToolBox.height / 2)
    await window.mouse.down()
    await window.mouse.up()
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.some((element) => element.type === 'text')
    })).toBe(true)

    const inspector = window.locator('[data-island-id="inspector"]')
    await expect(inspector.getByRole('separator', { name: '调整图层与属性大小' })).toBeVisible()
    await inspector.getByRole('toolbar', { name: '图层与属性布局控制' }).hover({ force: true })
    await inspector.getByRole('button', { name: '收起图层与属性为圆球' }).click({ force: true })
    await expect(inspector).toHaveAttribute('data-island-mode', 'orb')
    await app.close()
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    const restoredWindow = await app.firstWindow()
    await expect(restoredWindow.getByRole('heading', { name: '项目' })).toBeVisible()
    await restoredWindow.getByRole('button', { name: '打开项目：未命名创作' }).click({ force: true })
    await expect(restoredWindow.locator('[data-island-id="inspector"]')).toHaveAttribute('data-island-mode', 'orb')
    const reloadedOrb = restoredWindow.locator('[data-island-id="inspector"]')
    await expect.poll(async () => {
      const box = await reloadedOrb.boundingBox()
      return box === null ? null : { width: Math.round(box.width), height: Math.round(box.height) }
    }).toEqual({ width: 58, height: 58 })
    const orbBox = await reloadedOrb.boundingBox()
    if (orbBox === null) throw new Error('Reloaded inspector orb is not measurable.')
    await restoredWindow.mouse.move(orbBox.x + orbBox.width / 2, orbBox.y + orbBox.height / 2)
    await restoredWindow.mouse.down()
    await restoredWindow.mouse.up()
    await expect(reloadedOrb).not.toHaveAttribute('data-island-mode', 'orb')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
