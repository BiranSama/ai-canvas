import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('Product 1.0 shows the truthful Agent stages and friendly tool calls as one bounded creative flow', async () => {
  test.setTimeout(45_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-agent-execution-flow-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '对话', exact: true }).click({ force: true })
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 3:2 的安静山海封面，标题写“山海之间”，先不要生成图片。')
    const receiptLatencyMs = await window.getByRole('button', { name: '发送要求' }).evaluate((button) => new Promise<number>((resolve) => {
      const startedAt = performance.now()
      const browser = globalThis as typeof globalThis & { MutationObserver: new (callback: () => void) => {
        observe(target: unknown, options: { subtree: boolean; childList: boolean }): void
        disconnect(): void
      } }
      const observer = new browser.MutationObserver(() => {
        if (button.ownerDocument.querySelector('.execution-send-receipt') === null) return
        observer.disconnect()
        clearTimeout(timer)
        resolve(performance.now() - startedAt)
      })
      observer.observe(button.ownerDocument.body, { subtree: true, childList: true })
      const timer = setTimeout(() => { observer.disconnect(); resolve(1_000) }, 1_000)
      button.click()
    }))
    expect(receiptLatencyMs).toBeLessThan(100)
    console.log(`LT1 receipt=${receiptLatencyMs.toFixed(1)}ms`)

    const flow = window.getByTestId('agent-live-plan')
    await window.getByRole('button', { name: '本轮执行记录', exact: true }).click()
    await expect(flow).toBeVisible({ timeout: 10_000 })
    await expect(flow.locator('.execution-status')).toHaveText('已完成', { timeout: 10_000 })
    await expect(flow.getByRole('button', { name: '简洁显示' })).toHaveAttribute('aria-expanded', 'true')

    await expect(flow.getByText('已接收要求', { exact: true })).toBeVisible()
    await expect(flow.getByText('准备创作上下文', { exact: true })).toBeVisible()
    await expect(flow.getByText('请求创作方案', { exact: true })).toBeVisible()
    await expect(flow.getByText('核对本轮结果', { exact: true })).toBeVisible()

    const harnessFacts = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const snapshot = await api.getAgentHarnessSnapshot()
      const turnId = snapshot.thread.activeTurnId ?? snapshot.turns[0]?.id ?? null
      return {
        turnId,
        toolCalls: turnId === null ? 0 : snapshot.items.filter((item) => item.turnId === turnId && item.type === 'tool_call').length,
        externalGeneration: turnId === null ? 0 : snapshot.items.filter((item) => item.turnId === turnId && item.type === 'generation_subscription').length
      }
    })
    expect(harnessFacts.toolCalls).toBeGreaterThan(0)
    await expect(flow.locator('[data-stage-kind="tool"]')).toHaveCount(harnessFacts.toolCalls)
    await expect(flow.locator('[data-stage-kind="generation"]')).toHaveCount(harnessFacts.externalGeneration)
    await expect(window.getByRole('region', { name: '可追溯执行记录' })).toBeVisible()

    const renderedStages = await flow.locator('[data-stage-kind]').count()
    expect(renderedStages).toBeLessThanOrEqual(24)
    await expect(window.locator('body')).not.toContainText('scene_batch')
    await expect(window.locator('body')).not.toContainText('scene.update_elements')
    await expect(window.locator('body')).not.toContainText('toolIndex')
    await expect(window.locator('body')).not.toContainText('chain-of-thought')

    const bounds = await window.getByTestId('agent-status').boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds !== null) {
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1441)
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
