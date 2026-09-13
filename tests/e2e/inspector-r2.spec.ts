import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('AC-R2-03 projects typed simple properties and the same data into horizontal docking', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-r2-inspector-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--force-device-scale-factor=1.5'],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1', AI_CANVAS_STARTUP: 'workspace' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1024, height: 700 })
    await window.getByRole('button', { name: '文字 T', exact: true }).evaluate((button: { click(): void }) => button.click())
    await window.getByRole('tab', { name: /属性/ }).evaluate((button: { click(): void }) => button.click())
    const panel = window.locator('.properties-panel')
    await expect(panel).toHaveAttribute('data-simple-field-count', '7')
    await expect(panel.getByLabel('文字内容')).toBeVisible()
    await panel.getByLabel('文字内容').fill('雨 后')
    await panel.getByLabel('字号').fill('88')

    const inspector = window.locator('[data-island-id="inspector"]')
    await inspector.getByRole('button', { name: '图层与属性停靠顶部' }).evaluate((button: { click(): void }) => button.click())
    await expect(inspector).toHaveAttribute('data-island-mode', 'docked-top')
    await expect(inspector.locator('[data-inspector-projection="horizontal"]')).toBeVisible()
    await expect(inspector.getByLabel('文字内容')).toHaveValue('雨 后')
    await expect(inspector.getByLabel('字号')).toHaveValue('88')

    await inspector.getByRole('button', { name: '高级', exact: true }).evaluate((button: { click(): void }) => button.click())
    await expect(inspector.getByLabel('搜索高级属性')).toBeVisible()
    await inspector.getByLabel('搜索高级属性').fill('阴影')
    await expect(inspector.locator('summary', { hasText: '描边与阴影' })).toBeVisible()
    await expect(inspector.locator('summary', { hasText: '排版' })).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
