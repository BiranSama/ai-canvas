import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('conversation and canvas share one project-scoped creation draft', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-creation-session-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1', AI_CANVAS_STARTUP: 'workspace' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.waitForLoadState('domcontentloaded')

    await window.getByRole('textbox', { name: '创作输入' }).fill('标题更疏朗，主体下移一点，先不要生成')
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await expect(window.getByRole('textbox', { name: '对话输入' })).toHaveValue('标题更疏朗，主体下移一点，先不要生成')

    await window.getByRole('textbox', { name: '对话输入' }).fill('保留留白，把光线改成清晨侧光')
    await window.getByRole('button', { name: '画布', exact: true }).evaluate((button) => button.click())
    await expect(window.getByRole('textbox', { name: '创作输入' })).toHaveValue('保留留白，把光线改成清晨侧光')
    await expect(window.getByRole('combobox', { name: 'Agent 模式' })).toHaveValue('collaboration')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
