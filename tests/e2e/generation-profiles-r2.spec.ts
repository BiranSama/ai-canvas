import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

function listJobs(page: Page) {
  return page.evaluate(() => (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop.listGenerationJobs())
}

test('AC-R2-04/08/09 runs draft and confirmed final simulations with profile provenance and zero external requests', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-profiles-'))
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    window.on('request', (request) => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
    await window.waitForLoadState('domcontentloaded')
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    const profiles = window.getByRole('group', { name: '生成档位' })

    await profiles.getByRole('button', { name: '本地草稿' }).evaluate((button) => button.click())
    await expect(window.getByLabel('生成数量')).toHaveValue('4')
    await window.getByTestId('generation-prompt').fill('A restrained architectural editorial, warm paper, precise shadows')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(4, { timeout: 15_000 })
    await expect(window.getByLabel('结果胶片条').getByRole('button')).toHaveCount(4)
    await window.getByRole('button', { name: '比较' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '结束比较' })).toBeVisible()
    await window.getByRole('button', { name: '结束比较' }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '继续变化' }).evaluate((button) => button.click())
    await expect(window.getByText(/从版本 .* 继续/)).toBeVisible()
    await window.getByRole('textbox', { name: '本次变化' }).fill('让阴影更柔和')
    await window.getByRole('textbox', { name: '本次变化' }).blur()

    await profiles.getByRole('button', { name: '本地定稿预演' }).evaluate((button) => button.click())
    await expect(window.getByLabel('生成数量')).toHaveValue('2')
    await window.getByTestId('generation-submit').click()
    const confirmation = window.getByRole('alertdialog', { name: '确认生成' })
    await expect(confirmation).toContainText('离线模拟，¥0.00')
    expect(await listJobs(window)).toHaveLength(1)
    await confirmation.getByRole('button', { name: '确认生成' }).evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window)).find((job) => job.request.parameters['generationProfileId'] === 'mock-final')?.status, { timeout: 15_000 }).toBe('completed')
    const jobs = await listJobs(window)
    expect(jobs[0]).toMatchObject({
      status: 'completed',
      request: { parentResultId: expect.any(String), parameters: { generationProfileId: 'mock-final', simulatedEstimatedCostCny: .44, actualCostCny: 0 } }
    })
    expect(jobs[0]?.results).toHaveLength(2)

    const family = window.getByTestId('result-family-summary')
    await expect(family).toContainText('3 个版本')
    await family.getByRole('button', { name: /结果家族/ }).evaluate((button) => button.click())
    await expect(family.locator('.result-family-detail')).toBeVisible()
    await expect(family.getByRole('listitem')).toHaveCount(3)
    await expect(family.locator('.result-provenance')).toContainText(/档位|模型|Scene|回执/)

    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await window.getByRole('button', { name: '生成档位' }).evaluate((button) => button.click())
    await expect(window.locator('[data-profile-id]')).toHaveCount(6)
    await expect(window.locator('[data-profile-id="configured-final"]')).toContainText('可用 · 费用未知；有可靠回执时显示实际金额')
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
