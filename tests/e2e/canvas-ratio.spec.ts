import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function sceneState(page: Page) {
  return page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
    const bootstrap = await api.getWorkspaceBootstrap()
    return {
      ratio: [bootstrap.scene.canvas.aspectWidth, bootstrap.scene.canvas.aspectHeight],
      output: [bootstrap.scene.canvas.outputWidth, bootstrap.scene.canvas.outputHeight],
      transforms: bootstrap.scene.elements.map((element) => element.transform)
    }
  })
}

test('AC-R1-02 applies a free canvas ratio with three explicit atomic resize strategies', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-ratio-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    for (let index = 0; index < 3; index += 1) await window.getByRole('button', { name: '形状', exact: true }).evaluate((button) => button.click())
    const original = await sceneState(window)
    expect(original.ratio).toEqual([4, 5])

    const results: Record<string, unknown> = {}
    for (const strategy of ['保持位置', '适应内容', '保持中心']) {
      await window.getByRole('button', { name: '画布尺寸' }).evaluate((button) => button.click())
      const dialog = window.getByRole('dialog', { name: '画布尺寸设置' })
      await dialog.getByLabel('自由画布比例').fill('3:2')
      await dialog.getByRole('button', { name: new RegExp(`^${strategy}`) }).evaluate((button) => button.click())
      await dialog.getByRole('button', { name: '应用画布尺寸' }).evaluate((button) => button.click())
      await expect.poll(async () => (await sceneState(window)).ratio).toEqual([3, 2])
      const resized = await sceneState(window)
      expect(resized.output).toEqual([1280, 853])
      results[strategy] = resized.transforms
      await window.getByRole('button', { name: '撤销' }).evaluate((button) => button.click())
      await expect.poll(async () => await sceneState(window)).toEqual(original)
    }

    expect(results['适应内容']).not.toEqual(results['保持位置'])
    expect(results['保持中心']).not.toEqual(results['保持位置'])
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('AC-R1-09 submits a 7:5 Mock generation and preserves its result lineage on canvas', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-free-generation-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('抽象光影封面，纸张质感与克制的色块')
    await openGenerationOptions(window)
    await window.getByLabel('自由生成比例').fill('7:5')
    await expect(window.getByText('7:5 → 1280 × 914')).toBeVisible()
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('2')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(2, { timeout: 15_000 })
    await window.getByTestId('generation-result').nth(1).evaluate((button) => button.click())
    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())

    const readLineage = () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, jobs] = await Promise.all([api.getWorkspaceBootstrap(), api.listGenerationJobs()])
      const image = bootstrap.scene.elements.find((element) => element.type === 'image')
      const job = jobs[0]
      return {
        request: job === undefined ? null : {
          ratio: [job.request.aspectWidth, job.request.aspectHeight],
          output: [job.request.outputWidth, job.request.outputHeight]
        },
        assetId: image?.type === 'image' ? image.assetId : null,
        resultAssetIds: job?.results.map((result) => result.assetId) ?? []
      }
    })
    await expect.poll(async () => {
      const current = await readLineage()
      return current.assetId !== null && current.resultAssetIds.includes(current.assetId)
    }, { message: 'the inserted result should be persisted to the Main scene' }).toBe(true)
    const lineage = await readLineage()
    expect(lineage.request).toEqual({ ratio: [7, 5], output: [1280, 914] })
    expect(lineage.resultAssetIds).toContain(lineage.assetId)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
