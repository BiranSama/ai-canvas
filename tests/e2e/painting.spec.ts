import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { PaintOp, SceneElement } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { applyPaintOps } from '../../src/shared/paint-ops'

async function launch(): Promise<{ app: ElectronApplication, page: Page }> {
  const userData = await mkdtemp(join(tmpdir(), 'paint-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
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

async function layer(page: Page): Promise<Extract<SceneElement, { type: 'image' }>> {
  const element = (await bootstrap(page)).scene.elements[0]
  if (element?.type !== 'image') throw new Error('No image layer.')
  return element
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

async function newCanvasWithLayer(page: Page): Promise<void> {
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
  await page.keyboard.press('Control+Shift+N')
  await expect.poll(async () => (await bootstrap(page)).scene.elements.map((element) => element.name)).toEqual(['图层 1'])
}

/** The picture as the export button writes it, as raw RGBA. */
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

/** The layer's recorded paint replayed on a transparent canvas, over the artboard colour. */
function replayed(width: number, height: number, ops: readonly PaintOp[], background: readonly [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  applyPaintOps(pixels, width, height, ops)
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

function pixelAt(image: { data: Buffer, width: number }, x: number, y: number): number[] {
  const index = (Math.round(y) * image.width + Math.round(x)) * 4
  return [...image.data.subarray(index, index + 4)]
}

test('a brush stroke paints the new layer as one undo step, and the export matches its replay', async () => {
  const { app, page } = await launch()
  try {
    await newCanvasWithLayer(page)
    await page.keyboard.press('b')
    await expect(page.getByRole('button', { name: '画笔', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const options = page.getByRole('toolbar', { name: '画笔选项' })
    await options.getByRole('spinbutton', { name: '大小' }).fill('40')
    await options.getByRole('spinbutton', { name: '大小' }).press('Enter')
    await page.keyboard.press(']')
    await expect(options.getByRole('spinbutton', { name: '大小' })).toHaveValue('50')
    await page.keyboard.press('Shift+BracketLeft')
    await expect(options.getByRole('spinbutton', { name: '硬度' })).toHaveValue('55')

    const from = await artboardPoint(page, 0.2, 0.3)
    const to = await artboardPoint(page, 0.8, 0.5)
    await page.mouse.move(from.x, from.y)
    // The ring shows the brush's real size on the canvas, and [ ] resize it in place.
    const ring = page.locator('.brush-ring')
    await expect(ring).toBeVisible()
    const scale = Number(await page.getByTestId('canvas-stage').getAttribute('data-artboard-width')) / 1024
    expect((await ring.boundingBox())!.width).toBeCloseTo(50 * scale, 0)
    await page.keyboard.press(']')
    await expect.poll(async () => Math.round((await ring.boundingBox())!.width)).toBe(Math.round(60 * scale))
    await page.keyboard.press('[')
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 24 })
    await page.mouse.up()
    await expect.poll(async () => (await layer(page)).paint?.length ?? 0).toBe(1)
    const painted = await layer(page)
    expect(painted.paint![0]).toMatchObject({ kind: 'stroke', tool: 'brush', color: '#000000', size: 50, hardness: 0.55 })
    await page.screenshot({ path: test.info().outputPath('brush-stroke.png') })

    const { outputWidth: width, outputHeight: height } = (await bootstrap(page)).scene.canvas
    const image = await exported(page)
    expect([image.width, image.height]).toEqual([width, height])
    expect(largestDifference(image.data, replayed(width, height, painted.paint!, ARTBOARD))).toBeLessThanOrEqual(2)
    expect(pixelAt(image, 0.5 * width, 0.4 * height)).toEqual([0, 0, 0, 255])

    // A second stroke with Shift runs straight on from where the first ended.
    await page.keyboard.down('Shift')
    await page.mouse.click(from.x, to.y)
    await page.keyboard.up('Shift')
    await expect.poll(async () => (await layer(page)).paint?.length ?? 0).toBe(2)

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await layer(page)).paint?.length ?? 0).toBe(1)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await layer(page)).paint?.length ?? 0).toBe(0)
    const undone = await exported(page)
    expect(pixelAt(undone, 0.5 * width, 0.4 * height)).toEqual([...ARTBOARD, 255])
  } finally {
    await app.close()
  }
})

test('the bucket, the gradient, the transparency lock and Alt+Backspace paint what Photoshop would', async () => {
  const { app, page } = await launch()
  try {
    await newCanvasWithLayer(page)
    await page.getByLabel('前景色', { exact: true }).fill('#3366cc')
    await page.keyboard.press('g')
    await expect(page.getByRole('button', { name: '油漆桶', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const middle = await artboardPoint(page, 0.5, 0.5)
    await page.mouse.click(middle.x, middle.y)
    await expect.poll(async () => (await layer(page)).paint?.map((op) => op.kind)).toEqual(['fill'])

    await page.keyboard.press('Shift+G')
    await expect(page.getByRole('button', { name: '渐变', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('toolbar', { name: '渐变选项' }).getByRole('radio', { name: '径向' }).click()
    const centre = await artboardPoint(page, 0.5, 0.25)
    const edge = await artboardPoint(page, 0.75, 0.25)
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.down()
    await page.mouse.move(edge.x, edge.y, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await layer(page)).paint?.map((op) => op.kind)).toEqual(['fill', 'gradient'])
    expect((await layer(page)).paint![1]).toMatchObject({ shape: 'radial', colors: ['#3366CC', '#FFFFFF'] })

    // Erase a hole, lock the transparent pixels, then fill: the hole stays clear.
    await page.keyboard.press('e')
    const hole = await artboardPoint(page, 0.5, 0.75)
    await page.mouse.click(hole.x, hole.y)
    await expect.poll(async () => (await layer(page)).paint?.length).toBe(3)
    await page.keyboard.press('Slash')
    await expect.poll(async () => (await layer(page)).transparencyLocked).toBe(true)
    await expect(page.getByRole('button', { name: '锁定透明像素' })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Alt+Backspace')
    await expect.poll(async () => (await layer(page)).paint?.at(-1)).toMatchObject({ kind: 'fill-all', color: '#3366CC', lockAlpha: true })

    const painted = await layer(page)
    const image = await exported(page)
    expect(largestDifference(image.data, replayed(image.width, image.height, painted.paint!, ARTBOARD))).toBeLessThanOrEqual(2)
    expect(pixelAt(image, 0.5 * image.width, 0.75 * image.height)).toEqual([...ARTBOARD, 255])
    expect(pixelAt(image, 0.1 * image.width, 0.9 * image.height)).toEqual([0x33, 0x66, 0xCC, 255])
    await page.screenshot({ path: test.info().outputPath('fill-tools.png') })
  } finally {
    await app.close()
  }
})

async function newCanvas(page: Page): Promise<void> {
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByTestId('canvas-stage')).toBeVisible()
}

test('rasterizing and merging keep the picture as it looks, and stamping adds a layer', async () => {
  const { app, page } = await launch()
  try {
    await newCanvas(page)
    await page.getByRole('button', { name: '形状', exact: true }).click()
    await expect.poll(async () => (await bootstrap(page)).scene.elements.length).toBe(1)
    const shape = (await bootstrap(page)).scene.elements[0]!
    // Let the new layer draw before the picture is read.
    await expect.poll(async () => largestDifference((await exported(page)).data, (await exported(page)).data)).toBe(0)
    const before = await exported(page)

    await page.getByRole('option', { name: new RegExp(shape.name) }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '栅格化图层' }).click()
    await expect.poll(async () => (await bootstrap(page)).scene.elements[0]?.type).toBe('image')
    const rasterized = (await bootstrap(page)).scene.elements[0]!
    expect(rasterized).toMatchObject({ id: shape.id, name: shape.name, opacity: shape.opacity })
    await expect.poll(async () => largestDifference((await exported(page)).data, before.data), { timeout: 10_000 }).toBeLessThanOrEqual(2)

    await page.keyboard.press('Control+Shift+N')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.length).toBe(2)
    await page.keyboard.press('b')
    const from = await artboardPoint(page, 0.1, 0.1)
    const to = await artboardPoint(page, 0.9, 0.9)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 20 })
    await page.mouse.up()
    await expect.poll(async () => (await bootstrap(page)).scene.elements.find((element) => element.name === '图层 1')?.type === 'image' && ((await bootstrap(page)).scene.elements[1] as { paint?: unknown[] }).paint?.length).toBe(1)
    const painted = await exported(page)

    await page.keyboard.press('Control+E')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.map((element) => element.id)).toEqual([shape.id])
    await expect.poll(async () => largestDifference((await exported(page)).data, painted.data), { timeout: 10_000 }).toBeLessThanOrEqual(2)

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.length).toBe(2)
    // The stamp goes directly above the selected layer, as in Photoshop.
    await page.getByRole('option', { name: /图层 1/ }).click()
    await page.keyboard.press('Control+Alt+Shift+E')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.map((element) => element.name)).toEqual([shape.name, '图层 1', '图层 2'])
    expect((await bootstrap(page)).scene.elements[2]).toMatchObject({ type: 'image', fit: 'fill' })

    await page.keyboard.press('Control+Shift+E')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.map((element) => element.name)).toEqual([shape.name])
    // The stroke runs through the middle, over the shape and under its stamped copy.
    await expect.poll(async () => { const image = await exported(page); return pixelAt(image, image.width / 2, image.height / 2) }, { timeout: 10_000 }).toEqual([0, 0, 0, 255])
    await page.screenshot({ path: test.info().outputPath('merged.png') })
  } finally {
    await app.close()
  }
})
