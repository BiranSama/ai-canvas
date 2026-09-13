import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function launch(userData: string, extraArgs: readonly string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.', `--user-data-dir=${userData}`, ...extraArgs],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
}

test('supports explicit offline operation, keyboard focus and IME composition', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-m9-a11y-'))
  const app = await launch(userData)
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await expect(window.getByRole('button', { name: '供应商设置' })).toBeVisible()
    const cdp = await app.context().newCDPSession(window)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none'
    })
    await window.evaluate('globalThis.dispatchEvent(new Event("offline"))')
    await expect(window.getByText('离线可用', { exact: true })).toBeVisible()

    const settingsButton = window.getByTestId('open-settings')
    await settingsButton.evaluate((button) => {
      button.focus()
      button.click()
    })
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeVisible()
    await window.locator('.provider-setting-row').filter({ hasText: 'Seed 2.1' }).getByRole('button', { name: '编辑' }).evaluate((button) => button.click())
    await expect(window.getByLabel('火山方舟 · Seed 2.1 Turbo API Key')).toBeFocused()
    await window.keyboard.press('Escape')
    await expect(window.getByRole('dialog', { name: '供应商设置' })).toBeHidden()
    await expect(settingsButton).toBeFocused()

    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    const input = window.getByRole('textbox', { name: '对话输入' })
    await input.fill('中文输入法组合测试')
    await input.dispatchEvent('compositionstart', { data: '测' })
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await input.dispatchEvent('compositionend', { data: '测试' })
    await expect(input).toHaveValue('中文输入法组合测试')
    const before = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getConversationSnapshot()).messages.length
    })
    expect(before).toBe(0)
    await input.press('Enter')
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getConversationSnapshot()).messages.length
    })).toBeGreaterThan(0)

    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('雨夜唱片封面，冷色轮廓光')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await expect(window.locator('.provider-boundary')).toContainText('本地离线档不联网')
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('maps reduced motion, reduced transparency and visible focus to stable CSS', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-m9-media-'))
  const app = await launch(userData)
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    const cdp = await app.context().newCDPSession(window)
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-reduced-transparency', value: 'reduce' }
      ]
    })
    await expect.poll(() => window.evaluate(`getComputedStyle(document.querySelector('.glass-surface')).backdropFilter`) as Promise<string>).toBe('none')
    const media = await window.evaluate(`(() => ({
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      surfaceBackdrop: getComputedStyle(document.querySelector('.glass-surface')).backdropFilter,
      transitionDuration: getComputedStyle(document.querySelector('.view-switcher button')).transitionDuration
    }))()`) as { reducedMotion: boolean; reducedTransparency: boolean; surfaceBackdrop: string; transitionDuration: string }
    expect(media.reducedMotion).toBe(true)
    expect(media.reducedTransparency).toBe(true)
    expect(media.surfaceBackdrop).toBe('none')
    expect(Number.parseFloat(media.transitionDuration)).toBeLessThanOrEqual(0.00001)

    const canvasButton = window.getByRole('button', { name: '画布', exact: true })
    await canvasButton.focus()
    const focus = await window.evaluate(`(() => {
      const style = getComputedStyle(document.querySelector('.view-switcher button[aria-current="page"]'))
      return { style: style.outlineStyle, width: style.outlineWidth }
    })()`) as { style: string; width: string }
    expect(focus.style).toBe('solid')
    expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('keeps the workspace usable at Windows-like 100, 125 and 150 percent device scale', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-m9-dpi-'))
  const app = await launch(userData)
  try {
    const window = await app.firstWindow()
    const cdp = await app.context().newCDPSession(window)
    for (const scale of [1, 1.25, 1.5]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: scale,
        mobile: false
      })
      await expect.poll(() => window.evaluate('globalThis.devicePixelRatio') as Promise<number>).toBeCloseTo(scale, 2)
      await expect(window.getByTestId('canvas-stage')).toBeVisible()
      await expect(window.getByRole('button', { name: '导出', exact: true })).toBeVisible()
      const layout = await window.evaluate(`(() => {
        const projectName = document.querySelector('.project-menu-trigger')
        if (projectName instanceof HTMLElement) {
          projectName.textContent = '一个很长的中文与 English Mixed 125% 可访问文字项目名称 — AFTER RAIN 2026 · '.repeat(6)
          projectName.title = projectName.textContent
        }
        const header = document.querySelector('.workspace-header')?.getBoundingClientRect()
        const composer = document.querySelector('.creation-bar')?.getBoundingClientRect()
        return {
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          headerBottom: header?.bottom ?? 0,
          composerRight: composer?.right ?? 0,
          viewportWidth: innerWidth,
          projectOverflow: projectName instanceof HTMLElement ? projectName.scrollWidth > projectName.clientWidth : false
        }
      })()`) as { horizontalOverflow: number; headerBottom: number; composerRight: number; viewportWidth: number; projectOverflow: boolean }
      expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
      expect(layout.headerBottom).toBe(60)
      expect(layout.composerRight).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.projectOverflow).toBe(true)
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('keeps filmstrip memory bounded by loading thumbnails before originals', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-m9-memory-'))
  const app = await launch(userData, ['--enable-precise-memory-info'])
  try {
    const window = await app.firstWindow()
    const before = await window.evaluate('(performance.memory && performance.memory.usedJSHeapSize) || 0') as number
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('四种雨夜唱片封面构图')
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('4')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(4, { timeout: 15_000 })
    const assets = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const jobs = await api.listGenerationJobs()
      const ids = jobs[0]?.results.map((result) => result.assetId) ?? []
      const thumbnails = await Promise.all(ids.map((id) => api.readGenerationAsset(id, true)))
      const oneOriginal = ids[0] === undefined ? '' : await api.readGenerationAsset(ids[0], false)
      return { thumbnails, oneOriginal }
    })
    expect(assets.thumbnails).toHaveLength(4)
    expect(assets.thumbnails.every((value) => value.startsWith('data:image/webp;base64,'))).toBe(true)
    expect(assets.oneOriginal.startsWith('data:image/png;base64,')).toBe(true)
    await window.waitForTimeout(50)
    const after = await window.evaluate('(performance.memory && performance.memory.usedJSHeapSize) || 0') as number
    if (before > 0 && after > 0) expect(after - before).toBeLessThan(120 * 1024 * 1024)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('recovers the committed scene and marks an in-flight job interrupted after an abnormal exit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-m9-recovery-'))
  let first: ElectronApplication | null = await launch(userData)
  let second: ElectronApplication | null = null
  try {
    const firstWindow = await first.firstWindow()
    await firstWindow.getByRole('button', { name: '形状' }).evaluate((button) => button.click())
    await expect.poll(async () => firstWindow.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.elements.length
    })).toBe(1)
    await firstWindow.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      await api.enqueueGeneration({
        prompt: 'Abnormal recovery fixture',
        negativePrompt: '',
        aspectWidth: 4,
        aspectHeight: 5,
        outputWidth: 1024,
        outputHeight: 1280,
        count: 1,
        providerId: 'mock',
        model: 'mock-slow',
        references: [],
        parameters: { mockGenerationDelayMs: 10_000 },
        sourceMessageId: null,
        parentResultId: null,
        referenceMode: 'hybrid',
        variationInstruction: '',
        preserveConstraints: ''
      })
    })
    await expect.poll(async () => firstWindow.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationJobs())[0]?.status
    })).toMatch(/preparing|generating/)
    const firstProcess = first.process()
    const exited = new Promise<void>((resolveExit) => firstProcess.once('exit', () => resolveExit()))
    await first.evaluate(({ app }) => {
      setTimeout(() => app.exit(17), 0)
    }).catch(() => undefined)
    await exited
    first = null
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))

    second = await launch(userData)
    const secondWindow = await second.firstWindow()
    await expect.poll(async () => secondWindow.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const jobs = await api.listGenerationJobs()
      return { elements: bootstrap.scene.elements.length, status: jobs[0]?.status, prompt: jobs[0]?.request.prompt }
    })).toEqual({ elements: 1, status: 'interrupted', prompt: 'Abnormal recovery fixture' })
  } finally {
    if (first !== null) await first.close().catch(() => undefined)
    if (second !== null) await second.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})
