import { openDirectionReview } from '../helpers/workbench-ui'
import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const REQUEST = '创建一个 4:5 的视觉封面，主体保持中性，先不要生成图片。'

test('C-S2/D-S1 keeps one direction across Agent generation, final continuation, placement and placement-only Undo', async () => {
  test.setTimeout(75_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-c-s2-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.setViewportSize({ width: 1280, height: 800 })
    await window.waitForLoadState('domcontentloaded')

    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await openDirectionReview(window)
    const review = window.getByRole('region', { name: '设计方向与本地评估' })
    const cards = review.locator('.design-direction-grid > article')
    await expect(cards).toHaveCount(3, { timeout: 12_000 })
    await cards.nth(1).getByRole('button', { name: '采用此方向' }).evaluate((button) => button.click())
    await expect(cards.nth(1).getByRole('button', { name: '已采用' })).toBeVisible({ timeout: 10_000 })

    const selected = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return {
        briefId: scene.creativeContext?.brief.id ?? null,
        directionId: scene.creativeContext?.selectedDirectionId ?? null,
        directionTitle: scene.creativeContext?.directions?.find((direction) => direction.id === scene.creativeContext?.selectedDirectionId)?.title ?? null,
        elementIds: scene.elements.map((element) => element.id)
      }
    })
    expect(selected.briefId).not.toBeNull()
    expect(selected.directionId).not.toBeNull()
    expect(selected.directionTitle).not.toBeNull()

    await window.getByRole('textbox', { name: '对话输入' }).fill('依据当前画布与已选设计方向生成图片，保持结构与安静留白。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect.poll(async () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationJobs()).find((job) => job.request.parameters.mode === 'canvas')?.status ?? null
    }), { timeout: 15_000 }).toBe('completed')

    await window.getByRole('button', { name: '生成', exact: true }).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
    await expect(window.locator('.saved-mark')).toContainText('已保存')
    await expect(window.locator('.provider-boundary')).toContainText('本地离线档不联网')

    const generated = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const jobs = await api.listGenerationJobs()
      const job = jobs.find((candidate) => candidate.request.parameters.mode === 'canvas')
      if (job === undefined || job.results[0] === undefined) throw new Error('Expected one completed canvas-generation job.')
      return {
        job: {
          providerId: job.providerId,
          status: job.status,
          actualCostCny: job.request.parameters.actualCostCny,
          promptPackage: job.request.parameters.promptPackage
        },
        resultId: job.results[0].id,
        assetId: job.results[0].assetId
      }
    })
    expect(generated.job).toMatchObject({
      providerId: 'mock',
      status: 'completed',
      actualCostCny: 0,
      promptPackage: {
        provenance: {
          briefId: selected.briefId,
          directionId: selected.directionId
        }
      }
    })
    await window.getByTestId('result-family-summary').getByRole('button').first().evaluate((button) => button.click())
    await expect(window.locator('.result-provenance')).toContainText(`设计方向${selected.directionTitle}`)

    await window.getByRole('button', { name: '继续变化' }).evaluate((button) => button.click())
    await expect(window.getByTestId('generation-prompt')).toHaveValue('依据当前画布与已选设计方向生成图片，保持结构与安静留白。')
    await openGenerationOptions(window)
    await window.getByRole('group', { name: '生成档位' }).getByRole('button', { name: '本地定稿预演' }).evaluate((button) => button.click())
    await openGenerationOptions(window)
    await window.getByLabel('生成数量').selectOption('1')
    await window.getByRole('textbox', { name: '本次变化' }).fill('让光线更柔和')
    await window.getByRole('textbox', { name: '本次变化' }).blur()
    await window.getByRole('textbox', { name: '保持不变' }).fill('保持已选设计方向、主体结构、画面比例与留白')
    await window.getByRole('textbox', { name: '保持不变' }).blur()
    await window.getByTestId('generation-submit').click()
    const confirmation = window.getByRole('alertdialog', { name: '确认生成' })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '确认生成' }).evaluate((button) => button.click())
    await expect.poll(async () => window.evaluate(async (rootResultId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const child = (await api.listGenerationJobs())
        .flatMap((job) => job.results.map((result) => ({ job, result })))
        .find((entry) => entry.result.parentResultId === rootResultId)
      return child?.job.status ?? null
    }, generated.resultId), { timeout: 15_000 }).toBe('completed')
    await expect(window.getByTestId('generation-result')).toHaveCount(2)
    await window.locator(`[data-testid="generation-result"][data-parent-result="${generated.resultId}"]`).evaluate((button) => button.click())
    await expect(window.locator('.result-provenance')).toContainText(`设计方向${selected.directionTitle}`)
    const continued = await window.evaluate(async (rootResultId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const child = (await api.listGenerationJobs())
        .flatMap((job) => job.results.map((result) => ({ job, result })))
        .find((entry) => entry.result.parentResultId === rootResultId)
      if (child === undefined) throw new Error('Expected one continued final result.')
      const family = (await api.listGenerationResultFamilies()).find((candidate) =>
        candidate.members.some((member) => member.resultId === child.result.id)
      )
      const member = family?.members.find((candidate) => candidate.resultId === child.result.id)
      return { resultId: child.result.id, assetId: child.result.assetId, member: member ?? null }
    }, generated.resultId)
    expect(continued.member).toMatchObject({
      parentResultId: generated.resultId,
      sourceBriefId: selected.briefId,
      sourceDirectionId: selected.directionId,
      promptPackageHash: expect.any(String),
      variationInstruction: '让光线更柔和',
      preserveConstraints: '保持已选设计方向、主体结构、画面比例与留白'
    })

    await window.getByTestId('insert-generation-result').evaluate((button) => button.click())
    await expect(window.getByTestId('canvas-stage')).toBeVisible()
    const placed = await window.evaluate(async (resultAssetId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const result = scene.elements.find((element) => element.type === 'image' && element.assetId === resultAssetId)
      return {
        directionId: scene.creativeContext?.selectedDirectionId ?? null,
        element: result ?? null
      }
    }, continued.assetId)
    expect(placed).toMatchObject({
      directionId: selected.directionId,
      element: {
        type: 'image',
        provenance: {
          sourceBriefId: selected.briefId,
          sourceDirectionId: selected.directionId,
          sourceAssetId: continued.assetId
        }
      }
    })

    await window.getByLabel('撤销', { exact: true }).evaluate((button) => button.click())
    await expect.poll(async () => window.evaluate(async (resultAssetId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return {
        directionId: scene.creativeContext?.selectedDirectionId ?? null,
        resultPresent: scene.elements.some((element) => element.type === 'image' && element.assetId === resultAssetId),
        elementIds: scene.elements.map((element) => element.id)
      }
    }, continued.assetId)).toEqual({ directionId: selected.directionId, resultPresent: false, elementIds: selected.elementIds })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
