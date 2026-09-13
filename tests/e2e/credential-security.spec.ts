import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  }))).flat()
}

test('AC-05 keeps stored credentials out of Renderer reads, projects, logs and Agent messages', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-credentials-'))
  const secret = 'sk-test-AC05-DO-NOT-USE-123456789'
  const consoleMessages: string[] = []
  const externalRequests: string[] = []
  let closed = false
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    window.on('console', (message) => consoleMessages.push(message.text()))
    window.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    const settingsButton = window.getByTestId('open-settings')
    await expect(settingsButton).toBeVisible()
    await settingsButton.evaluate((button) => button.click())
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await window.locator('.provider-setting-row').filter({ hasText: 'Seedream' }).getByRole('button', { name: '编辑' }).evaluate((button) => button.click())
    const imageEndpoint = window.getByLabel('Image Provider API 地址')
    const imageProviderRow = window.locator('.provider-setting-row').filter({ has: imageEndpoint })
    await imageEndpoint.fill('https://images.example.test/v1')
    await window.getByLabel('Image Provider 默认模型').fill('studio-image-1')
    await imageProviderRow.getByRole('button', { name: '保存公开配置', exact: true }).evaluate((button) => button.click())
    await expect(window.getByTestId('provider-settings-status')).toContainText('未发起网络请求')
    const imageProviderKey = window.getByLabel('火山方舟 · Seedream 5.0 API Key')
    await imageProviderKey.fill(secret)
    const imageProviderControls = window.locator('.provider-secret-controls').filter({ has: imageProviderKey })
    await expect(imageProviderControls).toHaveCount(1)
    await imageProviderControls.locator('button.settings-save').evaluate((button) => button.click())
    await expect(window.getByTestId('provider-settings-status')).toContainText('界面不会再次显示密钥')
    await expect(window.getByLabel('火山方舟 · Seedream 5.0 API Key')).toHaveValue('')
    await expect(imageProviderRow.locator('.provider-state')).toContainText('已配置')

    const rendererBoundary = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const snapshot = await renderer.desktop.getProviderSettings()
      return { methods: Object.keys(renderer.desktop), snapshot, serializedWindow: JSON.stringify(snapshot) }
    })
    expect(rendererBoundary.methods.some((method) => /get.*secret|read.*key/i.test(method))).toBe(false)
    expect(rendererBoundary.snapshot.providers.find((provider) => provider.id === 'image-provider')?.configured).toBe(true)
    expect(rendererBoundary.snapshot.providers.find((provider) => provider.id === 'image-provider')).toMatchObject({
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'studio-image-1'
    })
    expect(rendererBoundary.serializedWindow).not.toContain(secret)
    expect(externalRequests).toEqual([])

    const vaultPath = join(userData, 'security', 'provider-secrets.json')
    const publicConfigPath = join(userData, 'security', 'provider-settings.json')
    const vaultBytes = await readFile(vaultPath)
    expect(vaultBytes.toString('utf8')).not.toContain(secret)
    expect(JSON.parse(await readFile(publicConfigPath, 'utf8'))).toMatchObject({ version: 5 })
    for (const filePath of await filesUnder(join(userData, 'projects'))) {
      expect((await readFile(filePath)).includes(Buffer.from(secret))).toBe(false)
    }

    await window.getByRole('button', { name: '关闭供应商设置' }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill(`不要使用这个测试 key：${secret}`)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByText(/\[REDACTED\]/)).toBeVisible({ timeout: 10_000 })
    const conversation = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.getConversationSnapshot()
    })
    expect(JSON.stringify(conversation)).not.toContain(secret)
    expect(consoleMessages.join('\n')).not.toContain(secret)

    await settingsButton.evaluate((button) => button.click())
    await window.locator('.provider-setting-row').filter({ hasText: 'Seedream' }).getByRole('button', { name: '编辑' }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '删除 火山方舟 · Seedream 5.0 凭据' }).evaluate((button) => button.click())
    await expect(window.getByTestId('provider-settings-status')).toContainText('不再能恢复')
    const deleted = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.getProviderSettings()
    })
    expect(deleted.providers.find((provider) => provider.id === 'image-provider')?.configured).toBe(false)
    expect((await readFile(vaultPath)).toString('utf8')).not.toContain(secret)
    await app.close()
    closed = true
    for (const filePath of await filesUnder(userData)) {
      expect((await readFile(filePath)).includes(Buffer.from(secret)), filePath).toBe(false)
    }
  } finally {
    if (!closed) await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
