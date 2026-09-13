import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
}

async function nextSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const mutable = dialog as unknown as { showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }> }
    mutable.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target })
  }, filePath)
}

async function nextOpenDialog(app: ElectronApplication, directory: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const mutable = dialog as unknown as { showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }> }
    mutable.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] })
  }, directory)
}

test('creates, imports, saves as, opens and restarts a persistent desktop project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-projects-'))
  const userData = join(root, 'user-data')
  const projectA = join(root, 'Poster A.aicanvas')
  const projectB = join(root, 'Poster B.aicanvas')
  const scratch = join(root, 'Scratch.aicanvas')
  let app: ElectronApplication | null = await launch(userData)
  try {
    let window = await app.firstWindow()
    await nextSaveDialog(app, projectA)
    await window.getByRole('button', { name: /^项目菜单：/ }).evaluate((button) => button.click())
    await window.getByRole('menuitem', { name: '新建空白项目' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '项目菜单：Poster A' })).toBeVisible()

    const fileInput = window.locator('input[type="file"]').last()
    await fileInput.setInputFiles(resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png'))
    await expect(window.getByRole('listbox', { name: '图层' }).getByText('导入图片')).toBeVisible({ timeout: 10_000 })
    const imported = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const image = bootstrap.scene.elements.find((element) => element.type === 'image')
      return { projectName: bootstrap.projectName, assetId: image?.type === 'image' ? image.assetId : null }
    })
    expect(imported).toMatchObject({ projectName: 'Poster A' })
    expect(imported.assetId).toMatch(/[0-9a-f-]{36}/)
    await expect(stat(join(projectA, 'assets', 'original'))).resolves.toBeDefined()

    await nextSaveDialog(app, projectB)
    await window.getByRole('button', { name: '项目菜单：Poster A' }).evaluate((button) => button.click())
    await window.getByRole('menuitem', { name: '另存为' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '项目菜单：Poster B' })).toBeVisible()

    await nextSaveDialog(app, scratch)
    await window.getByRole('button', { name: '项目菜单：Poster B' }).evaluate((button) => button.click())
    await window.getByRole('menuitem', { name: '新建空白项目' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '项目菜单：Scratch' })).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByText('导入图片')).toHaveCount(0)

    await nextOpenDialog(app, projectB)
    await window.getByRole('button', { name: '项目菜单：Scratch' }).evaluate((button) => button.click())
    await window.getByRole('menuitem', { name: '打开项目' }).evaluate((button) => button.click())
    await expect(window.getByRole('button', { name: '项目菜单：Poster B' })).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByText('导入图片')).toBeVisible()

    await app.close()
    const originals = await readdir(join(projectB, 'assets', 'original'))
    expect(originals).toHaveLength(1)
    await unlink(join(projectB, 'assets', 'original', originals[0]!))
    app = await launch(userData)
    window = await app.firstWindow()
    await expect(window.getByRole('button', { name: '项目菜单：Poster B' })).toBeVisible()
    await expect(window.getByRole('listbox', { name: '图层' }).getByText('导入图片')).toBeVisible({ timeout: 10_000 })
    const missing = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      try {
        await api.readGenerationAsset(assetId, false)
        return false
      } catch {
        return true
      }
    }, imported.assetId!)
    expect(missing).toBe(true)
    await window.locator('input[type="file"]').last().setInputFiles(resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png'))
    await expect(window.locator('.canvas-tool-problem')).toContainText('已重新关联')
    const relinked = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      return {
        imageCount: bootstrap.scene.elements.filter((element) => element.type === 'image').length,
        dataUrl: await api.readGenerationAsset(assetId, false)
      }
    }, imported.assetId!)
    expect(relinked.imageCount).toBe(1)
    expect(relinked.dataUrl).toMatch(/^data:image\/png;base64,/)
    const restoredData = await window.locator('canvas').evaluateAll((canvases) => canvases.length)
    expect(restoredData).toBeGreaterThan(0)
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})
