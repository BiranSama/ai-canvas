import { captureWorkbench } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const sizes = [{ width: 1024, height: 700 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]
const zooms = [1, 1.25, 1.5]
async function hit(target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.height).toBeGreaterThanOrEqual(39.5)
  expect(bounds!.width).toBeGreaterThanOrEqual(39.5)
  const viewport = await target.evaluate((node) => ({ width: node.ownerDocument.defaultView!.innerWidth, height: node.ownerDocument.defaultView!.innerHeight }))
  expect(bounds!.x).toBeGreaterThanOrEqual(-1)
  expect(bounds!.y).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const top = node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return node.contains(top) ? true : `${node.getAttribute('aria-label') || node.textContent} blocked by ${top?.outerHTML.slice(0, 400)}`
  })).toBe(true)
  await target.click()
}
async function facts(page: Page) {
  return page.evaluate(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, bodyWidth: document.body.clientWidth, bodyHeight: document.body.clientHeight,
    controls: [...document.querySelectorAll('button, summary, input:not([type="hidden"]), select')]
      .filter(n => n.checkVisibility()).map(n => ({ name: n.getAttribute('aria-label') || n.textContent,
        bounds: n.getBoundingClientRect().toJSON(), font: getComputedStyle(n).fontSize })),
    stage: document.querySelector('[data-testid="canvas-stage"]')?.getBoundingClientRect().toJSON(),
    focus: document.querySelector('.result-focus')?.getBoundingClientRect().toJSON() })`)
}

for (const size of sizes) for (const zoom of zooms) {
  test(`workbench paths ${size.width}x${size.height} at ${zoom * 100}% effective Electron zoom`, async () => {
    test.setTimeout(90000)
    const userData = await mkdtemp(join(tmpdir(), 'art-matrix-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __matrixRequests: number }
        scope.__matrixRequests = 0
        scope.fetch = async () => { scope.__matrixRequests++; throw new Error('OFFLINE_ART_MATRIX') }
      })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await hit(page.getByRole('button', { name: '文字 T', exact: true }))
      await hit(page.getByRole('tab', { name: '属性', exact: true }))
      await page.getByLabel('文字内容', { exact: true }).fill('山海之间')
      await page.getByLabel('文字内容', { exact: true }).blur()
      await expect.poll(() => page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene.elements.some((element) => element.type === 'text' && element.content === '山海之间'))).toBe(true)
      await hit(page.getByRole('button', { name: '生成', exact: true }))
      await page.getByTestId('generation-prompt').fill('山海之间，安静的山与海，保留轻盈留白。离线布局验收作品。')
      await hit(page.locator('.generation-options > summary'))
      await page.getByLabel('生成数量', { exact: true }).selectOption('2')
      await hit(page.getByTestId('generation-submit'))
      await expect(page.getByTestId('generation-result')).toHaveCount(2)
      await hit(page.getByRole('button', { name: '比较', exact: true }))
      await app.evaluate(({ BrowserWindow }, { size, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setContentSize(size.width, size.height)
        window.webContents.setZoomFactor(zoom)
      }, { size, zoom })
      await expect.poll(() => page.evaluate('innerWidth') as Promise<number>).toBeCloseTo(size.width / zoom, -1)
      const captures: unknown[] = []
      const compared = { A: await page.locator('.result-focus').getAttribute('data-result-a'), B: await page.locator('.result-focus').getAttribute('data-result-b') }
      for (const focus of ['对话', '画布', '生成']) {
        await hit(page.getByRole('button', { name: focus, exact: true }))
        if (focus === '对话') {
          const record = page.getByRole('button', { name: '创作记录', exact: true })
          if (await record.isVisible()) await hit(record)
          await page.getByLabel('对话输入', { exact: true }).fill('保留标题，再调整光线')
          await page.getByLabel('对话输入', { exact: true }).press('Tab')
          await expect(page.getByRole('button', { name: '发送要求', exact: true })).toBeFocused()
          const close = page.getByRole('button', { name: '返回作品', exact: true })
          if (await close.isVisible()) await hit(close)
          await expect(page.getByTestId('canvas-stage')).toBeVisible()
        }
        if (focus === '画布') {
          await hit(page.getByRole('button', { name: '选择 V', exact: true }))
          await hit(page.getByTestId('open-settings'))
          const settings = page.getByRole('dialog', { name: '供应商设置', exact: true })
          await expect(settings).toBeInViewport({ ratio: 0.99 })
          await hit(settings.getByRole('button', { name: '外观', exact: true }))
          await hit(settings.getByRole('button', { name: '关闭供应商设置', exact: true }))
          await expect(page.getByTestId('open-settings')).toBeFocused()
          await hit(page.getByRole('button', { name: '蒙版', exact: true }))
          await hit(page.getByRole('button', { name: '选择 V', exact: true }))
        }
        if (focus === '生成') {
          await hit(page.getByRole('button', { name: '操作 B', exact: true }))
          await hit(page.getByRole('button', { name: '交换 A/B', exact: true }))
          await hit(page.getByRole('button', { name: '交换 A/B', exact: true }))
          await hit(page.getByRole('button', { name: '操作 A', exact: true }))
          await expect.poll(async () => page.evaluate(async () => {
            const context = (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).workContext
            return { A: context?.generation.compareAId, B: context?.generation.compareBId }
          })).toEqual(compared)
          await hit(page.locator('.generation-compact-summary'))
          await expect(page.getByTestId('generation-prompt')).toHaveValue('山海之间，安静的山与海，保留轻盈留白。离线布局验收作品。')
          await hit(page.getByRole('button', { name: '仅文字', exact: true }))
          await hit(page.locator('.generation-compact-summary'))
        }
        captures.push({ focus, measured: await facts(page) })
        await captureWorkbench(app, test.info().outputPath(`${focus}-${size.width}x${size.height}-${zoom * 100}.png`))
      }
      await hit(page.getByRole('button', { name: '局部修改', exact: true }))
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await expect(page.getByRole('button', { name: '蒙版', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const finalScene = await page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene)
      expect(finalScene.elements.some((element) => element.type === 'image')).toBe(true)
      expect(finalScene.elements.some((element) => element.type === 'text' && element.content === '山海之间')).toBe(true)
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { __matrixRequests: number }).__matrixRequests)).toBe(0)
      await writeFile(test.info().outputPath('matrix-facts.json'), JSON.stringify({ size, zoom, userData, method: 'Electron content size and webContents.setZoomFactor; not physical Windows DPI', captures, finalScene, actualProviderRequests: 0 }, null, 2))
    } finally {
      {
        await captureWorkbench(app, test.info().outputPath('last-native.png'))
      }
      await app.close()
    }
  })
}
