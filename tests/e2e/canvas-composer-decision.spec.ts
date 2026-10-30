import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

// Nothing in the request says the picture's shape, so the Agent stops on an aspect-ratio decision.
const REQUEST_WITHOUT_RATIO = '做一张咖啡店开业的广告画面，标题“晨光咖啡”，中间放一杯拿铁，暖色调。先不要生成图片。'

async function canvasRatio(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
    const { scene } = await api.getWorkspaceBootstrap()
    return [scene.canvas.aspectWidth, scene.canvas.aspectHeight]
  })
}

test('the canvas composer asks the decision the Agent is actually waiting on', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-canvas-decision-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    const input = window.getByRole('textbox', { name: '创作输入' })
    await input.fill(REQUEST_WITHOUT_RATIO)
    await input.press('Enter')

    const decision = window.getByRole('group', { name: '需要你的决定' })
    await expect(decision).toBeVisible({ timeout: 10_000 })
    await expect(decision).toHaveAttribute('data-decision-kind', 'aspect_ratio')
    await expect(decision).toContainText('这张作品使用什么比例？')
    await expect(decision).not.toContainText('生成图片')
    await expect(decision.getByRole('button', { name: '确认生成' })).toHaveCount(0)

    await decision.getByRole('button', { name: '1:1 · 方形' }).evaluate((button) => button.click())
    await expect.poll(async () => canvasRatio(window), { timeout: 10_000 }).toEqual([1, 1])
    await expect(decision).toBeHidden()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('after the ratio is chosen, the composer asks whether to generate instead of failing the turn', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-canvas-ratio-then-generate-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    const input = window.getByRole('textbox', { name: '创作输入' })
    await input.fill('做一张咖啡店开业的广告画面，标题“晨光咖啡”，中间放一杯拿铁，暖色调。')
    await input.press('Enter')

    const decision = window.getByRole('group', { name: '需要你的决定' })
    await expect(decision).toHaveAttribute('data-decision-kind', 'aspect_ratio', { timeout: 10_000 })
    await decision.getByRole('button', { name: '1:1 · 方形' }).evaluate((button) => button.click())
    await expect.poll(async () => canvasRatio(window), { timeout: 10_000 }).toEqual([1, 1])
    await expect(decision).toHaveAttribute('data-decision-kind', 'generation_confirmation', { timeout: 10_000 })
    await expect(decision).toContainText('要现在生成图片吗？')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a poster asked for with its title, subject and colours is laid out without a ratio question', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-canvas-no-question-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    const input = window.getByRole('textbox', { name: '创作输入' })
    // The request from issue #8: everything but the ratio is given, and a poster stands upright.
    await input.fill('做一张咖啡店开业海报，标题“晨光咖啡”，中间放一杯拿铁，暖色调。先不要生成图片。')
    await input.press('Enter')
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.length
    }), { timeout: 10_000 }).toBeGreaterThan(0)
    const [width, height] = await canvasRatio(window)
    expect(height).toBeGreaterThan(width!)
    await expect(window.getByRole('group', { name: '需要你的决定' })).toHaveCount(0)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
