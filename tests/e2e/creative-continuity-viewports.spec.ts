import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const

test('continued-generation controls, artwork and lineage remain reachable across Product V1 viewports', async ({ browserName }, testInfo) => {
  void browserName
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-continuity-viewports-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '生成', exact: true }).click()
    await window.getByTestId('generation-prompt').fill('安静的植物产品海报，柔和侧光，文字只作为轻盈的层级参考')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await window.getByRole('button', { name: '继续变化' }).click()
    await window.getByRole('textbox', { name: '本次变化' }).fill('增加空气感，让光线更柔')
    await window.getByRole('textbox', { name: '保持不变' }).fill('主体身份、比例和留白')
    await window.getByRole('textbox', { name: '保持不变' }).blur()
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })
    await window.locator('[data-testid="generation-result"][data-parent-result]:not([data-parent-result=""])').click()

    for (const viewport of VIEWPORTS) {
      await window.setViewportSize(viewport)
      await expect(window.getByTestId('variation-receipt')).toBeVisible()
      const selectors = ['.generate-workspace', '.generation-results', '.result-focus', '.result-family-panel', '.result-filmstrip']
      const overflow: string[] = []
      for (const selector of selectors) {
        const bounds = await window.locator(selector).boundingBox()
        if (bounds === null) {
          overflow.push(`${selector}:missing`)
          continue
        }
        if (bounds.x < -1 || bounds.y < -1 || bounds.x + bounds.width > viewport.width + 1 || bounds.y + bounds.height > viewport.height + 1) {
          overflow.push(`${selector}:${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.x + bounds.width)},${Math.round(bounds.y + bounds.height)}`)
        }
      }
      expect(overflow, `${viewport.width}×${viewport.height} should keep the creative result workspace reachable`).toEqual([])
      await window.screenshot({
        path: testInfo.outputPath(`creative-continuity-${viewport.width}x${viewport.height}.png`),
        animations: 'disabled'
      })
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
