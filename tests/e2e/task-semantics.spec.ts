import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('explicit task relation and temporary try remain inspectable and isolated', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-task-semantics-'))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: '1' }
    })
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.getByRole('button', { name: '对话', exact: true }).evaluate((button) => button.click())

    await expect(window.getByRole('button', { name: '新建创作任务' })).toHaveAttribute('aria-pressed', 'true')
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的蓝色产品海报，主体是玻璃杯，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
    const revisionAfterFormal = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return (await renderer.desktop.getWorkspaceBootstrap()).scene.revision
    })

    await window.getByRole('button', { name: '临时试一个方向' }).evaluate((button) => button.click())
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 1:1 的暖金咖啡海报，只作为临时方向，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('temporary-try-resolution')).toBeVisible({ timeout: 10_000 })
    const revisionWhilePending = await window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      return (await renderer.desktop.getWorkspaceBootstrap()).scene.revision
    })
    expect(revisionWhilePending).toBe(revisionAfterFormal)
    await window.getByRole('button', { name: '放弃', exact: true }).evaluate((button) => button.click())
    await expect(window.getByTestId('temporary-try-resolution')).toHaveCount(0)

    const database = new Database(join(userData, 'projects', 'Untitled.aicanvas', 'project.db'), { readonly: true })
    const turns = database.prepare(`
      SELECT task_relation, dispatch_mode, temporary_state, task_id, base_task_id
      FROM agent_turns_v2 ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>
    database.close()
    expect(turns).toEqual([
      expect.objectContaining({ task_relation: 'new_task', dispatch_mode: 'apply_now', temporary_state: null }),
      expect.objectContaining({ task_relation: 'temporary_try', dispatch_mode: 'apply_now', temporary_state: 'rejected' })
    ])
    expect(turns[1]?.base_task_id).toBe(turns[0]?.task_id)
  } finally {
    if (app !== null) await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
