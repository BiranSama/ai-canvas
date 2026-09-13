import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const REQUEST = '创建一张优雅的雨夜唱片封面，标题是 AFTER RAIN，黑胶唱片放在右下方，后方有柔和轮廓光。先不要生成图片。'

test('AC-R2-05 persists a real decision and lets activity locate and undo its exact batch', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-r2-activity-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())

    await expect(window.getByRole('group', { name: '这张作品使用什么比例？' })).toBeVisible({ timeout: 10_000 })
    await expect(window.getByRole('button', { name: '4:5 · 推荐' })).toBeFocused()
    await expect.poll(async () => {
      const threadBounds = await window.locator('.conversation-thread').boundingBox()
      const decisionBounds = await window.getByRole('group', { name: '这张作品使用什么比例？' }).boundingBox()
      if (threadBounds === null || decisionBounds === null) return false
      return decisionBounds.y >= threadBounds.y - 1
        && decisionBounds.y + decisionBounds.height <= threadBounds.y + threadBounds.height + 1
    }).toBe(true)
    const waiting = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, jobs, conversation] = await Promise.all([
        api.getWorkspaceBootstrap(), api.listGenerationJobs(), api.getConversationSnapshot()
      ])
      return {
        revision: bootstrap.scene.revision,
        elements: bootstrap.scene.elements.length,
        jobs: jobs.length,
        decision: conversation.activities.find((activity) => activity.kind === 'decision'),
        tool: conversation.activities.find((activity) => activity.kind === 'tool')
      }
    })
    expect(waiting).toMatchObject({
      revision: 0,
      elements: 0,
      jobs: 0,
      decision: { state: 'waiting', recoverable: true, decision: { status: 'waiting' } },
      tool: { state: 'queued' }
    })

    await window.getByRole('button', { name: '4:5 · 推荐' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '本轮执行记录', exact: true }).click()
    await expect(window.getByText(/个状态事件，最后/).first()).toBeVisible()
    await window.getByRole('button', { name: '定位：更新画布结构' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '对话', exact: true })).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByRole('option')).toHaveCount(8)

    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '撤销：更新画布结构' }).evaluate((button) => button.click())
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const snapshot = await api.getConversationSnapshot()
      return {
        elements: (await api.getWorkspaceBootstrap()).scene.elements.length,
        undone: snapshot.activities.find((activity) => activity.kind === 'tool')?.undoneAt !== null
      }
    })).toEqual({ elements: 0, undone: true })
    await expect(window.getByText('已撤销', { exact: true })).toBeVisible()
    await expect(window.locator('body')).not.toContainText('scene_batch')
    await expect(window.locator('body')).not.toContainText('toolIndex')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
