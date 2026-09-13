import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { openDirectionReview } from '../helpers/workbench-ui'

const REQUEST = '创建一张 3:2 的雨夜唱片封面，标题是 AFTER RAIN，黑胶唱片放在右下方，后方有柔和轮廓光。先不要生成图片。'

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

test('AC-01 creates one persistent layout through conversation without implicit generation', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-agent-'))
  let running: ElectronApplication | null = null
  try {
    const first = await launch(userData)
    running = first.app
    await first.window.getByRole('button', { name: '对话' }).evaluate((button) => button.click())
    await expect(first.window.locator('.conversation-title')).toContainText('4:5 · 可编辑画布 · 0 个元素')
    await first.window.getByRole('textbox', { name: '对话输入' }).fill(REQUEST)
    await first.window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(first.window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    await expect(first.window.getByRole('region', { name: '完成与验收事实' })).toContainText('结构检查通过')
    await expect(first.window.getByTestId('operation-receipt').getByText('创建 3:2 唱片封面布局')).toBeVisible()
    await openDirectionReview(first.window)
    await expect(first.window.getByRole('region', { name: '设计方向与本地评估' })).toBeVisible()
    await expect(first.window.getByText('唱片轨道', { exact: true })).toBeVisible()
    await expect(first.window.getByText(/\/40$/)).toBeVisible()
    await expect(first.window.getByRole('button', { name: '撤销这次修改' })).toBeVisible()
    await expect(first.window.locator('body')).not.toContainText('scene_batch')
    await expect(first.window.locator('body')).not.toContainText('toolIndex')

    const firstState = await first.window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const [bootstrap, jobs] = await Promise.all([
        renderer.desktop.getWorkspaceBootstrap(),
        renderer.desktop.listGenerationJobs()
      ])
      return {
        revision: bootstrap.scene.revision,
        ratio: [bootstrap.scene.canvas.aspectWidth, bootstrap.scene.canvas.aspectHeight],
        elements: bootstrap.scene.elements.map((element) => ({ name: element.name, type: element.type })),
        jobs: jobs.length
      }
    })
    expect(firstState).toMatchObject({
      ratio: [3, 2],
      elements: [
        { name: '背景基底', type: 'shape' },
        { name: '唱片主体组', type: 'group' },
        { name: '唱片圆盘', type: 'shape' },
        { name: '中心标', type: 'shape' },
        { name: '声波轨迹', type: 'sketch' },
        { name: '黑胶唱片', type: 'placeholder' },
        { name: '构图光影', type: 'light' },
        { name: '主标题', type: 'text' }
      ],
      jobs: 0
    })
    expect(firstState.revision).toBeGreaterThan(0)

    await first.window.getByRole('button', { name: '撤销这次修改' }).evaluate((button) => button.click())
    await expect(first.window.getByRole('button', { name: '重做' })).toBeEnabled()
    await first.window.getByRole('button', { name: '重做' }).evaluate((button) => button.click())
    await first.window.waitForFunction(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const bootstrap = await renderer.desktop.getWorkspaceBootstrap()
      return bootstrap.scene.canvas.aspectWidth === 3 && bootstrap.scene.elements.some((element) => element.name === '构图光影')
    })

    await first.app.close()
    running = null

    const ledger = new Database(join(userData, 'projects', 'Untitled.aicanvas', 'project.db'), { readonly: true })
    const sceneToolCall = ledger.prepare(`
      SELECT status, tool_name, operation_batch_id, scene_revision_after, result_json
      FROM agent_tool_calls_v2 ORDER BY created_at DESC LIMIT 1
    `).get() as {
      status: string
      tool_name: string
      operation_batch_id: string | null
      scene_revision_after: number | null
      result_json: string | null
    }
    ledger.close()
    expect(sceneToolCall).toMatchObject({
      status: 'completed',
      tool_name: 'scene.apply_batch',
      operation_batch_id: expect.any(String),
      scene_revision_after: firstState.revision,
      result_json: expect.any(String)
    })

    const reopened = await launch(userData)
    running = reopened.app
    await reopened.window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await expect(reopened.window.getByRole('paragraph').filter({ hasText: REQUEST })).toBeVisible()
    await expect(reopened.window.getByTestId('operation-receipt')).toBeVisible()
    await reopened.window.getByRole('button', { name: '画布', exact: true }).evaluate((button) => button.click())
    const layers = reopened.window.getByRole('listbox', { name: '图层' }).getByRole('option')
    await expect(layers).toHaveCount(8)
    await expect(reopened.window.getByText('唱片主体组', { exact: true })).toBeVisible()
    await expect(reopened.window.getByText('主标题', { exact: true })).toBeVisible()
    await expect(reopened.window.getByText('构图光影', { exact: true })).toBeVisible()

    await reopened.window.getByText('主标题', { exact: true }).evaluate((element) => element.click())
    await reopened.window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())
    await expect(reopened.window.getByRole('button', { name: /主标题/ })).toBeVisible()
    await reopened.window.getByRole('textbox', { name: '对话输入' }).fill('把选中的标题做得更厚一点')
    await reopened.window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(reopened.window.getByText('已按当前选区完成调整。')).toBeVisible({ timeout: 10_000 })
    await expect(reopened.window.getByTestId('operation-receipt')).toHaveCount(2)
    await expect(reopened.window.getByRole('paragraph').filter({ hasText: REQUEST })).toBeVisible()
    await expect(reopened.window.getByRole('button', { name: /早期创作记录/ })).toHaveCount(0)
  } finally {
    if (running !== null) await running.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
