import { expect, test, type Page } from '@playwright/test'
import { readPsd } from 'ag-psd'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import { readPsdForImport } from '../../src/main/psd/psd-import'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { exportThroughPanel } from '../helpers/export-file'
import { openEditor } from '../helpers/workbench-ui'
import { currentScene, openCoffeePoster, POSTER_HEIGHT as HEIGHT, POSTER_WIDTH as WIDTH, projectAssets, rawPixels, worstDifference } from '../helpers/render-compare'

/*
 * Photoshop's clipping masks: a clipped layer shows only where its base has
 * content, the stack laid over the picture with the base's opacity and mode.
 * The canvas's export and Main's renderer agree, the layer panel shows the
 * stack, Ctrl+Alt+G makes and releases it, and the clipped layers follow
 * their base while it is dragged.
 */

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rotation: number }

const box = (x: number, y: number, width: number, height: number): Box => ({ x: x / WIDTH, y: y / HEIGHT, width: width / WIDTH, height: height / HEIGHT, rotation: 0 })
const common = { version: ELEMENT_SCHEMA_VERSION, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include', semanticRole: 'content', opacity: 1, zIndex: 0 }
const image = (name: string, assetId: string, transform: Box, extra: Record<string, unknown> = {}): unknown => ({
  kind: 'element.add', element: { ...common, id: randomUUID(), type: 'image', name, assetId, transform, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', ...extra }
})
const adjustment = (name: string, settings: unknown, extra: Record<string, unknown> = {}): unknown => ({
  kind: 'element.add', element: { ...common, id: randomUUID(), type: 'adjustment', name, semanticRole: 'adjustment', transform: box(0, 0, WIDTH, HEIGHT), settings, mask: null, ...extra }
})

/** Test pictures, each drawn at the size it is shown so that neither renderer resamples it. */
const PICTURES: Record<string, { readonly width: number; readonly height: number; readonly paint: (x: number, y: number, width: number, height: number) => readonly number[] }> = {
  // A soft-edged disc on transparency, as a cut-out subject is.
  disc: { width: 288, height: 288, paint: (x, y) => [230, 120, 40, Math.round(Math.min(1, Math.max(0, 120 - Math.hypot(x - 144, y - 144))) * 255)] },
  ramp: { width: 400, height: 400, paint: (x, y, width, height) => [Math.round(x / width * 255), Math.round(y / height * 255), 200 - Math.round(x / width * 120), 255] },
  ramp2: { width: 300, height: 300, paint: (x, y, width, height) => [Math.round(x / width * 255), Math.round(y / height * 255), 200 - Math.round(x / width * 120), 255] },
  stripes: { width: 300, height: 200, paint: (x) => Math.floor(x / 36) % 2 === 0 ? [20, 40, 160, 255] : [250, 250, 240, 255] },
  square: { width: 300, height: 300, paint: () => [40, 90, 220, 255] },
  red: { width: 300, height: 300, paint: () => [220, 20, 20, 255] }
}

/** Imports the test pictures into the project; their asset ids by name. */
async function importPictures(page: Page): Promise<Record<string, string>> {
  const pictures = Object.entries(PICTURES).map(([name, { width, height, paint }]) => {
    const rgba: number[] = []
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.push(...paint(x, y, width, height))
    return { name, width, height, rgba }
  })
  return page.evaluate(async ({ pictures }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const { projectId } = (await api.getWorkspaceBootstrap()).scene
    const ids: Record<string, string> = {}
    for (const { name, width, height, rgba } of pictures) ids[name] = (await api.importPixels({ projectId, name, width, height, rgba: new Uint8Array(rgba) })).id
    return ids
  }, { pictures })
}

/** Adds layers on top through Main, in order, with the poster's text and part-canvas shapes hidden (their edges are drawn differently by the two renderers). */
async function addLayers(page: Page, commands: readonly unknown[]): Promise<void> {
  const result = await page.evaluate(async ({ commands }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const current = (await api.getWorkspaceBootstrap()).scene
    const hide = current.elements.filter((element) => element.visible && (element.type === 'text' || (element.type === 'shape' && (element.transform.width < 1 || element.transform.height < 1))))
      .map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } }))
    return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '剪贴蒙版测试', commands: [...hide, ...commands] as never } })
  }, { commands })
  expect(result.ok).toBe(true)
}

const pixelAt = (picture: Buffer, x: number, y: number): number[] => [...picture.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)]

test('a clipping stack draws the same in the export and in Main, shown only where its base is', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-clip-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-clip-')
  try {
    const assets = await importPictures(page)
    await addLayers(page, [])
    const before = await rawPixels(await exportThroughPanel(page))
    await addLayers(page, [
      // A half-transparent base in multiply, with styles that are not part of what clips.
      image('底', assets.disc!, box(100, 100, 288, 288), { opacity: 0.8, blendMode: 'multiply', adjustments: [{ id: randomUUID(), enabled: true, settings: { kind: 'desaturate' } }], style: {
        dropShadow: { enabled: true, blendMode: 'multiply', color: '#102030', opacity: 0.6, angle: 120, distance: 12, spread: 0, size: 10 },
        stroke: { enabled: true, size: 6, position: 'outside', color: '#FFFFFF', opacity: 1 }
      } }),
      image('渐变', assets.ramp!, box(60, 60, 400, 400), { clipped: true, blendMode: 'overlay' }),
      image('条纹', assets.stripes!, box(200, 160, 300, 200), { clipped: true, opacity: 0.6 }),
      adjustment('反相', { kind: 'invert' }, { clipped: true, opacity: 0.25 }),
      // A second stack, with a hidden clipped layer.
      // A style switched off draws nothing, but goes to the PSD switched off.
    image('底二', assets.ramp2!, box(560, 100, 300, 300), { style: { stroke: { enabled: false, size: 4, position: 'outside', color: '#FF00FF', opacity: 1 } } }),
      image('圆', assets.disc!, box(600, 160, 288, 288), { clipped: true, blendMode: 'screen' }),
      image('隐藏的', assets.red!, box(560, 100, 300, 300), { clipped: true, visible: false }),
      // A hidden base hides what is clipped to it.
      image('隐藏的底', assets.square!, box(100, 600, 300, 300), { visible: false }),
      image('跟着隐藏', assets.red!, box(100, 600, 300, 300), { clipped: true })
    ])
    const exported = await rawPixels(await exportThroughPanel(page))
    const scene = await currentScene(page)
    const main = await new CompositeReferenceRenderer(await projectAssets(userData, scene.projectId)).render(scene, 'final')
    expect(main.warnings).toEqual([])
    if (process.env.AI_CANVAS_CLIP_DUMP !== undefined) {
      const { writeFile } = await import('node:fs/promises')
      const sharp = (await import('sharp')).default
      await writeFile(join(process.env.AI_CANVAS_CLIP_DUMP, 'export.png'), await sharp(exported, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer())
      await writeFile(join(process.env.AI_CANVAS_CLIP_DUMP, 'main.png'), main.buffer)
    }
    const worst = worstDifference(exported, await rawPixels(main.buffer))
    expect(worst.value, `worst at ${worst.x},${worst.y}`).toBeLessThanOrEqual(2)

    const same = (x: number, y: number): void => {
      const [now, then] = [pixelAt(exported, x, y), pixelAt(before, x, y)]
      expect(Math.max(...now.map((value, channel) => Math.abs(value - then[channel]!))), `${x},${y}`).toBeLessThanOrEqual(1)
    }
    // The clipped gradient reaches past the disc, but shows only on it: its corner, outside the disc's stroke and shadow, is the poster.
    same(70, 450)
    // Where the disc is, the stack changed the picture.
    expect(pixelAt(exported, 244, 244)).not.toEqual(pixelAt(before, 244, 244))
    // The red clipped to the hidden base is not drawn.
    same(250, 750)
    // Nor is the hidden clipped layer: the second base keeps its own colours outside the screened disc.
    expect(pixelAt(exported, 565, 395)[0]).toBeLessThan(150)

    // In a PSD the clipping masks and layer styles are Photoshop's own; its picture is the PNG's, and it opens as it went.
    const bytes = await readFile(await exportThroughPanel(page, { kind: 'psd' }))
    const psd = readPsd(bytes, { useImageData: true })
    const byName = new Map((psd.children ?? []).map((child) => [child.name, child]))
    expect(['底', '渐变', '条纹', '反相', '底二', '圆', '隐藏的', '隐藏的底', '跟着隐藏'].map((name) => byName.get(name)?.clipping === true))
      .toEqual([false, true, true, true, false, true, true, false, true])
    expect(byName.get('底')?.effects?.dropShadow?.[0]).toMatchObject({ blendMode: 'multiply', distance: { value: 12 } })
    expect(byName.get('底')?.effects?.stroke?.[0]).toMatchObject({ position: 'outside', size: { value: 6 } })
    expect(byName.get('底二')?.effects?.stroke?.[0]).toMatchObject({ enabled: false, size: { value: 4 } })
    // A styled picture's own adjustments are in its pixels: as clipped layers they would go on after its styles.
    expect(byName.has('去色')).toBe(false)
    const composite = Buffer.from(psd.imageData!.data.buffer, psd.imageData!.data.byteOffset, psd.imageData!.data.byteLength)
    expect(worstDifference(composite, exported).value).toBeLessThanOrEqual(2)
    const opened = await readPsdForImport(bytes)
    const layer = (name: string): (typeof opened.layers)[number] | undefined => opened.layers.find((candidate) => candidate.name === name)
    expect(layer('渐变')?.clipped).toBe(true)
    expect(layer('反相')).toMatchObject({ kind: 'adjustment', clipped: true })
    const base = layer('底')
    expect(base?.kind === 'pixels' ? base.style : null).toEqual((scene.elements.find((element) => element.name === '底') as { style?: unknown }).style)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

/** Where a point of the picture is on the screen, and the canvas's colour there. */
async function canvasPixel(page: Page, x: number, y: number): Promise<{ readonly screen: { x: number; y: number }; readonly rgb: number[] }> {
  // As source, since the tests are not built with the page's types.
  return page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="canvas-stage"]')
    const surface = root.querySelector('.konvajs-content')
    const rect = surface.getBoundingClientRect()
    const screen = { x: rect.left + Number(root.dataset.artboardX) + ${x / WIDTH} * Number(root.dataset.artboardWidth), y: rect.top + Number(root.dataset.artboardY) + ${y / HEIGHT} * Number(root.dataset.artboardHeight) }
    const layer = surface.querySelectorAll('canvas')[1]
    const bounds = layer.getBoundingClientRect()
    const data = layer.getContext('2d').getImageData(Math.round((screen.x - bounds.left) * layer.width / bounds.width), Math.round((screen.y - bounds.top) * layer.height / bounds.height), 1, 1).data
    return { screen, rgb: [data[0], data[1], data[2]] }
  })()`) as Promise<{ readonly screen: { x: number; y: number }; readonly rgb: number[] }>
}

const isRed = (rgb: readonly number[]): boolean => rgb[0]! > 180 && rgb[1]! < 70 && rgb[2]! < 70

test('Ctrl+Alt+G clips and releases a layer, the panel shows it, and the clipped layer follows its base while dragged', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-clip-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-clip-')
  try {
    const assets = await importPictures(page)
    // The red covers the top third of the square's row, so the square can be grabbed in its middle, away from the handles.
    await addLayers(page, [image('方块底', assets.square!, box(300, 400, 300, 300)), image('红色', assets.red!, box(100, 400, 700, 100))])
    await openEditor(page)
    await page.getByRole('tab', { name: '图层' }).click()
    const panel = page.getByRole('listbox', { name: '图层' })
    const red = panel.locator('.layer-row', { hasText: '红色' })
    await red.click()
    await page.keyboard.press('Control+Alt+g')
    await expect.poll(async () => (await currentScene(page)).elements.find((element) => element.name === '红色')?.clipped).toBe(true)
    await expect(red).toHaveClass(/is-clipped/)
    await expect(red.getByRole('img', { name: '剪贴到「方块底」' })).toBeVisible()
    await expect(panel.locator('.layer-row', { hasText: '方块底' }).locator('strong')).toHaveClass(/is-clip-base/)

    // The red shows on the square only.
    await expect.poll(async () => isRed((await canvasPixel(page, 450, 450)).rgb)).toBe(true)
    expect(isRed((await canvasPixel(page, 660, 450)).rgb)).toBe(false)

    // Dragging the base brings the red along at once, before the move is committed.
    await panel.locator('.layer-row', { hasText: '方块底' }).click()
    const start = await canvasPixel(page, 450, 600)
    const end = await canvasPixel(page, 570, 600)
    await page.mouse.move(start.screen.x, start.screen.y)
    await page.mouse.down()
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(start.screen.x + (end.screen.x - start.screen.x) * step / 12, start.screen.y, { steps: 1 })
    await expect.poll(async () => isRed((await canvasPixel(page, 660, 450)).rgb)).toBe(true)
    expect(isRed((await canvasPixel(page, 330, 450)).rgb)).toBe(false)
    await page.mouse.up()
    // Moved about 120 output pixels: the pointer moves in whole screen pixels.
    await expect.poll(async () => Math.abs((await currentScene(page)).elements.find((element) => element.name === '方块底')!.transform.x * WIDTH - 420)).toBeLessThanOrEqual(3)

    // A click where the red is clipped away, far from the square, does not pick the red.
    await panel.locator('.layer-row', { hasText: '方块底' }).click()
    const away = await canvasPixel(page, 120, 450)
    await page.mouse.click(away.screen.x, away.screen.y)
    await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))')
    await expect(red).not.toHaveAttribute('aria-selected', 'true')

    // Ctrl+Alt+G again on the clipped layer releases it: the red covers its own box again.
    await red.click()
    await page.keyboard.press('Control+Alt+g')
    await expect.poll(async () => (await currentScene(page)).elements.find((element) => element.name === '红色')?.clipped).toBe(false)
    await expect(red).not.toHaveClass(/is-clipped/)
    await expect.poll(async () => isRed((await canvasPixel(page, 120, 450)).rgb)).toBe(true)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
