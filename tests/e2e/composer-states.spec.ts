import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const INFERRED_REQUEST = '创建一张 4:5 的深蓝香水广告海报，标题是 NIGHT VEIL，香水瓶放中央偏下，瓶子后方有柔和轮廓光。'

test('morphs one conversation composer through editing, confirm, completed and cancelled states', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-composer-states-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    const composer = window.locator('.conversation-composer')
    const input = window.getByRole('textbox', { name: '对话输入' })
    await expect(composer).toHaveAttribute('data-composer-state', 'idle')
    await input.fill(INFERRED_REQUEST)
    await expect(composer).toHaveAttribute('data-composer-state', 'editing')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(composer).toHaveAttribute('data-composer-state', 'confirm', { timeout: 10_000 })
    await expect(window.getByRole('button', { name: '确认生成' })).toBeVisible()
    await expect(window.getByRole('button', { name: '停止当前操作' })).toBeVisible()
    await window.getByRole('button', { name: '确认生成' }).evaluate((button) => button.click())
    await expect(composer).toHaveAttribute('data-composer-state', 'completed', { timeout: 10_000 })
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationJobs())[0]?.status
    })).toBe('completed')

    await input.fill(INFERRED_REQUEST)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(composer).toHaveAttribute('data-composer-state', 'confirm', { timeout: 10_000 })
    await window.getByRole('button', { name: '停止当前操作' }).evaluate((button) => button.click())
    await expect(composer).toHaveAttribute('data-composer-state', 'cancelled', { timeout: 10_000 })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
