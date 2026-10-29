import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { samplePsd } from '../helpers/psd-fixture'

const IMAGE = resolve('tests/visual/__screenshots__/m3-canvas-1024x700.png')

async function launch(extraArgs: readonly string[] = []): Promise<{ app: ElectronApplication, page: Page }> {
  const userData = await mkdtemp(join(tmpdir(), 'ps-keys-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, ...extraArgs],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  return { app, page }
}

async function bootstrap(page: Page) {
  return page.evaluate(async () => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
}

/** A point on the artboard, in page coordinates, from fractions of its width and height. */
async function artboardPoint(page: Page, x: number, y: number): Promise<{ x: number, y: number }> {
  return await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="canvas-stage"]')
    const surface = root?.querySelector('.konvajs-content')
    if (!(root instanceof HTMLElement) || !(surface instanceof HTMLElement)) throw new Error('No canvas.')
    const rect = surface.getBoundingClientRect()
    return {
      x: rect.left + Number(root.dataset.artboardX) + ${x} * Number(root.dataset.artboardWidth),
      y: rect.top + Number(root.dataset.artboardY) + ${y} * Number(root.dataset.artboardHeight)
    }
  })()`) as { x: number, y: number }
}

async function newCanvas(page: Page): Promise<void> {
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
}

test('the eyedropper sets the foreground colour, and with Alt the background', async () => {
  const { app, page } = await launch()
  try {
    await newCanvas(page)
    const before = await bootstrap(page)
    const result = await page.evaluate((input) => (globalThis as unknown as { desktop: DesktopApi }).desktop.executeSceneCommands(input), {
      projectId: before.projectId,
      expectedSceneRevision: before.scene.revision,
      batch: { id: crypto.randomUUID(), origin: 'user' as const, summary: '背景色', commands: [{ kind: 'scene.set-canvas' as const, canvas: { ...before.scene.canvas, transparent: false, backgroundColor: '#336699' } }] }
    })
    expect(result.ok).toBe(true)
    await page.keyboard.press('i')
    await expect(page.getByRole('button', { name: '吸管' })).toHaveAttribute('aria-pressed', 'true')
    const point = await artboardPoint(page, 0.1, 0.1)
    const foreground = page.getByLabel('前景色', { exact: true })
    // The new background reaches the canvas a frame or two after Main accepts it.
    await expect.poll(async () => { await page.mouse.click(point.x, point.y); return foreground.inputValue() }).toBe('#336699')
    await page.keyboard.down('Alt')
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up('Alt')
    await expect(page.getByLabel('背景色', { exact: true })).toHaveValue('#336699')
    await page.keyboard.press('d')
    await expect(page.getByLabel('前景色', { exact: true })).toHaveValue('#000000')
  } finally {
    await app.close()
  }
})

test('Alt+drag drops a copy and leaves the original where it was', async () => {
  const { app, page } = await launch()
  try {
    await newCanvas(page)
    await page.getByRole('button', { name: '形状', exact: true }).click()
    await expect.poll(async () => (await bootstrap(page)).scene.elements.length).toBe(1)
    const original = (await bootstrap(page)).scene.elements[0]!
    const from = await artboardPoint(page, original.transform.x + original.transform.width / 2, original.transform.y + original.transform.height / 2)
    await page.keyboard.down('Alt')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.length).toBe(2)
    const scene = (await bootstrap(page)).scene
    const kept = scene.elements.find((element) => element.id === original.id)!
    const copy = scene.elements.find((element) => element.id !== original.id)!
    expect(kept.transform).toEqual(original.transform)
    expect(copy.name).toBe(`${original.name} 副本`)
    expect(copy.transform.x).toBeGreaterThan(original.transform.x)
    expect(copy.zIndex).toBe(kept.zIndex + 1)
  } finally {
    await app.close()
  }
})

test('Ctrl+O opens an image as a new project the size of the image', async () => {
  const { app, page } = await launch()
  try {
    await newCanvas(page)
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Control+o')
    await (await chooser).setFiles(IMAGE)
    await expect(page.getByRole('button', { name: '项目菜单：m3-canvas-1024x700' })).toBeVisible({ timeout: 10_000 })
    const opened = await bootstrap(page)
    expect(opened.scene.canvas).toMatchObject({ outputWidth: 1024, outputHeight: 700 })
    expect(opened.scene.elements).toHaveLength(1)
    expect(opened.scene.elements[0]).toMatchObject({ type: 'image', transform: { x: 0, y: 0, width: 1, height: 1 } })
    expect(['背景', '图层 0']).toContain(opened.scene.elements[0]!.name)
  } finally {
    await app.close()
  }
})

test('an image named when the app starts opens as a project, as from Explorer', async () => {
  const { app, page } = await launch([IMAGE])
  try {
    await expect(page.getByRole('button', { name: '项目菜单：m3-canvas-1024x700' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    const opened = await bootstrap(page)
    expect(opened.scene.canvas).toMatchObject({ outputWidth: 1024, outputHeight: 700 })
    expect(opened.scene.elements.filter((element) => element.type === 'image')).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('Ctrl+O on the project library opens an image as a project too', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Control+o')
    await (await chooser).setFiles(IMAGE)
    await expect(page.getByRole('button', { name: '项目菜单：m3-canvas-1024x700' })).toBeVisible({ timeout: 10_000 })
    expect((await bootstrap(page)).scene.canvas).toMatchObject({ outputWidth: 1024, outputHeight: 700 })
  } finally {
    await app.close()
  }
})

async function samplePsdFile(name = '海报.psd'): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'psd-')), name)
  await writeFile(path, samplePsd())
  return path
}

test('Ctrl+O opens a PSD as a project with its layers, group and a note on what changed', async () => {
  // Playwright's file chooser drops a non-ASCII file name here; the launch test below covers one.
  const psd = await samplePsdFile('poster.psd')
  const { app, page } = await launch()
  try {
    await newCanvas(page)
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Control+o')
    await (await chooser).setFiles(psd)
    await expect(page.getByRole('button', { name: '项目菜单：poster' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.app-notice')).toContainText('已打开“poster.psd”，5 个图层')
    const opened = (await bootstrap(page)).scene
    expect(opened.canvas).toMatchObject({ outputWidth: 200, outputHeight: 100, transparent: false })
    expect(opened.elements.filter((element) => element.type === 'image').map((element) => element.name)).toEqual(['背景', '阴影', '草稿', '柔光', '减淡', 'PSD 原样（对照用）'])
    // The PSD's layer mask stays a mask, shown beside the layer's thumbnail.
    expect(opened.elements.find((element) => element.name === '柔光')).toMatchObject({ mask: { enabled: true } })
    await expect(page.getByRole('button', { name: '柔光 的蒙版' })).toBeVisible()
    const group = opened.elements.find((element) => element.type === 'group')
    expect(group).toMatchObject({ name: '标题组' })
    const layers = page.getByRole('listbox', { name: '图层' })
    await expect(layers.getByText('标题组', { exact: true })).toBeVisible()
    await expect(layers.getByText('PSD 原样（对照用）', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a PSD named when the app starts opens as a project, as from Explorer', async () => {
  const psd = await samplePsdFile()
  const { app, page } = await launch([psd])
  try {
    await expect(page.getByRole('button', { name: '项目菜单：海报' })).toBeVisible({ timeout: 15_000 })
    expect((await bootstrap(page)).scene.elements.filter((element) => element.type === 'image')).toHaveLength(6)
  } finally {
    await app.close()
  }
})
