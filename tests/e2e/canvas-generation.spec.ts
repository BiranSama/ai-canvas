import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-03 compiles the structured canvas into a deterministic reference and a new result', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-reference-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('雨夜黑胶唱片，安静的编辑构图，冷色轮廓光')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await window.getByRole('textbox', { name: '创作输入' }).fill('生成完整的雨夜唱片封面，保持当前构图与柔和蓝色背光')
    await window.getByRole('button', { name: '生成画布' }).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-reference-control').getByRole('img', { name: '本次参考预览 1' })).toBeVisible()
    expect(await window.evaluate(() => (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop.listGenerationJobs())).toHaveLength(1)
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })
    await expect(window.locator('.generation-compact-summary')).toContainText('画布 r1')

    const first = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const jobs = await renderer.desktop.listGenerationJobs()
      const job = jobs.find((candidate) => candidate.request.parameters.mode === 'canvas')
      if (job === undefined) throw new Error('Canvas generation job is missing.')
      return {
        jobId: job.id,
        referenceAssetId: job.request.references[0]?.assetId ?? null,
        prompt: job.request.prompt,
        negativePrompt: job.request.negativePrompt,
        parameters: job.request.parameters,
        resultAssetId: job.results[0]?.assetId ?? null
      }
    })
    expect(first.referenceAssetId).not.toBeNull()
    expect(first.resultAssetId).not.toBe(first.referenceAssetId)
    expect(first.prompt).toContain('雨夜唱片封面')
    expect(first.prompt).toContain('4:5')
    expect(first.prompt).toContain('光影')
    expect(first.negativePrompt).toContain('选择框')
    expect(first.parameters).toMatchObject({ mode: 'canvas', originalRequirement: expect.stringContaining('雨夜唱片封面'), promptIr: { sceneRevision: 1 } })

    await window.getByRole('button', { name: '画布', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('canvas-stage').locator('.konvajs-content').evaluate((surface) => {
      const rect = surface.getBoundingClientRect()
      const BrowserWheelEvent = Reflect.get(globalThis, 'WheelEvent') as new (
        type: string,
        init: unknown
      ) => Parameters<typeof surface.dispatchEvent>[0]
      surface.dispatchEvent(new BrowserWheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaY: -180
      }))
    })
    await window.setViewportSize({ width: 1440, height: 900 })
    const repeated = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const bootstrap = await renderer.desktop.getWorkspaceBootstrap()
      return renderer.desktop.generateFromCanvas({
        scene: bootstrap.scene,
        originalRequirement: '生成完整的雨夜唱片封面，保持当前构图与柔和蓝色背光',
        providerId: 'mock',
        model: 'mock-balanced',
        count: 1,
        sourceMessageId: null
      })
    })
    expect(repeated.referenceAssetId).toBe(first.referenceAssetId)
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-result')).toHaveCount(3, { timeout: 15_000 })
    const sceneAfter = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const bootstrap = await renderer.desktop.getWorkspaceBootstrap()
      return { elementCount: bootstrap.scene.elements.length, ratio: [bootstrap.scene.canvas.aspectWidth, bootstrap.scene.canvas.aspectHeight] }
    })
    expect(sceneAfter).toEqual({ elementCount: 1, ratio: [4, 5] })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
