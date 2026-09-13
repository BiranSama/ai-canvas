import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('appearance themes and glass materials apply immediately and persist across restart', async () => {
  const testInfo = test.info()
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-vt1-'))
  const captures = testInfo.outputPath()
  let app: ElectronApplication | null = null

  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    let window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '打开设置' }).evaluate((button: { click(): void }) => button.click())
    const dialog = window.getByRole('dialog', { name: '供应商设置' })
    await dialog.getByRole('button', { name: '外观', exact: true }).evaluate((button: { click(): void }) => button.click())
    await expect(dialog.getByText('工作室主题')).toBeVisible()
    await window.screenshot({ path: join(captures, 'vt1-appearance-pearl-1440x900.png') })

    await dialog.getByRole('button', { name: /夜墨/ }).evaluate((button: { click(): void }) => button.click())
    await expect(window.locator('html')).toHaveAttribute('data-appearance-theme', 'obsidian')
    await expect(window.locator('html')).toHaveAttribute('data-glass-material', 'crystal')
    await window.screenshot({ path: join(captures, 'vt1-appearance-obsidian-1440x900.png') })

    await dialog.getByRole('button', { name: /暮蓝/ }).evaluate((button: { click(): void }) => button.click())
    await dialog.getByRole('button', { name: /雾绸/ }).evaluate((button: { click(): void }) => button.click())
    await expect(window.locator('html')).toHaveAttribute('data-appearance-theme', 'dusk')
    await expect(window.locator('html')).toHaveAttribute('data-glass-material', 'satin')
    await window.setViewportSize({ width: 1024, height: 700 })
    await expect(dialog).toBeInViewport()
    await window.screenshot({ path: join(captures, 'vt1-appearance-dusk-1024x700.png') })

    await app.close()
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    window = await app.firstWindow()
    await expect(window.locator('html')).toHaveAttribute('data-appearance-theme', 'dusk')
    await expect(window.locator('html')).toHaveAttribute('data-glass-material', 'satin')
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.locator('.new-project-main').click({ force: true })
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button: { click(): void }) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的山海封面，远山在中央偏下，顶部保留轻盈标题区域，柔和雾光，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button: { click(): void }) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '画布', exact: true }).evaluate((button: { click(): void }) => button.click())
    await window.screenshot({ path: join(captures, 'vt1-canvas-dusk-satin-1440x900.png') })

    await window.getByRole('button', { name: '供应商设置' }).evaluate((button: { click(): void }) => button.click())
    const workspaceSettings = window.getByRole('dialog', { name: '供应商设置' })
    await workspaceSettings.getByRole('button', { name: '外观', exact: true }).evaluate((button: { click(): void }) => button.click())
    await workspaceSettings.getByRole('button', { name: /月白/ }).evaluate((button: { click(): void }) => button.click())
    await workspaceSettings.getByRole('button', { name: /晶澈/ }).evaluate((button: { click(): void }) => button.click())
    await workspaceSettings.locator('.appearance-advanced > summary').evaluate((summary: { click(): void }) => summary.click())
    await workspaceSettings.locator('.appearance-advanced select').first().selectOption('fine')
    await window.getByRole('button', { name: '关闭供应商设置' }).evaluate((button: { click(): void }) => button.click())
    await expect(window.locator('html')).toHaveAttribute('data-appearance-theme', 'pearl')
    await expect(window.locator('html')).toHaveAttribute('data-glass-material', 'crystal')
    expect(await window.locator('html').getAttribute('data-glass-refraction')).toMatch(/^(supported|fallback)$/)
    await window.screenshot({ path: join(captures, 'vt1-canvas-pearl-crystal-1440x900.png') })
    const externalRequests = await window.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('http://') || name.startsWith('https://')))
    expect(externalRequests).toEqual([])
  } finally {
    await app?.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
