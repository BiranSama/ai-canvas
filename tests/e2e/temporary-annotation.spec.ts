import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-R2-06 keeps one-turn annotation transient, clears the next turn, and explicitly saves in one undo', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-annotation-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    const before = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return api.getWorkspaceBootstrap()
    })

    await window.getByRole('button', { name: '临时标注', exact: true }).evaluate((button) => button.click())
    await expect(window.getByText('仅本轮 · 画布空间')).toBeVisible()
    const preview = window.locator('.conversation-live-canvas')
    const box = await preview.boundingBox()
    if (box === null) throw new Error('Conversation preview is unavailable.')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    const points = [
      { x: centerX - 58, y: centerY - 46 },
      { x: centerX + 55, y: centerY - 38 },
      { x: centerX + 48, y: centerY + 54 },
      { x: centerX - 50, y: centerY + 44 },
      { x: centerX - 58, y: centerY - 46 }
    ]
    await preview.locator('.konvajs-content').evaluate((surface, path) => {
      const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (
        type: string,
        init: unknown
      ) => Parameters<typeof surface.dispatchEvent>[0]
      surface.dispatchEvent(new BrowserMouseEvent('mousedown', { bubbles: true, clientX: path[0]!.x, clientY: path[0]!.y, button: 0, buttons: 1 }))
      for (const point of path.slice(1)) {
        surface.dispatchEvent(new BrowserMouseEvent('mousemove', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, buttons: 1 }))
      }
      const last = path.at(-1)!
      surface.dispatchEvent(new BrowserMouseEvent('mouseup', { bubbles: true, clientX: last.x, clientY: last.y, button: 0, buttons: 0 }))
    }, points)
    await expect(window.getByRole('button', { name: '清除临时标注' })).toBeVisible()

    await window.getByRole('textbox', { name: '对话输入' }).fill('请记住这个圈选区域，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByText('本轮临时圈选')).toBeVisible({ timeout: 10_000 })
    await expect(window.getByRole('button', { name: '临时标注', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(window.getByRole('button', { name: '清除临时标注' })).toHaveCount(0)

    const after = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, conversation, jobs] = await Promise.all([
        api.getWorkspaceBootstrap(),
        api.getConversationSnapshot(),
        api.listGenerationJobs()
      ])
      return { bootstrap, conversation, jobs }
    })
    expect(after.bootstrap.scene.revision).toBe(before.scene.revision)
    expect(after.bootstrap.scene.elements.some((element) => element.type === 'mask')).toBe(false)
    expect(after.conversation.messages[0]?.attachments).toContainEqual(expect.objectContaining({ name: '本轮临时圈选' }))
    expect(after.jobs).toHaveLength(0)

    await window.getByRole('button', { name: '临时标注', exact: true }).evaluate((button) => button.click())
    await preview.locator('.konvajs-content').evaluate((surface, path) => {
      const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (type: string, init: unknown) => Parameters<typeof surface.dispatchEvent>[0]
      surface.dispatchEvent(new BrowserMouseEvent('mousedown', { bubbles: true, clientX: path[0]!.x, clientY: path[0]!.y, button: 0, buttons: 1 }))
      for (const point of path.slice(1)) surface.dispatchEvent(new BrowserMouseEvent('mousemove', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, buttons: 1 }))
      const last = path.at(-1)!
      surface.dispatchEvent(new BrowserMouseEvent('mouseup', { bubbles: true, clientX: last.x, clientY: last.y, button: 0, buttons: 0 }))
    }, points)
    await window.getByRole('button', { name: '保存为草图' }).evaluate((button) => button.click())
    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      return bootstrap.scene.elements.filter((element) => element.type === 'sketch' && element.name === '对话标注草图').length
    }).toBe(1)
    await expect(window.getByRole('button', { name: '撤销' })).toBeEnabled()
    await window.getByRole('button', { name: '撤销' }).evaluate((button) => button.click())
    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      return bootstrap.scene.elements.filter((element) => element.type === 'sketch' && element.name === '对话标注草图').length
    }).toBe(0)

    await window.getByRole('button', { name: '临时标注', exact: true }).evaluate((button) => button.click())
    await preview.locator('.konvajs-content').evaluate((surface, path) => {
      const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (type: string, init: unknown) => Parameters<typeof surface.dispatchEvent>[0]
      surface.dispatchEvent(new BrowserMouseEvent('mousedown', { bubbles: true, clientX: path[0]!.x, clientY: path[0]!.y, button: 0, buttons: 1 }))
      for (const point of path.slice(1)) surface.dispatchEvent(new BrowserMouseEvent('mousemove', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, buttons: 1 }))
      surface.dispatchEvent(new BrowserMouseEvent('mouseup', { bubbles: true, clientX: path.at(-1)!.x, clientY: path.at(-1)!.y, button: 0, buttons: 0 }))
    }, points)
    await window.getByRole('button', { name: /项目菜单：/ }).evaluate((button) => button.click())
    await window.getByRole('menuitem', { name: '新建空白项目' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '临时标注', exact: true })).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('AC-R2-06 retains a failed edit annotation and retries the exact request safely', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-annotation-retry-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('agent:start')!
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', (event, input: unknown) => {
        Object.assign(globalThis, { __annotationInput: input })
        return original(event, input)
      })
    })
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('Source image for transient annotation retry')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.some((element) => element.type === 'image')
    })).toBe(true)
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    const sourceScene = await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '临时标注', exact: true }).evaluate((button) => button.click())
    await expect(window.getByText(/仅本轮 · (生成结果 \d+|导入图片)/)).toBeVisible()
    const preview = window.locator('.conversation-live-canvas')
    await window.getByRole('button', { name: '矩形', exact: true }).click()
    await window.bringToFront()
    await window.screenshot()
    const annotation = preview.getByTestId('canvas-stage')
    const box = await preview.locator('.konvajs-content').boundingBox()
    if (box === null) throw new Error('Conversation preview is unavailable.')
    const geometry = {
      x: Number(await annotation.getAttribute('data-artboard-x')),
      y: Number(await annotation.getAttribute('data-artboard-y')),
      width: Number(await annotation.getAttribute('data-artboard-width')),
      height: Number(await annotation.getAttribute('data-artboard-height'))
    }
    const path = [
      { x: box.x + geometry.x + geometry.width * .32, y: box.y + geometry.y + geometry.height * .32 },
      { x: box.x + geometry.x + geometry.width * .68, y: box.y + geometry.y + geometry.height * .66 }
    ]
    await window.mouse.move(path[0]!.x, path[0]!.y)
    await window.mouse.down()
    await window.mouse.move(path[1]!.x, path[1]!.y, { steps: 6 })
    await window.mouse.up()
    await expect(window.getByText(/仅本轮 .* 1 区/)).toBeVisible()
    expect((await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene).toEqual(sourceScene.scene)
    const originalRequirement = '[模拟失败] 把这里局部改成柔和的蓝色玻璃花朵'
    await window.getByRole('textbox', { name: '对话输入' }).fill(originalRequirement)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByText('已保留，可继续')).toBeVisible({ timeout: 15_000 })
    await writeFile(test.info().outputPath('annotation-input-facts.json'), JSON.stringify({
      input: await app.evaluate(() => Reflect.get(globalThis, '__annotationInput')),
      scene: await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()),
      geometry, path
    }, null, 2))
    await expect(window.getByText(originalRequirement)).toBeVisible()
    const failedJobs = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.listGenerationJobs())
    await writeFile(test.info().outputPath('annotation-failure-facts.json'), JSON.stringify({ jobs: failedJobs, conversation: await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getConversationSnapshot()), ui: await window.locator('body').innerText() }, null, 2))
    expect(failedJobs.find((job) => job.request.prompt === originalRequirement)).toMatchObject({ status: 'failed', request: { kind: 'edit', prompt: originalRequirement } })
    const failed = failedJobs.find((job) => job.request.prompt === originalRequirement)!
    await window.getByRole('button', { name: '原样重试' }).click()
    await expect.poll(async () => {
      const jobs = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.listGenerationJobs())
      return jobs.find((job) => job.request.prompt === originalRequirement && job.status === 'completed')?.status
    }, { timeout: 15_000 }).toBe('completed')
    const retried = (await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())).find((job) => job.parentJobId === failed.id)!
    expect(retried).toMatchObject({ status: 'completed', parentJobId: failed.id, request: { kind: 'edit', prompt: originalRequirement } })
    expect(retried.request).toMatchObject({ maskAssetId: Reflect.get(failed.request, 'maskAssetId'), sourceAssetId: Reflect.get(failed.request, 'sourceAssetId') })
    await expect(window.getByRole('button', { name: '临时标注', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const after = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
    expect(after.scene.elements.some((element) => element.type === 'mask')).toBe(false)

    await window.getByRole('button', { name: '临时标注', exact: true }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '临时标注', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await window.getByRole('button', { name: '矩形', exact: true }).click()
    const annotationSurface = preview.locator('.konvajs-content')
    const currentBox = await annotationSurface.boundingBox()
    if (currentBox === null) throw new Error('Conversation annotation surface is unavailable after retry.')
    const annotationStage = preview.getByTestId('canvas-stage')
    const artboard = {
      x: Number(await annotationStage.getAttribute('data-artboard-x')),
      y: Number(await annotationStage.getAttribute('data-artboard-y')),
      width: Number(await annotationStage.getAttribute('data-artboard-width')),
      height: Number(await annotationStage.getAttribute('data-artboard-height'))
    }
    const currentPath = [
      { x: currentBox.x + artboard.x + artboard.width * .32, y: currentBox.y + artboard.y + artboard.height * .32 },
      { x: currentBox.x + artboard.x + artboard.width * .68, y: currentBox.y + artboard.y + artboard.height * .32 },
      { x: currentBox.x + artboard.x + artboard.width * .66, y: currentBox.y + artboard.y + artboard.height * .66 },
      { x: currentBox.x + artboard.x + artboard.width * .34, y: currentBox.y + artboard.y + artboard.height * .62 }
    ]
    await window.mouse.move(currentPath[0]!.x, currentPath[0]!.y)
    await window.mouse.down()
    await window.mouse.move(currentPath[2]!.x, currentPath[2]!.y, { steps: 6 })
    await window.mouse.up()
    await expect(window.getByText(/仅本轮 .* 1 区/)).toBeVisible()
    await window.getByRole('button', { name: '保存为蒙版' }).click()
    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      return bootstrap.scene.elements.filter((element) => element.type === 'mask').length
    }).toBe(1)
    await window.getByRole('button', { name: '撤销' }).evaluate((button) => button.click())
    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      return bootstrap.scene.elements.filter((element) => element.type === 'mask').length
    }).toBe(0)
  } finally {
    const window = await app.firstWindow()
    await writeFile(test.info().outputPath('annotation-final-facts.json'), JSON.stringify({
      jobs: await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()),
      harness: await window.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot()),
      ui: await window.locator('body').innerText()
    }, null, 2))
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
