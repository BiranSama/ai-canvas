import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWorkbench, hitWorkbenchControl as hit, openConversationRecord } from '../helpers/workbench-ui'
import type { DesktopApi } from '../../src/shared/desktop-api'

for (const width of [1024, 1440]) {
  test(`top inspector keeps both complexity controls fully visible with three instruments at ${width}`, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'astra-top-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_ASTRA_REVIEW') } })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, width === 1024 ? 700 : 900), width)
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await hit(page.getByRole('button', { name: '文字 T', exact: true }))
      await hit(page.getByTestId('viewport-scale'))
      const stage = page.getByTestId('canvas-stage')
      const manual = await stage.evaluate(node => ['x', 'y', 'width', 'height'].map(key => node.getAttribute(`data-artboard-${key}`)))
      const island = page.locator('[data-island-id="inspector"]')
      const grip = island.getByRole('toolbar', { name: '图层与属性布局控制', exact: true })
      await grip.focus(); await grip.press('Alt+ArrowUp')
      await expect(island).toHaveAttribute('data-island-mode', 'docked-top')
      expect(await stage.evaluate(node => ['x', 'y', 'width', 'height'].map(key => node.getAttribute(`data-artboard-${key}`)))).toEqual(manual)
      await hit(page.getByRole('tab', { name: '属性', exact: true }))
      await captureWorkbench(app, test.info().outputPath(`top-inspector-${width}.png`))
      for (const name of ['高级', '简易']) {
        const control = island.getByRole('button', { name, exact: true })
        const uncovered = await control.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return [rect.top + 2, rect.bottom - 2].every((y) => node.contains(node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, y)))
        })
        expect(uncovered, `${name} full height is visible`).toBe(true)
        await hit(control)
        await expect(control).toHaveAttribute('aria-pressed', 'true')
      }
      await hit(page.getByRole('button', { name: '适合窗口', exact: true }))
      const artboard = await stage.evaluate(node => {
        const bounds = node.getBoundingClientRect()
        const y = bounds.y + Number(node.getAttribute('data-artboard-y'))
        return { top: y, bottom: y + Number(node.getAttribute('data-artboard-height')) }
      })
      const topIsland = (await island.boundingBox())!
      const composer = (await page.locator('[data-island-id="composer"]').boundingBox())!
      expect(artboard.top).toBeGreaterThanOrEqual(topIsland.y + topIsland.height)
      expect(artboard.bottom).toBeLessThanOrEqual(composer.y)
      await captureWorkbench(app, test.info().outputPath(`top-inspector-fit-${width}.png`))
    } finally { await app.close() }
  })
}

for (const width of [1024, 1440]) for (const choice of ['执行这一步', '先停在这里', '停止当前操作']) {
  test(`decision choice ${choice} is readable and genuinely executes at ${width}`, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'astra-decision-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_ASTRA_REVIEW') } })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, width === 1024 ? 700 : 900), width)
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await hit(page.getByRole('button', { name: '对话', exact: true }))
      await openConversationRecord(page)
      await hit(page.getByRole('group', { name: 'Agent 模式' }).getByRole('button', { name: '审阅', exact: true }))
      await page.getByLabel('对话输入', { exact: true }).fill('创建一张4:5的山海海报，标题为山海之间，先不要生成图片。')
      await hit(page.getByRole('button', { name: '发送要求', exact: true }))
      const card = page.getByRole('group', { name: '先确认这项修改' })
      await expect(card).toBeVisible()
      const buttons = card.getByRole('button')
      await expect(buttons).toHaveCount(3)
      const cardBox = (await card.boundingBox())!
      for (const button of await buttons.all()) {
        const rect = (await button.boundingBox())!
        expect(rect.x).toBeGreaterThanOrEqual(cardBox.x)
        expect(rect.x + rect.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
      }
      expect(await card.locator('.decision-options small').first().evaluate(node => Number.parseFloat(node.ownerDocument.defaultView!.getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12)
      await captureWorkbench(app, test.info().outputPath(`decision-${width}.png`))
      await hit(card.getByRole('button', { name: choice, exact: true }))
      await expect(card).toBeHidden()
      await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene.revision).toBe(choice === '执行这一步' ? 1 : 0)
      expect(await page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()).length)).toBe(0)
    } finally { await app.close() }
  })
}

test('manual obsidian solid material keeps result action labels readable', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'astra-solid-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  try {
    await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_ASTRA_REVIEW') } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1920, 1080))
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.setAppearanceSettings({ theme: 'obsidian', glassMaterial: 'solid', motion: 'reduced', opticalQuality: 'balanced', sceneReflection: 'artwork' }))
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'solid')
    await hit(page.getByRole('button', { name: '生成', exact: true }))
    await page.getByTestId('generation-prompt').fill('一张安静的山海作品')
    await hit(page.getByTestId('generation-submit'))
    await expect(page.getByTestId('generation-result')).toHaveCount(1)
    const actions = page.locator('.result-actions')
    const colors = await actions.evaluate(node => {
      const style = node.ownerDocument.defaultView!.getComputedStyle(node)
      return { background: style.backgroundColor, expected: style.getPropertyValue('--solid-surface').trim() }
    })
    const luminance = (color: string): number => {
      const values = color.startsWith('#') ? color.slice(1).match(/.{2}/g)!.map(value => Number.parseInt(value, 16)) : color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      return values.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    }
    expect(luminance(colors.background)).toBeLessThan(.1)
    for (const button of await actions.getByRole('button').all()) {
      if (!await button.isVisible()) continue
      const text = await button.evaluate(node => node.ownerDocument.defaultView!.getComputedStyle(node).color)
      // Primary actions have their own pale button fill; secondary labels sit on the solid tray.
      if (await button.getAttribute('data-testid') === 'insert-generation-result') continue
      const contrast = (Math.max(luminance(text), luminance(colors.background)) + .05) / (Math.min(luminance(text), luminance(colors.background)) + .05)
      expect(contrast, await button.textContent() ?? 'action').toBeGreaterThanOrEqual(4.5)
    }
    await captureWorkbench(app, test.info().outputPath('obsidian-solid-results.png'))
  } finally { await app.close() }
})

test('view controls yield to a composer docked at each edge in a small window', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'astra-status-dock-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  try {
    await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_ASTRA_REVIEW') } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700))
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    for (const direction of ['Down', 'Right', 'Up', 'Left']) {
      const grip = page.locator('[data-island-id="composer"]').getByRole('toolbar', { name: 'Agent 创作布局控制', exact: true })
      await grip.focus(); await grip.press(`Alt+Arrow${direction}`)
      await hit(page.getByRole('button', { name: '适合窗口', exact: true }))
      await hit(page.getByRole('button', { name: '进入专注', exact: true }))
      await hit(page.getByRole('button', { name: '退出专注', exact: true }))
      await captureWorkbench(app, test.info().outputPath(`status-composer-${direction}.png`))
      await hit(page.getByRole('button', { name: '还原工具布局', exact: true }))
    }
  } finally { await app.close() }
})

for (const viewport of [{ width: 1024, height: 700, zoom: 1 }, { width: 1440, height: 900, zoom: 1 }, { width: 1024, height: 700, zoom: 1.25 }, { width: 1024, height: 700, zoom: 1.5 }]) {
  test(`default view controls remain reachable at ${viewport.width} / ${viewport.zoom}`, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'astra-status-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_ASTRA_REVIEW') } })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom)
      }, viewport)
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      const scene = (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene
      for (const name of ['适合窗口', '缩小画布', '放大画布']) await hit(page.getByRole('button', { name, exact: true }))
      const slider = page.getByRole('slider', { name: '画布缩放比例' })
      await hit(slider)
      await slider.press('ArrowRight')
      await hit(page.getByTestId('viewport-scale'))
      await expect(page.getByTestId('viewport-scale')).toHaveText('100%')
      await hit(page.getByRole('button', { name: '进入专注', exact: true }))
      await hit(page.getByRole('button', { name: '退出专注', exact: true }))
      await hit(page.getByRole('button', { name: '还原工具布局', exact: true }))
      await hit(page.getByRole('button', { name: '适合窗口', exact: true }))
      await page.getByRole('button', { name: '适合窗口', exact: true }).focus()
      for (const name of ['缩小画布', '画布缩放比例', '放大画布']) {
        await page.keyboard.press('Tab')
        await expect(page.getByLabel(name, { exact: true })).toBeFocused()
      }
      await page.keyboard.press('Tab'); await expect(page.getByTestId('viewport-scale')).toBeFocused()
      await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '进入专注', exact: true })).toBeFocused()
      await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '还原工具布局', exact: true })).toBeFocused()
      expect((await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene).toEqual(scene)
      await captureWorkbench(app, test.info().outputPath(`status-${viewport.width}-${viewport.zoom}.png`))
    } finally { await app.close() }
  })
}
