import { _electron as electron, expect, test } from '@playwright/test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AC-R2-01 keeps a missing project card and relocates the exact package', async () => {
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-r2-library-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
  })
  let reopened: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    const window = await app.firstWindow()
    await window.getByRole('button', { name: /新建项目/ }).click({ force: true })
    await expect(window.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible()
    const project = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return api.getWorkspaceBootstrap()
    })
    await expect.poll(async () => window.evaluate(async (projectId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listRecentProjects()).some((candidate) => candidate.id === projectId)
    }, project.projectId)).toBe(true)
    const original = join(userData, 'projects', '未命名创作.aicanvas')
    const moved = join(userData, '项目已移动.aicanvas')
    await app.close()
    await cp(original, moved, { recursive: true })
    await rm(original, { recursive: true, force: true })
    reopened = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    const library = await reopened.firstWindow()
    await reopened.evaluate(({ dialog }, target) => {
      const mutable = dialog as unknown as { showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }> }
      mutable.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] })
    }, moved)
    const projects = await library.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return api.listRecentProjects()
    })
    expect(projects).toContainEqual(expect.objectContaining({ id: project.projectId, status: 'missing' }))
    await expect(library.getByText('项目已移动')).toBeVisible()
    await library.getByRole('button', { name: '重新定位' }).evaluate((button: { click(): void }) => button.click())
    await expect(library.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible()
    await reopened.close()
    reopened = null
  } finally {
    if (reopened !== null) await reopened.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true, maxRetries: 100, retryDelay: 200 })
  }
})
