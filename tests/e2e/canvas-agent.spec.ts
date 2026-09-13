import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-R1-07 keeps a scoped Agent edit on canvas with receipt, no generation and one-step undo', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-canvas-agent-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByRole('button', { name: '文字 T', exact: true }).click()
    await window.getByRole('button', { name: '形状', exact: true }).click()

    const titleLayer = window.getByRole('option').filter({ has: window.locator('strong', { hasText: /^文字$/ }) })
    const shapeLayer = window.getByRole('option').filter({ has: window.locator('strong', { hasText: /^形状$/ }) })
    await titleLayer.click()
    await shapeLayer.click({ modifiers: ['Control'] })
    await expect(window.getByRole('button', { name: /当前选区 · 2/ })).toBeVisible()

    const before = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      return bootstrap.scene.elements.map((element) => ({ id: element.id, type: element.type, transform: element.transform }))
    })

    await window.getByRole('textbox', { name: '创作输入' }).fill('整体向右移一点，标题更大，先不要生成')
    await window.getByRole('button', { name: '发送创作指令' }).click()
    await expect(window.getByTestId('canvas-agent-receipt')).toBeVisible({ timeout: 10_000 })
    await expect(window.getByRole('button', { name: '画布', exact: true })).toHaveAttribute('aria-current', 'page')

    const after = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, jobs] = await Promise.all([api.getWorkspaceBootstrap(), api.listGenerationJobs()])
      return {
        jobs: jobs.length,
        elements: bootstrap.scene.elements.map((element) => ({ id: element.id, type: element.type, transform: element.transform }))
      }
    })
    expect(after.jobs).toBe(0)
    for (const element of after.elements) {
      const original = before.find((candidate) => candidate.id === element.id)
      expect(original).toBeDefined()
      expect(element.transform.x).toBeCloseTo((original?.transform.x ?? 0) + 0.08)
      if (element.type === 'text') expect(element.transform.width).toBeCloseTo((original?.transform.width ?? 0) * 1.12)
      if (element.type === 'shape') expect(element.transform.width).toBeCloseTo(original?.transform.width ?? 0)
    }

    await window.getByTestId('canvas-agent-receipt').getByRole('button', { name: '撤销' }).click()
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      return bootstrap.scene.elements.map((element) => element.transform)
    })).toEqual(before.map((element) => element.transform))
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
