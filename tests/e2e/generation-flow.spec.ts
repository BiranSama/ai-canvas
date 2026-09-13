import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

function listJobs(page: Page) {
  return page.evaluate(() => {
    const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
    return renderer.desktop.listGenerationJobs()
  })
}

test('completes the persistent Mock generation flow and places a result on canvas', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-generation-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.locator('.view-switcher button').nth(2).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-submit')).toBeVisible()
    await expect(window.locator('.provider-boundary')).toContainText('本地离线档不联网')
    await openGenerationOptions(window)
    await expect(window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '本地草图' })).toBeEnabled()
    await expect(window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '本地定稿预演' })).toBeEnabled()

    await window.getByTestId('generation-prompt').fill('Rainy-night vinyl record, cool rim light, quiet editorial composition')
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('2')
    await window.locator('.view-switcher button').nth(1).evaluate((button) => button.click())
    await window.locator('.view-switcher button').nth(2).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-prompt')).toHaveValue('Rainy-night vinyl record, cool rim light, quiet editorial composition')
    await expect(window.getByLabel('生成数量')).toHaveValue('2')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-status')).toBeVisible()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })

    const completed = await listJobs(window)
    expect(completed[0]).toMatchObject({
      providerId: 'mock',
      model: 'mock-balanced',
      status: 'completed',
      request: { parameters: { generationProfileId: 'local-sketch', actualCostCny: 0 } },
      results: [{ variantIndex: 0 }, { variantIndex: 1 }]
    })

    await window.getByTestId('generation-result').first().evaluate((button) => button.click())
    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByRole('option')).toHaveCount(1)

    await window.locator('.view-switcher button').nth(2).evaluate((button) => button.click())
    await window.getByRole('button', { name: /展开参数/ }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByLabel('模型情景').selectOption('mock-failure')
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('1')
    await window.getByTestId('generation-prompt').fill('故障与重试流程验证')
    await window.getByTestId('generation-submit').click()
    await expect.poll(async () => (await listJobs(window))[0]?.status).toBe('failed')
    await expect(window.getByTestId('generation-status')).toContainText('离线失败状态验证已触发')
    await expect(window.getByTestId('generation-result')).toHaveCount(2)

    await window.getByRole('button', { name: /展开参数/ }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByLabel('模型情景').selectOption('mock-balanced')
    await window.getByTestId('generation-status').getByRole('button').evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window))[0]?.status).toBe('completed')
    const retried = await listJobs(window)
    expect(retried[0]).toMatchObject({ parentJobId: retried[1]?.id, attempt: 2, status: 'completed', model: 'mock-balanced' })

    await openGenerationOptions(window)
    await window.getByLabel('模型情景').selectOption('mock-slow')
    await window.getByTestId('generation-submit').click()
    await expect.poll(async () => (await listJobs(window))[0]?.status).toMatch(/preparing|generating/)
    await window.getByTestId('generation-status').getByRole('button').evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window))[0]?.status).toBe('cancelled')
    await expect(window.getByTestId('generation-prompt')).toHaveValue('故障与重试流程验证')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
