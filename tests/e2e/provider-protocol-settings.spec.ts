import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Provider settings make protocol routing and the real connection confirmation explicit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-provider-protocol-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.getByTestId('open-settings').evaluate((button) => button.click())
    const dialog = window.getByRole('dialog', { name: '供应商设置' })
    await expect(dialog).toBeVisible()
    const llmRow = dialog.locator('.provider-setting-row').filter({ hasText: 'Seed 2.1 Turbo' })
    await llmRow.getByRole('button', { name: '编辑' }).evaluate((button) => button.click())

    await dialog.getByLabel('LLM Provider 调用协议').selectOption('openai-chat-completions')
    await dialog.getByLabel('LLM Provider API 地址').fill('https://llm.example.test/v1')
    await dialog.getByLabel('LLM Provider 默认模型').fill('fixture-tool-model')
    await dialog.getByLabel('LLM Provider 思考强度').selectOption('high')
    await expect(dialog.getByLabel('LLM Provider 图像细节')).toBeEnabled()
    await dialog.getByLabel('LLM Provider 图像细节').selectOption('low')
    await dialog.getByLabel('LLM Provider 输出上限').fill('8192')
    await expect(llmRow.getByLabel('LLM Provider 能力').getByText('图像理解')).toBeVisible()
    await expect(llmRow.locator('.provider-resolved-endpoint')).toContainText('https://llm.example.test/v1/chat/completions')
    await llmRow.getByRole('button', { name: '保存公开配置', exact: true }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('未发起网络请求')

    const keyInput = dialog.getByLabel('火山方舟 · Seed 2.1 Turbo API Key')
    await keyInput.fill('fixture-never-send-key')
    await llmRow.getByRole('button', { name: '安全保存 火山方舟 · Seed 2.1 Turbo 凭据' }).evaluate((button) => button.click())
    const validateButton = llmRow.getByRole('button', { name: '验证工具调用', exact: true })
    await expect(validateButton).toBeEnabled()
    await validateButton.evaluate((button) => button.click())

    const confirmation = llmRow.locator('.provider-connection-confirm')
    await expect(confirmation).toContainText('1 个真实文字请求')
    await expect(confirmation).toContainText('不生成图片')
    await expect(confirmation).toContainText('不会自动重试')
    await expect(confirmation.getByRole('button', { name: '确认验证' })).toBeVisible()
    await confirmation.getByRole('button', { name: '取消' }).evaluate((button) => button.click())
    await expect(confirmation).toHaveCount(0)
    await expect(access(join(userData, 'security', 'provider-usage.json'))).rejects.toThrow()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the image module freely configures an explicit protocol and opens directly from Generate', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-image-protocol-'))
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByRole('button', { name: '配置图片模型' }).click()

    const dialog = window.getByRole('dialog', { name: '供应商设置' })
    const imageRow = dialog.locator('[data-provider-slot="image"]')
    await expect(imageRow).toBeVisible()
    await expect(imageRow.getByLabel('Image Provider 调用协议')).toBeVisible()
    await imageRow.getByLabel('Image Provider 名称').fill('Owner Image Relay')
    await imageRow.getByLabel('Image Provider 调用协议').selectOption('openai-images')
    await imageRow.getByLabel('Image Provider API 地址').fill('https://images.example.test/v1')
    await imageRow.getByLabel('Image Provider 默认模型').fill('owner-image-model')
    await expect(imageRow.locator('.provider-resolved-endpoint')).toContainText('https://images.example.test/v1/images/generations')
    await expect(imageRow.locator('.provider-resolved-endpoint')).toContainText('https://images.example.test/v1/images/edits')
    await imageRow.getByRole('button', { name: '保存公开配置', exact: true }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('未发起网络请求')
    const imageKey = imageRow.getByLabel('Owner Image Relay API Key')
    await imageKey.fill('synthetic-owner-image-key')
    await imageRow.getByRole('button', { name: '安全保存 Owner Image Relay 凭据' }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('界面不会再次显示密钥')
    await dialog.getByRole('button', { name: '关闭供应商设置' }).evaluate((button) => button.click())
    await expect(window.getByLabel('生成供应商')).toContainText('Owner Image Relay')
    await expect(window.getByLabel('生成供应商')).toContainText('owner-image-model')
    await expect(window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '多候选探索', exact: true })).toHaveClass(/is-active/)
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
