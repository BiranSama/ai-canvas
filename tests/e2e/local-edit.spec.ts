import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

function listJobs(page: Page) {
  return page.evaluate(() => {
    const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
    return renderer.desktop.listGenerationJobs()
  })
}

test('AC-04 keeps the source immutable and retains a failed mask edit for exact retry', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-local-edit-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await window.getByTestId('generation-prompt').fill('Stable source for a local edit')
    await window.getByTestId('generation-submit').click()
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    const sourceJob = (await listJobs(window))[0]
    const sourceResult = sourceJob?.results[0]
    expect(sourceResult).toBeDefined()
    const sourceBefore = await window.evaluate(async (assetId) => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.readGenerationAsset(assetId, false)
    }, sourceResult!.assetId)

    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())
    await window.getByRole('button', { name: '蒙版' }).evaluate((button) => button.click())
    const maskSurface = window.getByTestId('canvas-stage').locator('.konvajs-content')
    const surfaceRect = await maskSurface.boundingBox()
    if (surfaceRect === null) throw new Error('Canvas event surface is missing.')
    const centerX = surfaceRect.x + surfaceRect.width * 0.5
    const centerY = surfaceRect.y + surfaceRect.height * 0.44
    const path = [
      { x: centerX - 34, y: centerY - 22 },
      { x: centerX + 34, y: centerY - 22 },
      { x: centerX + 34, y: centerY + 22 },
      { x: centerX - 34, y: centerY + 22 },
      { x: centerX - 34, y: centerY - 22 }
    ]
    const dispatchMaskPointer = async (type: 'mousedown' | 'mousemove' | 'mouseup', point: { readonly x: number; readonly y: number }): Promise<void> => {
      await maskSurface.evaluate((surface, event) => {
      const BrowserMouseEvent = Reflect.get(globalThis, 'MouseEvent') as new (
        type: string,
        init: unknown
      ) => Parameters<typeof surface.dispatchEvent>[0]
        surface.dispatchEvent(new BrowserMouseEvent(event.type, {
          bubbles: true,
          clientX: event.point.x,
          clientY: event.point.y,
          button: 0,
          buttons: event.type === 'mouseup' ? 0 : 1
        }))
      }, { type, point })
      await window.waitForTimeout(16)
    }
    await dispatchMaskPointer('mousedown', path[0]!)
    for (const point of path.slice(1)) await dispatchMaskPointer('mousemove', point)
    await dispatchMaskPointer('mouseup', path.at(-1)!)
    await expect(window.getByTestId('local-edit-submit')).toBeVisible()

    await expect.poll(async () => {
      const bootstrap = await window.evaluate(async () => {
        const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
        return renderer.desktop.getWorkspaceBootstrap()
      })
      return bootstrap.scene.elements.filter((element) => element.type === 'mask').length
    }).toBe(1)

    const failedJobId = await window.evaluate(async ({ sourceResultId }) => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const bootstrap = await renderer.desktop.getWorkspaceBootstrap()
      const mask = bootstrap.scene.elements.find((element) => element.type === 'mask')
      if (mask?.type !== 'mask') throw new Error('Mask was not persisted.')
      const target = bootstrap.scene.elements.find((element) => element.id === mask.targetElementId)
      if (target?.type !== 'image') throw new Error('Mask target is missing.')
      const submitted = await renderer.desktop.editFromCanvas({
        scene: bootstrap.scene,
        targetElementId: target.id,
        prompt: 'Replace the marked area with blue glass; keep all other pixels unchanged.',
        negativePrompt: '',
        providerId: 'mock',
        model: 'mock-failure',
        count: 1,
        sourceMessageId: null,
        parentResultId: sourceResultId
      })
      return submitted.jobId
    }, { sourceResultId: sourceResult!.id })
    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window)).find((job) => job.id === failedJobId)?.status).toBe('failed')
    await expect(window.getByTestId('generation-status')).toContainText('本地离线引擎 · 失败状态验证')
    await expect(window.getByTestId('generation-status')).toContainText('要求已保留')

    const failed = (await listJobs(window)).find((job) => job.id === failedJobId)
    expect(failed?.request).toMatchObject({
      kind: 'edit',
      prompt: 'Replace the marked area with blue glass; keep all other pixels unchanged.',
      sourceAssetId: sourceResult!.assetId,
      parentResultId: sourceResult!.id,
      parameters: { mode: 'local-edit' }
    })
    const sourceAfterFailure = await window.evaluate(async (assetId) => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.readGenerationAsset(assetId, false)
    }, sourceResult!.assetId)
    expect(sourceAfterFailure).toBe(sourceBefore)

    await window.getByRole('button', { name: /展开参数/ }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByLabel('模型情景').selectOption('mock-balanced')
    await window.getByTestId('generation-status').getByRole('button', { name: '重试' }).evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window))[0]?.status).toBe('completed')
    await expect(window.getByTestId('generation-result')).toHaveCount(2)
    await window.getByRole('button', { name: /结果家族/ }).evaluate((button) => button.click())
    await expect(window.getByText('局部修改', { exact: true })).toBeVisible()
    const retried = (await listJobs(window))[0]
    expect(retried).toMatchObject({ parentJobId: failedJobId, request: { kind: 'edit' } })
    expect(retried?.results[0]?.parentResultId).toBe(sourceResult!.id)
    expect(retried?.results[0]?.assetId).not.toBe(sourceResult!.assetId)
    expect(await window.evaluate(async (assetId) => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return renderer.desktop.readGenerationAsset(assetId, false)
    }, sourceResult!.assetId)).toBe(sourceBefore)

    await window.getByRole('button', { name: '比较', exact: true }).evaluate((button) => button.click())
    await expect(window.locator('.result-focus.is-comparing > img')).toHaveCount(2)
    await window.getByRole('button', { name: '结束比较' }).evaluate((button) => button.click())
    await window.getByRole('button', { name: '放入画布' }).evaluate((button) => button.click())
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    await window.getByRole('listbox', { name: '图层' }).getByRole('option').filter({ hasText: '局部修改区域' }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '创作输入' }).fill('把蒙版标记的局部改成更柔和的蓝色玻璃')
    await window.getByRole('button', { name: '发送创作指令' }).evaluate((button) => button.click())
    await expect.poll(async () => (await listJobs(window)).find((job) =>
      'kind' in job.request && job.request.kind === 'edit' && job.sourceMessageId !== null && job.status === 'completed'
    )?.status, { timeout: 15_000 }).toBe('completed')
    await expect(window.getByText('源图、蒙版与新版本均已保留')).toBeVisible()
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
