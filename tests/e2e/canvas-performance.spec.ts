import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('keeps a measured 100 element Konva workspace interactive', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-performance-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })

  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await expect(window.getByTestId('canvas-stage')).toBeVisible()

    const measurement = await window.evaluate(`(async () => {
      const button = document.querySelector('[aria-label="形状"]')
      if (!(button instanceof HTMLButtonElement)) throw new Error('Shape tool is unavailable.')
      const layerCount = () => document.querySelectorAll('[role="listbox"][aria-label="图层"] [role="option"]').length
      const waitForLayerCount = (expected) => new Promise((resolveCount, rejectCount) => {
        if (layerCount() >= expected) return resolveCount(undefined)
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          rejectCount(new Error('Timed out waiting for the Main-owned Scene commit.'))
        }, 3000)
        const observer = new MutationObserver(() => {
          if (layerCount() < expected) return
          window.clearTimeout(timeout)
          observer.disconnect()
          resolveCount(undefined)
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })
      const addStartedAt = performance.now()
      for (let index = 0; index < 100; index += 1) {
        button.click()
        await waitForLayerCount(index + 1)
      }
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
      const addFinishedAt = performance.now()
      const hideButton = document.querySelector('[aria-label="隐藏形状"]')
      if (!(hideButton instanceof HTMLButtonElement)) throw new Error('Layer action is unavailable.')
      hideButton.click()
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      return {
        addDurationMs: addFinishedAt - addStartedAt,
        interactionDurationMs: performance.now() - addFinishedAt,
        layerCount: layerCount()
      }
    })()`) as { addDurationMs: number; interactionDurationMs: number; layerCount: number }

    console.log(`PERF-100-ELEMENTS add=${measurement.addDurationMs.toFixed(1)}ms interaction=${measurement.interactionDurationMs.toFixed(1)}ms layers=${measurement.layerCount}`)

    expect(measurement.layerCount).toBe(100)
    expect(measurement.addDurationMs).toBeLessThan(5_000)
    expect(measurement.interactionDurationMs).toBeLessThan(500)

    await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      await api.enqueueGeneration({
        prompt: '100 element activity performance fixture',
        negativePrompt: '',
        aspectWidth: 4,
        aspectHeight: 5,
        outputWidth: 1024,
        outputHeight: 1280,
        count: 1,
        providerId: 'mock',
        model: 'mock-balanced',
        references: [],
        parameters: {},
        sourceMessageId: null,
        parentResultId: null,
        referenceMode: 'hybrid',
        variationInstruction: '',
        preserveConstraints: ''
      })
    })
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationJobs())[0]?.status
    }), { timeout: 15_000 }).toBe('completed')
    const combinedStartedAt = Date.now()
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button: { click(): void }) => button.click())
    await expect(window.getByLabel('对话输入', { exact: true })).toBeVisible()
    expect(await window.evaluate(async () => (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).toMatchObject({ scene: { elements: expect.any(Array) } })
    expect((await window.evaluate(async () => (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene.elements).toHaveLength(100)
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    const combinedDurationMs = Date.now() - combinedStartedAt
    console.log(`PERF-100-ELEMENTS-ACTIVITY live-view=${combinedDurationMs}ms`)
    expect(combinedDurationMs).toBeLessThan(2_500)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
