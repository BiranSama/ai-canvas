import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { editPlacedResult, openEditor } from '../helpers/workbench-ui'

/*
 * The crop tool (C), 画布大小 (Ctrl+Alt+C), 生成式扩展, and rulers, guides,
 * grid and snapping: each change to the canvas is one step, every layer
 * stays where it is in pixels, and adjustment masks and guides follow.
 */

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = await mkdtemp(join(tmpdir(), 'crop-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  return { app, page }
}

async function scene(page: Page): Promise<Scene> {
  return page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene)
}

async function artboardPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="canvas-stage"]')
    const rect = root.querySelector('.konvajs-content').getBoundingClientRect()
    return { x: rect.left + Number(root.dataset.artboardX) + ${x} * Number(root.dataset.artboardWidth), y: rect.top + Number(root.dataset.artboardY) + ${y} * Number(root.dataset.artboardHeight) }
  })()`) as Promise<{ x: number; y: number }>
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + (to.x - from.x) * step / 10, from.y + (to.y - from.y) * step / 10)
  await page.mouse.up()
}

/** A new canvas with a red square (a pixel layer) and a curves adjustment layer whose mask is white on its left half. */
async function setUp(page: Page): Promise<{ width: number; height: number }> {
  await page.locator('.new-project-main').click()
  await openEditor(page)
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
  const result = await page.evaluate(async ({ version }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const current = (await api.getWorkspaceBootstrap()).scene
    const { outputWidth: width, outputHeight: height, } = current.canvas
    const red = new Uint8Array(100 * 100 * 4)
    for (let index = 0; index < 100 * 100; index += 1) red.set([220, 30, 30, 255], index * 4)
    const square = await api.importPixels({ projectId: current.projectId, name: '红方块', width: 100, height: 100, rgba: red })
    const gray = new Uint8Array(width * height)
    for (let y = 0; y < height; y += 1) gray.fill(255, y * width, y * width + Math.floor(width / 2))
    const mask = await api.importPixels({ projectId: current.projectId, name: '蒙版', width, height, gray })
    const base = { version, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include' as const, opacity: 1, zIndex: 0 }
    return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '准备', commands: [
      { kind: 'element.add', element: { ...base, id: crypto.randomUUID(), type: 'image', name: '方块', semanticRole: 'content', assetId: square.id, transform: { x: 200 / width, y: 150 / height, width: 300 / width, height: 300 / height, rotation: 0 }, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general' } },
      { kind: 'element.add', element: { ...base, id: crypto.randomUUID(), type: 'adjustment', name: '曲线', semanticRole: 'adjustment', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, settings: { kind: 'invert' }, mask: { assetId: mask.id, enabled: true } } },
      { kind: 'scene.set-canvas', canvas: { ...current.canvas, guides: [{ axis: 'x', position: 300 }] } }
    ] as never } })
  }, { version: ELEMENT_SCHEMA_VERSION })
  expect(result.ok).toBe(true)
  const current = await scene(page)
  return { width: current.canvas.outputWidth, height: current.canvas.outputHeight }
}

/** Where a layer's top-left corner is in canvas pixels. */
function corner(current: Scene, name: string): [number, number] {
  const layer = current.elements.find((element) => element.name === name)!
  return [Math.round(layer.transform.x * current.canvas.outputWidth * 100) / 100, Math.round(layer.transform.y * current.canvas.outputHeight * 100) / 100]
}

async function grayAsset(page: Page, assetId: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const url = await page.evaluate(`window.desktop.readGenerationAsset(${JSON.stringify(assetId)}, false)`) as string
  const { data, info } = await sharp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

function maskOf(current: Scene): string {
  const layer = current.elements.find((element) => element.name === '曲线') as Extract<SceneElement, { type: 'adjustment' }>
  return layer.mask!.assetId
}

test('the crop tool trims and extends the canvas in one step each, layers, guides and adjustment masks staying put', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  try {
    const { width, height } = await setUp(page)
    const before = await scene(page)
    await page.keyboard.press('c')
    const bar = page.getByTestId('crop-bar')
    await expect(bar).toBeVisible()
    // A frame 200 pixels narrower and 100 shorter about the middle, from the bar; Enter applies it.
    await bar.getByRole('spinbutton', { name: '裁剪宽度' }).fill(String(width - 200))
    await bar.getByRole('spinbutton', { name: '裁剪高度' }).fill(String(height - 100))
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width - 200)
    const cropped = await scene(page)
    expect(cropped.canvas.outputHeight).toBe(height - 100)
    expect(corner(cropped, '方块')).toEqual([100, 100])
    expect(cropped.canvas.guides).toEqual([{ axis: 'x', position: 200 }])
    // The adjustment layer's mask was cut with the canvas: still white up to the old middle.
    const mask = await grayAsset(page, maskOf(cropped))
    expect([mask.width, mask.height]).toEqual([width - 200, height - 100])
    expect(mask.data[10 * mask.width + Math.floor(width / 2) - 100 - 2]).toBe(255)
    expect(mask.data[10 * mask.width + Math.floor(width / 2) - 100 + 2]).toBe(0)
    // One undo puts it all back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width)
    const undone = await scene(page)
    expect(corner(undone, '方块')).toEqual(corner(before, '方块'))
    expect(maskOf(undone)).toBe(maskOf(before))

    // Dragging the right side out past the canvas extends it there.
    await expect(bar).toBeVisible()
    const right = await artboardPoint(page, 1, 0.5)
    const further = await artboardPoint(page, 1 + 120 / width, 0.5)
    await drag(page, right, further)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBeGreaterThan(width + 100)
    const extended = await scene(page)
    expect(corner(extended, '方块')).toEqual(corner(before, '方块'))
    expect(extended.canvas.outputHeight).toBe(height)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width)
  } finally {
    await app.close()
  }
})

test('generative expand fills what the frame adds, masked to it with a soft band into the picture', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  try {
    const { width } = await setUp(page)
    await page.keyboard.press('c')
    const bar = page.getByTestId('crop-bar')
    await bar.getByRole('combobox', { name: '扩出部分填充' }).selectOption('generative')
    await bar.getByRole('spinbutton', { name: '裁剪宽度' }).fill(String(width + 200))
    await bar.getByRole('textbox', { name: '生成式扩展描述' }).fill('延伸的木桌')
    await bar.getByRole('button', { name: '应用裁剪' }).click()
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width + 200)
    await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()))[0]?.status, { timeout: 20_000 }).toBe('completed')
    const job = (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()))[0]!
    expect(job.request).toMatchObject({ kind: 'edit', parameters: { mode: 'selection-fill', expand: true } })
    await page.getByRole('button', { name: '放入画布' }).click()
    await editPlacedResult(page)
    await expect.poll(async () => (await scene(page)).elements.map((element) => element.name)).toContain('生成式扩展 1')
    const placed = (await scene(page)).elements.find((element) => element.name === '生成式扩展 1') as Extract<SceneElement, { type: 'image' }>
    expect(placed.transform).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
    const mask = await grayAsset(page, placed.mask!.assetId)
    const at = (x: number, y: number): number => mask.data[Math.round(y * mask.height) * mask.width + Math.round(x * mask.width)]!
    // White in what was added on both sides, black in the middle of the old picture, fading between.
    expect(at(0.02, 0.5)).toBeGreaterThan(250)
    expect(at(0.98, 0.5)).toBeGreaterThan(250)
    expect(at(0.5, 0.5)).toBe(0)
    const edge = 100 / (width + 200)
    expect(at(edge + 0.003, 0.5)).toBeGreaterThan(0)
    expect(at(edge + 0.003, 0.5)).toBeLessThan(255)
    // Placing the result is one step, the canvas another: two undos and it is as it was.
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width)
    expect((await scene(page)).elements.map((element) => element.name)).not.toContain('生成式扩展 1')
  } finally {
    await app.close()
  }
})

test('Ctrl+Alt+C opens the canvas size ready to extend about an anchor, keeping every layer where it is', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launch()
  try {
    const { width, height } = await setUp(page)
    const before = await scene(page)
    await page.keyboard.press('Control+Alt+c')
    const panel = page.getByRole('dialog', { name: '画布尺寸设置' })
    await expect(panel).toBeVisible()
    await panel.getByRole('radio', { name: '定位：左上' }).click()
    await panel.getByRole('spinbutton', { name: '画布输出宽度' }).fill(String(width + 300))
    await panel.getByRole('spinbutton', { name: '画布输出高度' }).fill(String(height + 100))
    await panel.getByRole('button', { name: '应用画布尺寸' }).click()
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width + 300)
    const after = await scene(page)
    expect(after.canvas.outputHeight).toBe(height + 100)
    expect(corner(after, '方块')).toEqual(corner(before, '方块'))
    expect(after.canvas.guides).toEqual(before.canvas.guides)
    // Grown at the right and bottom, repeating the mask's edge: black at the right, as the mask's right half was.
    const mask = await grayAsset(page, maskOf(after))
    expect([mask.width, mask.height]).toEqual([width + 300, height + 100])
    expect(mask.data[(height + 50) * mask.width + 5]).toBe(255)
    expect(mask.data[(height + 50) * mask.width + width + 200]).toBe(0)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(width)
  } finally {
    await app.close()
  }
})

test('rulers, guides, grid and snapping: shortcuts, guides dragged out of a ruler and back, layers snapping to them', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launch()
  try {
    const { width, height } = await setUp(page)
    await expect(page.getByTestId('guide-x-0')).toBeVisible()
    await page.keyboard.press('Control+;')
    await expect(page.getByTestId('guide-x-0')).toHaveCount(0)
    await page.keyboard.press('Control+;')
    await expect(page.getByTestId('guide-x-0')).toBeVisible()
    await page.keyboard.press("Control+'")
    await expect(page.locator('.view-grid')).toHaveCount(1)
    await page.keyboard.press("Control+'")
    await expect(page.locator('.view-grid')).toHaveCount(0)

    // Ctrl+R, then a horizontal guide out of the top ruler at a quarter down; one step to make, one to undo.
    await page.keyboard.press('Control+r')
    const ruler = page.getByTestId('ruler-top')
    await expect(ruler).toBeVisible()
    const box = (await ruler.boundingBox())!
    const target = await artboardPoint(page, 0.6, 0.25)
    await drag(page, { x: target.x, y: box.y + 8 }, target)
    await expect.poll(async () => (await scene(page)).canvas.guides?.length).toBe(2)
    const made = (await scene(page)).canvas.guides![1]!
    expect(made.axis).toBe('y')
    expect(Math.abs(made.position - height * 0.25)).toBeLessThanOrEqual(3)

    // A layer dragged so its left edge comes near the vertical guide at 300 snaps onto it.
    await page.keyboard.press('v')
    await page.getByRole('tab', { name: '图层' }).click()
    await page.getByRole('listbox', { name: '图层' }).locator('.layer-row', { hasText: '方块' }).click()
    // Grabbed in its middle, away from the transform handles.
    const grab = await artboardPoint(page, 350 / width, 300 / height)
    const near = await artboardPoint(page, (350 + 96) / width, 300 / height)
    await drag(page, grab, near)
    await expect.poll(async () => corner(await scene(page), '方块')[0]).toBe(300)
    // Ctrl+Shift+; turns snapping off: the same kind of move lands where it is let go.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => corner(await scene(page), '方块')[0]).toBe(200)
    await page.keyboard.press('Control+Shift+;')
    await drag(page, grab, near)
    await expect.poll(async () => Math.abs(corner(await scene(page), '方块')[0] - 300)).toBeGreaterThan(1)
    await page.keyboard.press('Control+Shift+;')

    // The new guide dragged back onto its ruler goes away.
    const guide = page.getByTestId('guide-y-1')
    const handle = (await guide.boundingBox())!
    await drag(page, { x: target.x + 40, y: handle.y + handle.height / 2 }, { x: target.x + 40, y: box.y + 6 })
    await expect.poll(async () => (await scene(page)).canvas.guides?.length).toBe(1)
    expect(width).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
