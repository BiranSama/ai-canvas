import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

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

    // The first message starts a task by itself, so there is nothing to choose yet.
    await expect(window.getByRole('button', { name: '新任务', exact: true })).toHaveCount(0)
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 4:5 的蓝色产品海报，主体是玻璃杯，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })

    // After that, 新任务 by the title makes the next message a separate task; the composer itself stays free of switches.
    await expect(window.getByRole('group', { name: '这条要求与当前任务的关系' })).toHaveCount(0)
    const newTask = window.getByRole('button', { name: '新任务', exact: true })
    await expect(newTask).toHaveAttribute('aria-pressed', 'false')
    await expect(newTask).toBeEnabled()
    await newTask.evaluate((button) => button.click())
    await expect(newTask).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByRole('textbox', { name: '对话输入' })).toHaveAttribute('placeholder', '描述新的作品…')
    await window.getByRole('textbox', { name: '对话输入' }).fill('创建一张 1:1 的暖金咖啡海报，先不要生成图片。')
    await window.getByRole('button', { name: '发送要求' }).evaluate((button) => button.click())
    await expect(window.getByTestId('operation-receipt')).toHaveCount(1, { timeout: 10_000 })
    await expect(newTask).toHaveAttribute('aria-pressed', 'false')

    const database = new Database(join(userData, 'projects', 'Untitled.aicanvas', 'project.db'), { readonly: true })
    const turns = database.prepare(`
      SELECT task_relation, dispatch_mode, temporary_state, task_id, base_task_id
      FROM agent_turns_v2 ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>
    database.close()
    expect(turns).toEqual([
      expect.objectContaining({ task_relation: 'new_task', dispatch_mode: 'apply_now', temporary_state: null }),
      expect.objectContaining({ task_relation: 'new_task', dispatch_mode: 'apply_now', temporary_state: null })
    ])
    expect(turns[1]?.task_id).not.toBe(turns[0]?.task_id)
  } finally {
    if (app !== null) await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
