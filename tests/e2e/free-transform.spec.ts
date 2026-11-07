import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ELEMENT_SCHEMA_VERSION, layerCornerPoints, MIRRORED_CORNERS, type SceneElement } from '../../src/domain'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { exportThroughPanel } from '../helpers/export-file'
import { openEditor } from '../helpers/workbench-ui'
import { currentScene, openCoffeePoster, POSTER_HEIGHT as HEIGHT, POSTER_WIDTH as WIDTH, projectAssets, rawPixels } from '../helpers/render-compare'

/*
 * Photoshop's free transform: flipped, skewed, distorted and perspective
 * layers draw the same in the canvas's export and in Main's renderer, and
 * Ctrl+T reshapes a layer on the canvas, applied in one step with Enter and
 * put back with Esc.
 */

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rotation: number }
const box = (x: number, y: number, width: number, height: number, rotation = 0): Box => ({ x: x / WIDTH, y: y / HEIGHT, width: width / WIDTH, height: height / HEIGHT, rotation })
const common = { version: ELEMENT_SCHEMA_VERSION, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include', semanticRole: 'content', opacity: 1, zIndex: 0 }
const image = (name: string, assetId: string, transform: Box, extra: Record<string, unknown> = {}): unknown => ({
  kind: 'element.add', element: { ...common, id: randomUUID(), type: 'image', name, assetId, transform, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', ...extra }
})

async function importRamp(page: Page, size: number): Promise<string> {
  return page.evaluate(async ({ size }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const { projectId } = (await api.getWorkspaceBootstrap()).scene
    const rgba = new Uint8Array(size * size * 4)
    // Smooth, so the two renderers' resampling agrees away from the edges; a darker frame shows which way round it is.
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const frame = x < 12 || y < 12
      rgba.set(frame ? [30, 40, 60, 255] : [Math.round(x / size * 255), Math.round(y / size * 255), 200 - Math.round(x / size * 120), 255], (y * size + x) * 4)
    }
    return (await api.importPixels({ projectId, name: '渐变', width: size, height: size, rgba })).id
  }, { size })
}

async function addLayers(page: Page, commands: readonly unknown[]): Promise<void> {
  const result = await page.evaluate(async ({ commands }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const current = (await api.getWorkspaceBootstrap()).scene
    // Text and part-canvas shapes are drawn differently by the browser and Main; the background stays.
    const hide = current.elements.filter((element) => element.visible && (element.type === 'text' || (element.type === 'shape' && (element.transform.width < 1 || element.transform.height < 1))))
      .map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } }))
    return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '自由变换测试', commands: [...hide, ...commands] as never } })
  }, { commands })
  expect(result.ok).toBe(true)
}

/** The largest difference inside a part of two pictures. */
function worstIn(left: Buffer, right: Buffer, area: { x: number; y: number; width: number; height: number }): { value: number; x: number; y: number } {
  let worst = { value: 0, x: 0, y: 0 }
  for (let y = Math.max(0, area.y); y < Math.min(HEIGHT, area.y + area.height); y += 1) {
    for (let x = Math.max(0, area.x); x < Math.min(WIDTH, area.x + area.width); x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        const index = (y * WIDTH + x) * 4 + channel
        const value = Math.abs(left[index]! - right[index]!)
        if (value > worst.value) worst = { value, x, y }
      }
    }
  }
  return worst
}

test('flipped, skewed, distorted and perspective layers draw the same in the export and in Main', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-warp-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-warp-')
  try {
    const ramp = await importRamp(page, 240)
    await addLayers(page, [
      image('水平翻转', ramp, box(40, 40, 240, 240), { corners: MIRRORED_CORNERS }),
      image('翻转并旋转', ramp, box(560, 40, 240, 240, 90), { corners: MIRRORED_CORNERS }),
      image('斜切', ramp, box(600, 340, 240, 240), { corners: [[0.2, 0], [1.2, 0], [1, 1], [0, 1]] }),
      image('透视', ramp, box(40, 640, 240, 240), { corners: [[0.2, 0], [0.8, 0], [1, 1], [0, 1]] }),
      image('扭曲', ramp, box(330, 1000, 240, 240), { corners: [[0, 0.1], [1.1, 0], [0.9, 1.05], [0.05, 0.9]] }),
      image('扭曲带样式', ramp, box(540, 700, 240, 240), {
        corners: [[0, 0.1], [1.1, 0], [0.9, 1.05], [0.05, 0.9]],
        style: { stroke: { enabled: true, size: 6, position: 'outside', color: '#FFFFFF', opacity: 1 }, dropShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 0.6, angle: 120, distance: 10, spread: 0, size: 8 } }
      })
    ])
    const exported = await rawPixels(await exportThroughPanel(page))
    const current = await currentScene(page)
    const main = await new CompositeReferenceRenderer(await projectAssets(userData, current.projectId)).render(current, 'final')
    expect(main.warnings).toEqual([])
    const reference = await rawPixels(main.buffer)
    if (process.env.AI_CANVAS_WARP_DUMP !== undefined) {
      await writeFile(join(process.env.AI_CANVAS_WARP_DUMP, 'export.png'), await sharp(exported, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer())
      await writeFile(join(process.env.AI_CANVAS_WARP_DUMP, 'main.png'), main.buffer)
    }
    // A flip maps pixel for pixel; a skew, distort or perspective is resampled by the same shared code in both,
    // and styled after it the same way: all agree to within rounding.
    for (const [name, area] of [
      ['flip', { x: 30, y: 30, width: 260, height: 260 }], ['turned flip', { x: 300, y: 30, width: 280, height: 260 }], ['skew', { x: 590, y: 330, width: 320, height: 260 }],
      ['perspective', { x: 30, y: 630, width: 260, height: 260 }], ['distort', { x: 320, y: 990, width: 290, height: 280 }], ['styled distort', { x: 500, y: 660, width: 340, height: 330 }]
    ] as const) {
      const worst = worstIn(exported, reference, area)
      expect(worst.value, `${name} worst at ${worst.x},${worst.y}`).toBeLessThanOrEqual(2)
    }
    // The flip did mirror: the dark frame is on the right now.
    const pixel = (x: number, y: number): number[] => [...exported.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)]
    expect(pixel(40 + 240 - 4, 160)[0]).toBeLessThan(60)
    expect(pixel(40 + 4, 160)[0]).toBeGreaterThan(150)
    // The perspective narrowed the top: the dark top edge now starts a fifth of the way in.
    expect(pixel(40 + 60, 640 + 5)[0]).toBeLessThan(60)
    expect(pixel(40 + 120, 640 + 60)[0]).toBeGreaterThan(80)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

/** Where a point of the picture is on the screen. */
async function screenPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="canvas-stage"]')
    const rect = root.querySelector('.konvajs-content').getBoundingClientRect()
    return { x: rect.left + Number(root.dataset.artboardX) + ${x / WIDTH} * Number(root.dataset.artboardWidth), y: rect.top + Number(root.dataset.artboardY) + ${y / HEIGHT} * Number(root.dataset.artboardHeight) }
  })()`) as Promise<{ x: number; y: number }>
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: readonly string[] = []): Promise<void> {
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8)
  await page.mouse.up()
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key)
}

const layer = (elements: readonly SceneElement[], name: string): SceneElement => elements.find((element) => element.name === name)!

test('Ctrl+T distorts, skews and turns a layer, applied in one step with Enter and put back with Esc', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-warp-ui-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-warp-ui-')
  try {
    const ramp = await importRamp(page, 240)
    await addLayers(page, [image('变换对象', ramp, box(300, 400, 400, 400))])
    await openEditor(page)
    await page.getByRole('tab', { name: '图层' }).click()
    const panel = page.getByRole('listbox', { name: '图层' })
    await panel.locator('.layer-row', { hasText: '变换对象' }).click()
    const before = layer((await currentScene(page)).elements, '变换对象')

    // Ctrl+T, then Ctrl+drag the top-left corner: a distort, shown at once and recorded on Enter.
    await page.keyboard.press('Control+t')
    await expect(page.getByTestId('free-transform-bar')).toBeVisible()
    await drag(page, await screenPoint(page, 300, 400), await screenPoint(page, 380, 440), ['Control'])
    expect(layer((await currentScene(page)).elements, '变换对象').transform).toEqual(before.transform)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('free-transform-bar')).toBeHidden()
    await expect.poll(async () => { const after = layer((await currentScene(page)).elements, '变换对象'); return after.type === 'image' ? after.corners ?? null : null }).not.toBeNull()
    const distorted = layer((await currentScene(page)).elements, '变换对象')
    const corner = layerCornerPoints(distorted.transform, distorted.type === 'image' ? distorted.corners : null, { width: WIDTH, height: HEIGHT })[0]
    expect(Math.abs(corner[0] - 380)).toBeLessThanOrEqual(4)
    expect(Math.abs(corner[1] - 440)).toBeLessThanOrEqual(4)
    // The other corners stayed.
    const others = layerCornerPoints(distorted.transform, distorted.type === 'image' ? distorted.corners : null, { width: WIDTH, height: HEIGHT }).slice(1)
    expect(others.map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([[700, 400], [700, 800], [300, 800]])

    // One undo puts it back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => { const after = layer((await currentScene(page)).elements, '变换对象'); return after.type === 'image' ? after.corners ?? null : 'not image' }).toBeNull()

    // Perspective from the bar, then Esc: nothing changes.
    await page.keyboard.press('Control+t')
    await page.getByTestId('free-transform-bar').getByRole('radio', { name: '透视' }).click()
    await drag(page, await screenPoint(page, 300, 400), await screenPoint(page, 360, 400))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('free-transform-bar')).toBeHidden()
    expect(layer((await currentScene(page)).elements, '变换对象')).toEqual(before)

    // Turned a quarter from the bar and applied with ✓: still a plain box, turned.
    await page.keyboard.press('Control+t')
    await page.getByTestId('free-transform-bar').getByRole('button', { name: '顺时针旋转 90 度' }).click()
    await page.getByTestId('free-transform-bar').getByRole('button', { name: '应用变换' }).click()
    await expect.poll(async () => layer((await currentScene(page)).elements, '变换对象').transform.rotation).toBe(90)
    const turned = layer((await currentScene(page)).elements, '变换对象')
    expect(turned.type === 'image' ? turned.corners ?? null : 'not image').toBeNull()
    await page.keyboard.press('Control+z')

    // The layer menu flips it left to right, in one step.
    await panel.locator('.layer-row', { hasText: '变换对象' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '水平翻转' }).click()
    await expect.poll(async () => { const after = layer((await currentScene(page)).elements, '变换对象'); return after.type === 'image' ? after.corners ?? null : null }).toEqual(MIRRORED_CORNERS)
    expect(layer((await currentScene(page)).elements, '变换对象').transform).toEqual(before.transform)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => layer((await currentScene(page)).elements, '变换对象')).toEqual(before)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
