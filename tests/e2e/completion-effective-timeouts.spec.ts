import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('uses seconds in settings, reads back the saved policy, and shows the persisted Agent Turn limit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'time-ui-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  try {
    await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { __timeNetwork: number }; state.__timeNetwork = 0
      state.fetch = async () => { state.__timeNetwork++; throw new Error('OFFLINE_TIME_UI') }
    })
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.new-project-main').click()
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await openGenerationOptions(page)
    await page.getByRole('button', { name: '配置图片模型', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '供应商设置' })
    const image = dialog.locator('[data-provider-slot="image"]')
    await image.getByLabel('Image Provider 调用协议').selectOption('openai-images')
    await image.getByLabel('Image Provider API 地址').fill('https://time-ui.example.test/v1')
    await image.getByLabel('Image Provider 默认模型').fill('synthetic-time-model')
    await image.getByLabel('Image Provider 超时').fill('300')
    await image.getByRole('button', { name: '保存公开配置', exact: true }).click()
    await expect(image.getByTestId('image-provider-effective-timeout')).toContainText('已保存：300 秒')
    await expect(image.getByTestId('image-provider-effective-timeout')).toContainText('排队不计入')
    const saved = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getProviderSettings())
    expect(saved.providers.find((provider) => provider.kind === 'image')?.timeoutMs).toBe(300_000)
    await page.screenshot({ path: test.info().outputPath('saved-image-timeout-seconds.png') })
    await dialog.getByRole('button', { name: '关闭供应商设置', exact: true }).click()
    await page.getByRole('button', { name: '对话', exact: true }).click()
    await page.getByRole('group', { name: 'Agent 模式', exact: true }).getByRole('button', { name: '审阅', exact: true }).click()
    await page.getByLabel('对话输入').fill('调整画布为一张安静的封面，先不要生成图片')
    await page.getByRole('button', { name: '发送要求', exact: true }).click()
    await expect(page.locator('.execution-time-policy').last()).toContainText('本轮总时限 5 分钟')
    await expect(page.locator('.execution-time-policy').last()).toContainText('包含等待决定和图片')
    const harness = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot())
    expect(harness.turns[0]?.timeLimitMs).toBe(300_000)
    await page.screenshot({ path: test.info().outputPath('turn-limit-main-readback.png') })
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __timeNetwork: number }).__timeNetwork)).toBe(0)
    await writeFile(test.info().outputPath('saved-time-policy.json'), JSON.stringify({ imageTimeoutMs: saved.providers.find((provider) => provider.kind === 'image')?.timeoutMs,
      turn: harness.turns[0], actualProviderRequests: 0 }, null, 2))
  } finally { await app.close() }
})
