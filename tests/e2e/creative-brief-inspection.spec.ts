import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('the current Creative Brief is inspectable and can be corrected through the same conversation', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-brief-inspection-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1', AI_CANVAS_STARTUP: 'workspace' }
  })

  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button: { click(): void }) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的山海封面，主体是一座远山，标题写“山海之间”，保留大面积留白，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button: { click(): void }) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })

    const summary = window.locator('summary[aria-label="查看当前创作简报"]')
    await expect(summary).toBeVisible()
    await summary.evaluate((element: { click(): void }) => element.click())
    const detail = window.getByRole('region', { name: '当前创作简报详情' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('当前要求')
    await expect(detail).toContainText('主体')
    await expect(detail).toContainText('文字参考')
    await expect(detail).toContainText('保持')
    await expect(detail).toContainText('避免')
    await expect(detail).toContainText('验收标准')
    await expect(detail).toContainText('字段来源')

    await detail.getByRole('button', { name: '用对话修正' }).evaluate((button: { click(): void }) => button.click())
    await expect(detail).not.toBeVisible()
    await expect(window.getByRole('textbox', { name: '对话输入' })).toHaveValue('修正当前创作简报：')
    await expect(window.getByRole('textbox', { name: '对话输入' })).toBeFocused()

    await window.getByRole('textbox', { name: '对话输入' }).fill('修正当前创作简报：面向独立出版读者，标题更轻盈。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button: { click(): void }) => button.click())
    await expect(window.getByRole('textbox', { name: '对话输入' })).toHaveValue('', { timeout: 10_000 })
    await expect(window.getByTestId('operation-receipt').filter({ hasText: '修正当前创作简报' })).toHaveCount(1, { timeout: 10_000 })
    await summary.evaluate((element: { click(): void }) => element.click())
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('独立出版读者')
    await expect(detail).toContainText('标题更轻盈')
    await expect(detail).toContainText('可追溯简报')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
