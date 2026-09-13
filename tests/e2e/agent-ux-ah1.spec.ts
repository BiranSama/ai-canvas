import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AH1 S8 exposes truthful modes, Review approval, live plan and inspectable local context', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-agent-ux-'))
  const externalRequests: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    window.on('request', (request) => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())

    const modes = window.getByRole('group', { name: 'Agent 模式' })
    await expect(modes.getByRole('button', { name: '协作' })).toHaveAttribute('aria-pressed', 'true')
    await modes.getByRole('button', { name: '审阅' }).evaluate((button) => button.click())
    await expect(modes.getByRole('button', { name: '审阅' })).toHaveAttribute('aria-pressed', 'true')

    await window.getByRole('textbox', { name: '对话输入' }).fill('使用 4:5 画布创建一张克制的银蓝海报，标题为 QUIET CURRENT，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('agent-live-plan')).toBeVisible({ timeout: 10_000 })
    const reviewDecision = window.getByRole('group', { name: '先确认这项修改' })
    await expect(reviewDecision).toBeVisible()
    await expect(window.getByRole('group', { name: '这条消息如何加入当前工作' })).toBeVisible()

    const before = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, harness] = await Promise.all([api.getWorkspaceBootstrap(), api.getAgentHarnessSnapshot()])
      return { revision: bootstrap.scene.revision, mode: harness.activeGoal?.mode, budget: harness.activeGoal?.budget }
    })
    expect(before).toMatchObject({ revision: 0, mode: 'review', budget: { maxGenerationJobs: 0, maxGeneratedImages: 0 } })

    await window.getByRole('button', { name: '排到下一轮' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '排到下一轮' })).toHaveAttribute('aria-pressed', 'true')
    await reviewDecision.getByRole('button', { name: '执行这一步' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '本轮执行记录', exact: true }).click()
    await expect(window.getByTestId('agent-live-plan').locator('.execution-status')).toHaveText('已完成')

    const contextTrigger = window.getByRole('button', { name: '本轮上下文' })
    await contextTrigger.evaluate((button) => button.click())
    const context = window.getByRole('dialog', { name: '本轮上下文' })
    await expect(context).toBeVisible()
    await expect(context).toContainText('真实调用')
    await expect(context).toContainText('按 Owner 策略')
    await expect(context).toContainText(/Scene 版本/)
    await window.keyboard.press('Escape')
    await expect(context).toBeHidden()
    await expect(contextTrigger).toBeFocused()

    expect(externalRequests).toEqual([])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
