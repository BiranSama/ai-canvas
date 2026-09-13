import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('Product V1 exposes editable per-task Provider boundaries without performing HTTP', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-provider-budget-'))
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    const pageErrors: string[] = []
    window.on('pageerror', (error) => pageErrors.push(error.message))
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      await api.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-budget-test-key' })
      await api.setProviderExecutionPolicy({
        approvalMode: 'confirm_each',
        autoGenerate: false,
        maxRequestsPerJob: 12,
        maxImagesPerJob: 2,
        maxCostCnyPerJob: 3
      })
    })
    await window.getByTestId('open-settings').evaluate((button) => button.click())
    const budgetCard = window.getByRole('complementary', { name: 'Provider 执行边界' })
    await expect(budgetCard.getByLabel('每任务最大请求数')).toHaveValue('12')
    await expect(budgetCard.getByLabel('每任务最大图片数')).toHaveValue('2')
    await expect(budgetCard.getByLabel('每任务预约额度')).toHaveValue('3')
    await expect(budgetCard).toContainText('价格未知时，预约不保证实际人民币扣费上限')

    const autoGenerateToggle = budgetCard.getByLabel('允许 Agent 自动发起图片任务')
    await expect(autoGenerateToggle).not.toBeChecked()
    const toggleBox = await autoGenerateToggle.boundingBox()
    expect(toggleBox).not.toBeNull()
    await window.mouse.click(toggleBox!.x + toggleBox!.width / 2, toggleBox!.y + toggleBox!.height / 2)
    expect(pageErrors).toEqual([])
    await expect(autoGenerateToggle).toBeChecked()
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await budgetCard.getByRole('button', { name: '保存执行边界' }).click({ force: true })
    await expect(window.getByTestId('provider-settings-status')).toContainText('执行边界已保存')
    expect(pageErrors).toEqual([])

    await window.getByRole('button', { name: '关闭供应商设置' }).click({ force: true })
    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await expect(window.getByRole('complementary', { name: 'Provider 执行边界' }).getByLabel('允许 Agent 自动发起图片任务')).toBeChecked()
    await window.getByRole('button', { name: '关闭供应商设置' }).click({ force: true })

    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await expect(window.getByLabel('生成供应商')).toContainText('火山方舟 · Seedream 5.0')
    await openGenerationOptions(window)
    await expect(window.getByRole('button', { name: '配置图片模型' })).toBeVisible()
    await expect(window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '多候选探索', exact: true })).toBeEnabled()
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
