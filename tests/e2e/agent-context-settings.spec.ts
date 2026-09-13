import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('AH1 S5 exposes Context, Directive, Memory and local-only policy without network access', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-context-'))
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
    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await window.getByRole('button', { name: 'Agent 上下文' }).evaluate((button) => button.click())
    await expect(window.getByTestId('agent-context-settings')).toBeVisible()

    await window.getByLabel('Agent 外发策略').selectOption('local_only')
    await expect(window.getByTestId('provider-settings-status')).toContainText('没有发起网络请求')

    await window.getByLabel('新增项目规则').fill('品牌名必须保留英文')
    await window.getByRole('button', { name: '添加', exact: true }).first().evaluate((button) => button.click())
    await expect(window.getByText('品牌名必须保留英文', { exact: true })).toBeVisible()

    await window.getByLabel('新增项目记忆').fill('本项目采用克制的银蓝色调')
    await window.getByRole('button', { name: '添加', exact: true }).last().evaluate((button) => button.click())
    await expect(window.getByText('本项目采用克制的银蓝色调', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: '删除记忆 本项目采用克制的银蓝色调' }).evaluate((button) => button.click())
    await expect(window.getByTestId('provider-settings-status')).toContainText('未来上下文删除')
    await expect(window.locator('.knowledge-list').filter({ hasText: '本项目采用克制的银蓝色调' })).toContainText('deleted')

    await window.getByRole('button', { name: '关闭供应商设置' }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill('建立一个 4:5 的本地海报布局，标题是 AURORA，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })

    await window.getByTestId('open-settings').evaluate((button) => button.click())
    await window.getByRole('button', { name: 'Agent 上下文' }).evaluate((button) => button.click())
    const contextSettings = window.getByTestId('agent-context-settings')
    await expect(contextSettings.getByText('最近 Context Manifest')).toBeVisible()
    await expect(contextSettings.getByText(/Scene r\d+/)).toBeVisible()
    await expect(contextSettings.getByLabel('Agent 外发策略')).toHaveValue('local_only')
    await contextSettings.getByText('外发记录', { exact: true }).evaluate((summary) => summary.closest('summary')?.click())
    await expect(contextSettings.getByText('还没有外发记录；只有实际准备或调用 Provider 后才会出现。')).toBeVisible()
    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
