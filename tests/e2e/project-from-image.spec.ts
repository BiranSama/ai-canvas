import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('creates a persistent project from the native image-first menu path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-image-project-'))
  const userData = join(root, 'user-data')
  const projectDirectory = join(root, 'Image Start.aicanvas')
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ dialog }, target) => {
      const mutable = dialog as unknown as { showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }> }
      mutable.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target })
    }, projectDirectory)
    await window.getByRole('button', { name: /^项目菜单：/ }).evaluate((button) => button.click())
    const chooserPromise = window.waitForEvent('filechooser')
    await window.getByRole('menuitem', { name: '从图片开始' }).evaluate((button) => button.click())
    const chooser = await chooserPromise
    await chooser.setFiles(resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png'))

    await expect(window.getByRole('button', { name: '项目菜单：Image Start' })).toBeVisible({ timeout: 10_000 })
    await expect(window.getByRole('listbox', { name: '图层' }).getByText('导入图片')).toBeVisible({ timeout: 10_000 })
    const bootstrap = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return api.getWorkspaceBootstrap()
    })
    expect(bootstrap.projectName).toBe('Image Start')
    expect(bootstrap.scene.elements.filter((element) => element.type === 'image')).toHaveLength(1)
    await expect(stat(join(projectDirectory, 'project.db'))).resolves.toBeDefined()
    await expect(stat(join(projectDirectory, 'assets', 'original'))).resolves.toBeDefined()
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
