import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { PaintOp, SceneElement } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { applyPaintOps } from '../../src/shared/paint-ops'

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication, page: Page }> {
  const userData = await mkdtemp(join(tmpdir(), 'select-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library', ...env }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  return { app, page }
}

async function bootstrap(page: Page) {
  return page.evaluate(async () => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
}

async function element(page: Page, name: string): Promise<SceneElement> {
  const found = (await bootstrap(page)).scene.elements.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`No layer ${name}.`)
  return found
}

async function image(page: Page, name = '图层 1'): Promise<Extract<SceneElement, { type: 'image' }>> {
  const found = await element(page, name)
  if (found.type !== 'image') throw new Error(`${name} is not an image layer.`)
  return found
}

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

async function drag(page: Page, from: readonly [number, number], to: readonly [number, number], steps = 10): Promise<void> {
  const start = await artboardPoint(page, from[0], from[1])
  const end = await artboardPoint(page, to[0], to[1])
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps })
  await page.mouse.up()
}

async function click(page: Page, x: number, y: number): Promise<void> {
  const point = await artboardPoint(page, x, y)
  await page.mouse.click(point.x, point.y)
}

async function newCanvasWithLayer(page: Page): Promise<void> {
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
  await page.keyboard.press('Control+Shift+N')
  await expect.poll(async () => (await bootstrap(page)).scene.elements.map((candidate) => candidate.name)).toEqual(['图层 1'])
}

async function exported(page: Page): Promise<{ data: Buffer, width: number, height: number }> {
  const url = await page.evaluate(`(() => {
    let captured = null
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function captureExport() { captured = this.href }
    try { document.querySelector('.export-control > button')?.click() } finally { HTMLAnchorElement.prototype.click = originalClick }
    return captured
  })()`) as string | null
  if (url === null) throw new Error('Export did not produce a data URL.')
  const { data, info } = await sharp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** A grayscale asset's red channel, read in the page from the asset Main serves. */
async function grayAsset(page: Page, assetId: string): Promise<Uint8Array> {
  const values = await page.evaluate(`(async () => {
    const url = await window.desktop.readGenerationAsset(${JSON.stringify(assetId)}, false)
    const picture = new Image()
    await new Promise((done, fail) => { picture.onload = done; picture.onerror = fail; picture.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = picture.naturalWidth
    canvas.height = picture.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(picture, 0, 0)
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    const gray = []
    for (let index = 0; index < rgba.length; index += 4) gray.push(rgba[index])
    return gray
  })()`) as number[]
  return Uint8Array.from(values)
}

async function clipsOf(page: Page, ops: readonly PaintOp[]): Promise<Map<string, Uint8Array>> {
  const clips = new Map<string, Uint8Array>()
  for (const op of ops) if (op.clip !== undefined && !clips.has(op.clip)) clips.set(op.clip, await grayAsset(page, op.clip))
  return clips
}

function replayed(width: number, height: number, ops: readonly PaintOp[], clips: ReadonlyMap<string, Uint8Array>, background: readonly [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  applyPaintOps(pixels, width, height, ops, clips)
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) pixels[index + channel] = Math.round(pixels[index + channel]! * alpha + background[channel]! * (1 - alpha))
    pixels[index + 3] = 255
  }
  return pixels
}

function largestDifference(left: Uint8ClampedArray | Buffer, right: Uint8ClampedArray | Buffer): number {
  let largest = 0
  for (let index = 0; index < left.length; index += 1) largest = Math.max(largest, Math.abs(left[index]! - right[index]!))
  return largest
}

const ARTBOARD: readonly [number, number, number] = [0xFB, 0xFA, 0xF7]

function pixelAt(picture: { data: Buffer, width: number }, x: number, y: number): number[] {
  const index = (Math.round(y) * picture.width + Math.round(x)) * 4
  return [...picture.data.subarray(index, index + 4)]
}

const ants = (page: Page) => page.getByTestId('selection-ants')

test('a marquee selection limits the brush, steps through undo with the paint, and inverts, deselects and comes back', async () => {
  const { app, page } = await launch()
  try {
    await newCanvasWithLayer(page)
    await page.keyboard.press('m')
    await expect(page.getByRole('button', { name: '矩形选框', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('toolbar', { name: '矩形选框选项' })).toBeVisible()
    await drag(page, [0.25, 0.25], [0.5, 0.5])
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.screenshot({ path: test.info().outputPath('marquee.png') })

    await page.keyboard.press('b')
    const options = page.getByRole('toolbar', { name: '画笔选项' })
    await options.getByRole('spinbutton', { name: '大小' }).fill('300')
    await options.getByRole('spinbutton', { name: '大小' }).press('Enter')
    await drag(page, [0.1, 0.375], [0.9, 0.375], 24)
    await expect.poll(async () => (await image(page)).paint?.length ?? 0).toBe(1)
    const painted = await image(page)
    expect(painted.paint![0]!.clip).toEqual(expect.any(String))

    const { outputWidth: width, outputHeight: height } = (await bootstrap(page)).scene.canvas
    const picture = await exported(page)
    expect(pixelAt(picture, 0.375 * width, 0.375 * height)).toEqual([0, 0, 0, 255])
    // The stroke ran right across the canvas; outside the selection nothing changed.
    expect(pixelAt(picture, 0.1 * width, 0.375 * height)).toEqual([...ARTBOARD, 255])
    expect(pixelAt(picture, 0.375 * width, 0.2 * height)).toEqual([...ARTBOARD, 255])
    expect(largestDifference(picture.data, replayed(width, height, painted.paint!, await clipsOf(page, painted.paint!), ARTBOARD))).toBeLessThanOrEqual(2)

    // Ctrl+Z takes back the stroke, then the selection, in the order they were made.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await image(page)).paint?.length ?? 0).toBe(0)
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.keyboard.press('Control+z')
    await expect(ants(page)).toHaveAttribute('data-selection', 'none')
    await page.keyboard.press('Control+Shift+z')
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await image(page)).paint?.length ?? 0).toBe(1)

    await page.keyboard.press('Control+d')
    await expect(ants(page)).toHaveAttribute('data-selection', 'none')
    // With nothing selected, Ctrl+D falls back to deselecting the layer.
    await page.keyboard.press('Control+d')
    await expect(page.getByRole('option', { name: /图层 1/ })).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('Control+Shift+d')
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')

    // Inverse, then Delete clears everything but the square.
    await page.getByRole('option', { name: /图层 1/ }).click()
    await page.keyboard.press('Control+Shift+i')
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await image(page)).paint?.map((op) => op.kind)).toEqual(['stroke', 'clear'])
    expect((await bootstrap(page)).scene.elements).toHaveLength(1)
    // Select all, then Ctrl+A again is still one layer and one selection.
    await page.keyboard.press('Control+a')
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.screenshot({ path: test.info().outputPath('inverse-clear.png') })
  } finally {
    await app.close()
  }
})

test('the ellipse, lasso, polygonal lasso and magic wand select, Ctrl+J copies the selection, and a layer mask hides, paints, turns off and applies', async () => {
  const { app, page } = await launch()
  try {
    await newCanvasWithLayer(page)
    await page.getByLabel('前景色', { exact: true }).fill('#2255aa')
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Alt+Backspace')
    await expect.poll(async () => (await image(page)).paint?.map((op) => op.kind)).toEqual(['fill-all'])

    // Shift+M moves to the ellipse; Shift held from the start of the next drag adds to it.
    await page.keyboard.press('m')
    await page.keyboard.press('Shift+M')
    await expect(page.getByRole('button', { name: '椭圆选框', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await drag(page, [0.1, 0.1], [0.3, 0.3])
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.keyboard.press('l')
    await expect(page.getByRole('button', { name: '套索', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const lasso = [[0.6, 0.1], [0.9, 0.15], [0.85, 0.35], [0.62, 0.3]] as const
    const first = await artboardPoint(page, lasso[0][0], lasso[0][1])
    await page.keyboard.down('Shift')
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    for (const [x, y] of lasso.slice(1)) {
      const point = await artboardPoint(page, x, y)
      await page.mouse.move(point.x, point.y, { steps: 6 })
    }
    await page.mouse.up()
    await page.keyboard.up('Shift')

    // The polygonal lasso: three clicks and Enter make a new selection.
    await page.keyboard.press('Shift+L')
    await expect(page.getByRole('button', { name: '多边形套索', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await click(page, 0.2, 0.5)
    await click(page, 0.6, 0.5)
    await click(page, 0.4, 0.8)
    await page.keyboard.press('Enter')
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')

    // Ctrl+J: the triangle of blue becomes a new layer above, cut to what it covers.
    await page.getByRole('option', { name: /图层 1/ }).click()
    await page.keyboard.press('Control+j')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.map((candidate) => candidate.name)).toEqual(['图层 1', '图层 2'])
    const copy = await image(page, '图层 2')
    expect(copy.transform.x).toBeCloseTo(0.2, 1)
    expect(copy.transform.width).toBeCloseTo(0.4, 1)
    expect(copy.transform.y).toBeCloseTo(0.5, 1)
    expect(copy.transform.height).toBeCloseTo(0.3, 1)

    // A mask from the selection on 图层 1: only the triangle shows.
    await page.getByRole('option', { name: /图层 1/ }).click()
    await page.getByRole('option', { name: /图层 2/ }).getByRole('button', { name: '隐藏图层 2' }).click()
    await page.getByRole('option', { name: /图层 1/ }).click()
    await page.getByRole('button', { name: '添加蒙版' }).click()
    await expect.poll(async () => (await image(page)).mask?.enabled).toBe(true)
    await expect(ants(page)).toHaveAttribute('data-selection', 'none')
    const maskThumb = page.getByRole('button', { name: '图层 1 的蒙版' })
    await expect(maskThumb).toHaveAttribute('aria-pressed', 'true')
    const { outputWidth: width, outputHeight: height } = (await bootstrap(page)).scene.canvas
    await expect.poll(async () => pixelAt(await exported(page), 0.1 * width, 0.9 * height)).toEqual([...ARTBOARD, 255])
    await expect.poll(async () => pixelAt(await exported(page), 0.4 * width, 0.6 * height)).toEqual([0x22, 0x55, 0xAA, 255])

    // Painting with the mask as the target paints gray on the mask: white shows more of the layer.
    await page.keyboard.press('x')
    await page.keyboard.press('b')
    const options = page.getByRole('toolbar', { name: '画笔选项' })
    await options.getByRole('spinbutton', { name: '大小' }).fill('200')
    await options.getByRole('spinbutton', { name: '大小' }).press('Enter')
    await drag(page, [0.1, 0.9], [0.3, 0.9], 8)
    await expect.poll(async () => (await image(page)).mask?.paint?.length ?? 0).toBe(1)
    expect((await image(page)).mask!.paint![0]).toMatchObject({ kind: 'stroke', color: '#FFFFFF', lockAlpha: true })
    await expect.poll(async () => pixelAt(await exported(page), 0.2 * width, 0.9 * height)).toEqual([0x22, 0x55, 0xAA, 255])
    expect((await image(page)).paint?.length).toBe(1)
    await page.screenshot({ path: test.info().outputPath('mask-painted.png') })

    // Shift+click turns the mask off; the whole layer shows again.
    await maskThumb.click({ modifiers: ['Shift'] })
    await expect.poll(async () => (await image(page)).mask?.enabled).toBe(false)
    await expect.poll(async () => pixelAt(await exported(page), 0.9 * width, 0.9 * height)).toEqual([0x22, 0x55, 0xAA, 255])
    await maskThumb.click({ modifiers: ['Shift'] })
    await expect.poll(async () => (await image(page)).mask?.enabled).toBe(true)

    // Ctrl+click loads the mask as the selection; Ctrl+D drops it again.
    await maskThumb.click({ modifiers: ['Control'] })
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.keyboard.press('Control+d')

    // 应用蒙版: the mask goes into new pixels and is gone, the picture unchanged.
    const masked = await exported(page)
    await page.getByRole('option', { name: /图层 1/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '应用蒙版' }).click()
    await expect.poll(async () => (await image(page)).mask ?? null).toBe(null)
    expect((await image(page)).paint ?? []).toEqual([])
    await expect.poll(async () => largestDifference((await exported(page)).data, masked.data), { timeout: 10_000 }).toBeLessThanOrEqual(2)

    // The magic wand picks the blue that is left.
    await page.keyboard.press('w')
    await page.keyboard.press('Shift+W')
    await expect(page.getByRole('button', { name: '魔棒', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await click(page, 0.4, 0.6)
    await expect(ants(page)).toHaveAttribute('data-selection', 'some')
    await page.screenshot({ path: test.info().outputPath('wand.png') })
  } finally {
    await app.close()
  }
})

/** A vase on a wall and a table, as a PNG to open as a project. */
async function vasePicture(): Promise<string> {
  const svg = `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9D3DC"/><stop offset="1" stop-color="#9FAAB5"/></linearGradient>
      <radialGradient id="vase" cx="0.38" cy="0.35" r="0.75"><stop offset="0" stop-color="#F6A14A"/><stop offset="0.6" stop-color="#D86C1F"/><stop offset="1" stop-color="#8E3F0D"/></radialGradient>
    </defs>
    <rect width="640" height="480" fill="url(#wall)"/>
    <rect y="360" width="640" height="120" fill="#86603A"/>
    <path d="M 280 120 C 270 150 250 170 240 210 C 225 270 230 330 260 370 L 380 370 C 410 330 415 270 400 210 C 390 170 370 150 360 120 Z" fill="url(#vase)"/>
  </svg>`
  const path = join(await mkdtemp(join(tmpdir(), 'vase-')), 'vase.png')
  await sharp(Buffer.from(svg)).png().toFile(path)
  return path
}

async function openPicture(page: Page, path: string): Promise<void> {
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Control+o')
  await (await chooser).setFiles(path)
  await expect.poll(async () => (await bootstrap(page)).scene.canvas.outputWidth, { timeout: 15_000 }).toBe(640)
}

async function selectionBounds(page: Page): Promise<number[]> {
  const value = await ants(page).getAttribute('data-selection-bounds')
  return value === null || value === '' ? [] : value.split(',').map(Number)
}

test('the object selection picks the object under a click with the bundled model', async () => {
  const { app, page } = await launch()
  try {
    await openPicture(page, await vasePicture())
    await page.keyboard.press('w')
    await expect(page.getByRole('button', { name: '对象选择', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await click(page, 320 / 640, 260 / 480)
    await expect(ants(page)).toHaveAttribute('data-selection', 'some', { timeout: 30_000 })
    const [x, y, width, height] = await selectionBounds(page)
    // The vase spans x 230–410 and y 120–370.
    expect(x).toBeGreaterThan(200)
    expect(x! + width!).toBeLessThan(440)
    expect(y).toBeGreaterThan(95)
    expect(y! + height!).toBeLessThan(395)
    expect(width).toBeGreaterThan(130)
    await page.screenshot({ path: test.info().outputPath('object-select.png') })
  } finally {
    await app.close()
  }
})

test('Select Subject asks to download its model first, and the dialog can be closed', async () => {
  // An empty model folder, whatever this machine holds.
  const { app, page } = await launch({ AI_CANVAS_SUBJECT_MODEL_DIR: await mkdtemp(join(tmpdir(), 'no-model-')) })
  try {
    await newCanvasWithLayer(page)
    await page.keyboard.press('m')
    await page.getByRole('button', { name: '选择主体' }).click()
    const dialog = page.getByRole('dialog', { name: '下载选择主体模型' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('170 MB')
    await expect(dialog.getByRole('button', { name: '下载', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toBeHidden()
    await expect(ants(page)).toHaveAttribute('data-selection', 'none')
  } finally {
    await app.close()
  }
})

// The 170 MB model is not in the repository; AI_CANVAS_SUBJECT_MODEL_DIR points at a folder that holds it.
const subjectModel = process.env.AI_CANVAS_SUBJECT_MODEL_DIR
test('Select Subject selects the subject of the picture with the local model', async () => {
  test.skip(subjectModel === undefined, 'The ISNet model is not on this machine.')
  const { app, page } = await launch()
  try {
    await openPicture(page, await vasePicture())
    await page.keyboard.press('m')
    await page.getByRole('button', { name: '选择主体' }).click()
    await expect(ants(page)).toHaveAttribute('data-selection', 'some', { timeout: 60_000 })
    const [x, y, width, height] = await selectionBounds(page)
    expect(x).toBeGreaterThanOrEqual(225)
    expect(x! + width!).toBeLessThanOrEqual(420)
    expect(y).toBeGreaterThanOrEqual(110)
    expect(y! + height!).toBeLessThanOrEqual(380)
    await page.screenshot({ path: test.info().outputPath('select-subject.png') })
  } finally {
    await app.close()
  }
})
