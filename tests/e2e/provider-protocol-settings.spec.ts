import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

interface ConnectionCheckFacts {
  posts: number
  fail: boolean
  requests: Array<{ stream: boolean; temperature: boolean; reasoning: unknown }>
}

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
    const dialog = window.getByRole('dialog', { name: '设置', exact: true })
    await expect(dialog).toBeVisible()
    const llmRow = dialog.locator('.provider-setting-row').filter({ hasText: 'Seed 2.1 Turbo' })
    await llmRow.getByRole('button', { name: '编辑' }).evaluate((button) => button.click())

    // The vendor fills the address and interface; the interface type, thinking, image detail, output length and capabilities sit in the card's 高级.
    await expect(dialog.getByLabel('LLM Provider 厂商')).toHaveValue('ark')
    await llmRow.locator('details.provider-advanced > summary').click()
    await dialog.getByLabel('LLM Provider 调用协议').selectOption('openai-chat-completions')
    await dialog.getByLabel('LLM Provider API 地址').fill('https://llm.example.test/v1')
    await dialog.getByLabel('LLM Provider 默认模型').fill('fixture-tool-model')
    await expect(dialog.getByLabel('LLM Provider 厂商')).toHaveValue('custom')
    await dialog.getByLabel('LLM Provider 思考强度').selectOption('high')
    await expect(dialog.getByLabel('LLM Provider 图像细节')).toBeEnabled()
    await dialog.getByLabel('LLM Provider 图像细节').selectOption('low')
    await dialog.getByLabel('LLM Provider 输出上限').fill('8192')
    await expect(llmRow.getByLabel('LLM Provider 能力').getByText('图像理解')).toBeVisible()
    await expect(llmRow.locator('.provider-resolved-endpoint')).toContainText('https://llm.example.test/v1/chat/completions')
    await llmRow.getByRole('button', { name: '保存', exact: true }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('没有发出任何网络请求')

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
    await window.getByRole('button', { name: '出图', exact: true }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByRole('button', { name: '配置图片模型' }).click()

    const dialog = window.getByRole('dialog', { name: '设置', exact: true })
    const imageRow = dialog.locator('[data-provider-slot="image"]')
    await expect(imageRow).toBeVisible()
    await expect(imageRow.getByLabel('Image Provider 调用协议')).toBeVisible()
    await imageRow.getByLabel('Image Provider 名称').fill('Owner Image Relay')
    await imageRow.getByLabel('Image Provider 调用协议').selectOption('openai-images')
    await imageRow.getByLabel('Image Provider API 地址').fill('https://images.example.test/v1')
    await imageRow.getByLabel('Image Provider 默认模型').fill('owner-image-model')
    await expect(imageRow.locator('.provider-resolved-endpoint')).toContainText('https://images.example.test/v1/images/generations')
    await expect(imageRow.locator('.provider-resolved-endpoint')).toContainText('https://images.example.test/v1/images/edits')
    await imageRow.getByRole('button', { name: '保存', exact: true }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('没有发出任何网络请求')
    const imageKey = imageRow.getByLabel('Owner Image Relay API Key')
    await imageKey.fill('synthetic-owner-image-key')
    await imageRow.getByRole('button', { name: '安全保存 Owner Image Relay 凭据' }).evaluate((button) => button.click())
    await expect(dialog.getByTestId('provider-settings-status')).toContainText('界面不会再次显示密钥')
    await dialog.getByRole('button', { name: '关闭设置' }).evaluate((button) => button.click())
    await expect(window.getByLabel('生图服务')).toContainText('Owner Image Relay')
    await expect(window.getByLabel('生图服务')).toContainText('owner-image-model')
    await expect(window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '多候选探索', exact: true })).toHaveClass(/is-active/)
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Responses settings buttons use saved thinking settings and display null-code API failures without retrying', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-responses-check-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    // Only the transport is fake. IPC, settings, the encrypted vault and the
    // validator run in the disposable Main process; real Fetch is never used.
    await app.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __connectionCheckFacts: ConnectionCheckFacts }
      scope.__connectionCheckFacts = { posts: 0, fail: false, requests: [] }
      scope.fetch = async (input, init) => {
        if (String(input) !== 'https://connection.example.test/v1/responses' || init?.method !== 'POST') throw new Error('OFFLINE_FAKE_FETCH_BLOCKED')
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const facts = scope.__connectionCheckFacts
        facts.posts += 1
        facts.requests.push({ stream: body.stream === true, temperature: 'temperature' in body, reasoning: body.reasoning })
        if ('temperature' in body || facts.fail) return new Response(JSON.stringify({ error: {
          code: null, type: 'invalid_request_error', param: 'temperature',
          message: "Unsupported parameter: 'temperature'. fixture-connection-key"
        } }), { status: 400, headers: { 'content-type': 'application/json' } })
        const call = { type: 'function_call', call_id: 'call-connection-check', name: 'verifyAiCanvasConnection', arguments: '{"ok":true}' }
        const response = { id: 'resp-connection-check', status: 'completed', output: [call] }
        return new Response([
          { type: 'response.output_item.done', output_index: 0, item: call },
          { type: 'response.completed', response }
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop
      const current = (await api.getProviderSettings()).providers.find((provider) => provider.kind === 'llm')!
      if (current.kind !== 'llm') throw new Error('Fixture requires LLM config')
      await api.setProviderConfig({ ...current, label: 'Offline OpenAI', baseUrl: 'https://connection.example.test/v1',
        defaultModel: 'gpt-6.1-terra', protocol: 'openai-responses', reasoningEffort: 'medium',
        transport: { ...current.transport, mode: 'stream' }
      })
      await api.setProviderSecret({ providerId: 'openai-compatible-llm', apiKey: 'fixture-connection-key' })
    })
    await window.getByTestId('open-settings').click()
    const dialog = window.getByRole('dialog', { name: '设置', exact: true })
    const row = dialog.locator('[data-provider-slot="llm"]')
    await row.getByRole('button', { name: '测试 Offline OpenAI', exact: true }).click()
    await expect(row.getByTestId('openai-compatible-llm-check')).toContainText('测试通过')
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    await row.getByRole('button', { name: '验证工具调用', exact: true }).click()
    await row.getByRole('button', { name: '确认验证', exact: true }).click()
    await expect(row.locator('.provider-connection-result')).toContainText('连接正常，工具调用可用')
    await window.screenshot({ path: test.info().outputPath('responses-buttons-success-1280x800.png') })

    await app.evaluate(() => { (globalThis as typeof globalThis & { __connectionCheckFacts: ConnectionCheckFacts }).__connectionCheckFacts.fail = true })
    await row.getByRole('button', { name: '测试 Offline OpenAI', exact: true }).click()
    await expect(row.locator('.provider-check-detail')).toContainText("Unsupported parameter: 'temperature'")
    await expect(row.locator('.provider-check-detail')).toContainText('[REDACTED]')
    await row.getByRole('button', { name: '验证工具调用', exact: true }).click()
    await row.getByRole('button', { name: '确认验证', exact: true }).click()
    await expect(row.locator('.provider-connection-result')).toContainText("Unsupported parameter: 'temperature'")
    await expect(row.locator('.provider-connection-result')).toContainText('本次已提交 1 个请求')
    await expect(dialog).not.toContainText('fixture-connection-key')
    const facts = await app.evaluate(() => (globalThis as typeof globalThis & { __connectionCheckFacts: ConnectionCheckFacts }).__connectionCheckFacts)
    expect(facts.posts).toBe(4)
    expect(facts.requests).toEqual(Array.from({ length: 4 }, () => ({ stream: true, temperature: false, reasoning: { effort: 'medium' } })))
    await window.screenshot({ path: test.info().outputPath('responses-buttons-error-1280x800.png') })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
