import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openConversationRecord } from '../helpers/workbench-ui'
import type { DesktopApi } from '../../src/shared/desktop-api'

const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const

for (const viewport of VIEWPORTS) {
  test(`the current creative task stays spacious at ${viewport.width} by ${viewport.height}`, async ({ browserName }, testInfo) => {
    void browserName
    test.setTimeout(30_000)
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-conversation-continuity-'))
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: '1' }
    })
    try {
      const window = await app.firstWindow()
      await window.setViewportSize(viewport)
      const conversationTab = window.getByRole('button', { name: '对话', exact: true })
      await expect(conversationTab).toBeVisible()
      await conversationTab.click({ force: true })
      await openConversationRecord(window)
      const input = window.getByRole('textbox', { name: '对话输入' })
      await input.fill('创建一张安静的 4:5 植物产品海报，先不要生成图片。')
      await input.press('Enter')
      await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
      await window.getByRole('button', { name: '新建创作任务' }).click({ force: true })
      await input.fill('创建一张 16:9 山海封面，主体是一座远山，标题写“山海之间”，先不要生成图片。')
      await input.press('Enter')
      await expect.poll(() => window.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene.canvas)).toMatchObject({ aspectWidth: 16, aspectHeight: 9 })
      await expect(window.getByTestId('operation-receipt')).toHaveCount(1)
      await expect(window.getByRole('button', { name: /早期创作记录/ })).toContainText('1 个任务')
      if (viewport.width > 1100) await expect(window.getByRole('separator', { name: '调整对话和实时画布宽度' })).toHaveAttribute('aria-valuenow', '32')

      const threadBeforeCapture = await window.locator('.conversation-thread').boundingBox()
      const currentReplyBeforeCapture = await window.locator('.conversation-message.is-assistant').last().boundingBox()
      expect(threadBeforeCapture).not.toBeNull()
      expect(currentReplyBeforeCapture).not.toBeNull()
      if (threadBeforeCapture !== null && currentReplyBeforeCapture !== null) {
        expect(currentReplyBeforeCapture.y).toBeGreaterThanOrEqual(threadBeforeCapture.y - 1)
        expect(currentReplyBeforeCapture.y).toBeLessThan(threadBeforeCapture.y + threadBeforeCapture.height)
      }

      await window.screenshot({ path: testInfo.outputPath(`conversation-continuity-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
      const workspace = await window.locator('.conversation-workspace').boundingBox()
      const documentPanel = await window.locator('.conversation-document').boundingBox()
      const composer = await window.locator('.conversation-composer').boundingBox()
      expect(workspace).not.toBeNull()
      expect(documentPanel).not.toBeNull()
      expect(composer).not.toBeNull()
      if (workspace === null || documentPanel === null || composer === null) return
      expect(workspace.x).toBeGreaterThanOrEqual(-1)
      expect(workspace.x + workspace.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(workspace.y + workspace.height).toBeLessThanOrEqual(viewport.height + 1)
      expect(composer.x).toBeGreaterThanOrEqual(-1)
      expect(composer.x + composer.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height + 1)
      if (viewport.width > 1100) {
        expect(documentPanel.width / workspace.width).toBeLessThanOrEqual(.4)
        expect((await window.getByTestId('canvas-stage').boundingBox())!.width / workspace.width).toBeGreaterThan(.55)
      } else {
        await window.getByRole('button', { name: '返回作品', exact: true }).click()
        await expect(window.getByTestId('canvas-stage')).toBeVisible()
        expect((await window.getByTestId('canvas-stage').boundingBox())!.width / workspace.width).toBeGreaterThan(.9)
      }
    } finally {
      await app.close()
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
}
