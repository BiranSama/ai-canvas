import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generationRequestSchema } from '../../src/shared/generation'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('long failed requests stay compact and details scroll without displacing the artwork', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-error-layout-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const input = generationRequestSchema.parse({ providerId: 'mock', model: 'mock-balanced', prompt: '安静的山海海报', aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, count: 1 })
    await page.evaluate(async request => (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop.enqueueGeneration(request), input)
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect(page.getByTestId('generation-result')).toHaveCount(1, { timeout: 15000 })
    await page.evaluate(async request => (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop.enqueueGeneration(request), { ...input, model: 'mock-failure', prompt: '完整要求：山海人物、准确文字、光影与层次。'.repeat(300) })
    await expect(page.getByTestId('generation-status')).toContainText('生成失败', { timeout: 15000 })
    for (const size of [{ width: 2042, height: 1062 }, { width: 1024, height: 700 }]) {
      await page.setViewportSize(size)
      const status = page.getByTestId('generation-status')
      const details = page.locator('.generation-failure-details')
      await expect(details).not.toHaveAttribute('open', '')
      expect((await status.boundingBox())!.height).toBeLessThan(150)
      const focusBefore = (await page.locator('.result-focus').boundingBox())!
      expect(focusBefore.height).toBeGreaterThan(180)
      await expect(status.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`after-${size.width}.png`) })
      await page.getByText('查看失败详情', { exact: true }).click()
      const content = page.getByRole('region', { name: '失败详情' })
      await expect(content).toBeVisible()
      expect((await content.boundingBox())!.height).toBeLessThanOrEqual(182)
      expect(await content.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await expect(content).toContainText('完整要求：山海人物')
      await page.screenshot({ path: test.info().outputPath(`expanded-${size.width}.png`) })
      await page.getByText('查看失败详情', { exact: true }).click()
      expect((await page.locator('.result-focus').boundingBox())!.height).toBeGreaterThanOrEqual(focusBefore.height - 2)
    }
  } finally { await app.close(); await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
