import { openDirectionReview } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const REQUEST = '创建一个 4:5 的视觉封面，主体保持中性，先不要生成图片。'

async function launch(userData: string): Promise<{ readonly app: ElectronApplication; readonly window: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

test('C-S1 selects a stable non-recommended direction, persists it and undoes it as one batch', async () => {
  test.setTimeout(75_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-direction-'))
  let running: ElectronApplication | null = null
  try {
    const first = await launch(userData)
    running = first.app
    await first.window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await first.window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await first.window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await openDirectionReview(first.window)
    const review = first.window.getByRole('region', { name: '设计方向与本地评估' })
    await expect(review).toBeVisible({ timeout: 12_000 })
    const cards = review.locator('.design-direction-grid > article')
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(0).getByRole('button', { name: '已采用' })).toBeVisible()

    const before = await first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      return {
        revision: bootstrap.scene.revision,
        selected: bootstrap.scene.creativeContext?.selectedDirectionId,
        directions: bootstrap.scene.creativeContext?.directions?.map((direction) => direction.id) ?? []
      }
    })
    await cards.nth(1).getByRole('button', { name: '采用此方向' }).evaluate((button) => button.click())
    await expect(cards.nth(1).getByRole('button', { name: '已采用' })).toBeVisible({ timeout: 10_000 })
    await expect(review.getByRole('status')).toContainText('已切换到')
    await first.window.getByRole('button', { name: '本轮执行记录', exact: true }).click()
    await expect(first.window.getByTestId('agent-live-plan').getByText('设计方向已切换', { exact: true })).toBeVisible()

    const after = await first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, conversation, jobs] = await Promise.all([
        api.getWorkspaceBootstrap(),
        api.getConversationSnapshot(),
        api.listGenerationJobs()
      ])
      const context = bootstrap.scene.creativeContext
      return {
        revision: bootstrap.scene.revision,
        selected: context?.selectedDirectionId,
        planDirection: context?.plan.directionId,
        provenance: context === null || context === undefined
          ? []
          : bootstrap.scene.elements
              .filter((element) => context.plan.elements.some((planned) => planned.id === element.id))
              .map((element) => element.provenance?.sourceDirectionId),
        directionActivities: conversation.activities.filter((activity) => activity.eventType === 'direction.completed').length,
        jobs: jobs.length
      }
    })
    expect(after.revision).toBe(before.revision + 1)
    expect(after.selected).toBe(before.directions[1])
    expect(after.planDirection).toBe(after.selected)
    expect(after.provenance.every((directionId) => directionId === after.selected)).toBe(true)
    expect(after.directionActivities).toBe(1)
    expect(after.jobs).toBe(0)

    await first.app.close()
    running = null

    const reopened = await launch(userData)
    running = reopened.app
    await reopened.window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await openDirectionReview(reopened.window)
    const reopenedReview = reopened.window.getByRole('region', { name: '设计方向与本地评估' })
    await expect(reopenedReview.locator('.design-direction-grid > article').nth(1).getByRole('button', { name: '已采用' })).toBeVisible()
    const persisted = await reopened.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.creativeContext?.selectedDirectionId
    })
    expect(persisted).toBe(after.selected)

    const undoButtons = reopened.window.getByRole('button', { name: '撤销这次修改' })
    await undoButtons.last().evaluate((button) => button.click())
    await expect(reopenedReview.locator('.design-direction-grid > article').nth(0).getByRole('button', { name: '已采用' })).toBeVisible()
    const undone = await reopened.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.getWorkspaceBootstrap()).scene.creativeContext?.selectedDirectionId
    })
    expect(undone).toBe(before.selected)
  } finally {
    if (running !== null) await running.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('C-S1 keeps manual canvas changes and exposes an explicit conflict decision', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-direction-conflict-'))
  let running: ElectronApplication | null = null
  try {
    const value = await launch(userData)
    running = value.app
    await value.window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await value.window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await value.window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await openDirectionReview(value.window)
    const review = value.window.getByRole('region', { name: '设计方向与本地评估' })
    const cards = review.locator('.design-direction-grid > article')
    await expect(cards).toHaveCount(3, { timeout: 12_000 })
    const state = await value.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const subject = bootstrap.scene.elements.find((element) => element.semanticRole === 'subject')
      if (subject === undefined) throw new Error('Expected a subject element.')
      const result = await api.executeSceneCommands({
        expectedSceneRevision: bootstrap.scene.revision,
        batch: {
          id: crypto.randomUUID(),
          origin: 'user',
          summary: '手工移动主体',
          commands: [{ kind: 'element.update', elementId: subject.id, changes: { transform: { x: subject.transform.x + .04 } } }]
        }
      })
      if (!result.ok) throw new Error(result.error.message)
      return {
        selected: result.receipt.state.scene.creativeContext?.selectedDirectionId,
        subjectX: result.receipt.state.scene.elements.find((element) => element.id === subject.id)?.transform.x
      }
    })
    await cards.nth(1).getByRole('button', { name: '采用此方向' }).evaluate((button) => button.click())
    const decision = cards.nth(1).getByRole('group', { name: '方向切换需要你的决定' })
    await expect(decision).toBeVisible()
    await expect(decision).toContainText('系统没有覆盖这些内容')
    const unchanged = await value.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      return {
        selected: scene.creativeContext?.selectedDirectionId,
        subjectX: scene.elements.find((element) => element.semanticRole === 'subject')?.transform.x
      }
    })
    expect(unchanged).toEqual(state)
    await decision.getByRole('button', { name: '保留当前' }).evaluate((button) => button.click())
    await expect(decision).toBeHidden()
    await openDirectionReview(value.window)
    await expect(review.getByRole('status')).toContainText('已保留当前画布')
  } finally {
    if (running !== null) await running.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
