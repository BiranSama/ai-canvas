import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-R2-01/02 opens from the path-free project library and keeps Glass Island layout outside Scene', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-r2-foundation-'))
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
  })
  try {
    const window = await app.firstWindow()
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })

    await expect(window.getByRole('heading', { name: '项目' })).toBeVisible()
    await expect(window.getByText('默认项目位置', { exact: true })).toBeVisible()
    await expect(window.getByText(join(userData, 'projects'), { exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: /新建项目/ }).click({ force: true })
    await expect(window.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible()

    const packages = (await readdir(join(userData, 'projects'))).filter((name) => name.endsWith('.aicanvas') && name !== 'Untitled.aicanvas')
    expect(packages).toEqual(['未命名创作.aicanvas'])
    await expect(stat(join(userData, 'projects', packages[0]!, 'project.db'))).resolves.toBeDefined()

    const initialRevision = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.revision
    })
    await expect(window.locator('[data-island-id="tools"]')).toBeVisible()
    const inspector = window.locator('[data-island-id="inspector"]')
    const composer = window.locator('[data-island-id="composer"]')
    await expect(inspector).toHaveAttribute('data-island-mode', 'docked-right')
    await expect(composer).toHaveAttribute('data-island-mode', 'floating')

    const grip = composer.getByRole('toolbar', { name: 'Agent 创作布局控制' })
    const gripBox = await grip.boundingBox()
    if (gripBox === null) throw new Error('Composer grip is not measurable.')
    const layoutBeforeDrag = await window.evaluate(() => localStorage.getItem('ai-canvas.glass-islands.v1'))
    await window.mouse.move(gripBox.x + 10, gripBox.y + 8)
    await window.mouse.down()
    await window.mouse.move(gripBox.x + 28, gripBox.y + 18, { steps: 2 })
    await expect(composer).toHaveAttribute('data-island-interacting', 'true')
    expect(await composer.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).backdropFilter ?? '')).toContain('blur(10px)')
    expect(await window.evaluate(() => localStorage.getItem('ai-canvas.glass-islands.v1'))).toBe(layoutBeforeDrag)
    await window.mouse.up()
    await expect(composer).toHaveAttribute('data-island-interacting', 'false')
    const restingFilter = await composer.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).backdropFilter ?? '')
    expect(restingFilter).toContain('blur(22px)')
    expect(restingFilter).toContain('#ai-liquid-glass-fine')
    expect(await window.evaluate(() => localStorage.getItem('ai-canvas.glass-islands.v1'))).not.toBe(layoutBeforeDrag)

    await inspector.getByRole('button', { name: '收起检查器' }).evaluate((button: { click(): void }) => button.click())
    await expect(inspector).toHaveAttribute('data-island-mode', 'orb')
    await inspector.getByRole('button', { name: '展开图层与属性' }).evaluate((button: { click(): void }) => button.click())
    await expect(inspector).toHaveAttribute('data-island-mode', 'docked-right')
    await inspector.getByRole('button', { name: '图层与属性停靠顶部' }).evaluate((button: { click(): void }) => button.click())
    await expect(inspector).toHaveAttribute('data-island-mode', 'docked-top')
    await expect(inspector).toHaveAttribute('data-island-breakpoint', 'wide')

    const finalRevision = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.revision
    })
    expect(finalRevision).toBe(initialRevision)

    await window.getByRole('button', { name: '返回项目库' }).click({ force: true })
    await expect(window.getByRole('button', { name: '打开项目：未命名创作' })).toBeVisible()
    await expect(window.getByText(/4:5/)).toBeVisible()
    await window.getByRole('button', { name: '收藏项目：未命名创作' }).evaluate((button: { click(): void }) => button.click())
    await window.getByRole('button', { name: '收藏', exact: true }).evaluate((button: { click(): void }) => button.click())
    await expect(window.getByRole('button', { name: '打开项目：未命名创作' })).toBeVisible()
    await window.getByRole('button', { name: '最近' }).evaluate((button: { click(): void }) => button.click())
    await window.getByRole('button', { name: '打开项目：未命名创作' }).click({ force: true })
    await expect(window.locator('[data-island-id="inspector"]')).toHaveAttribute('data-island-mode', 'docked-top')
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
