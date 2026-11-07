import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELEMENT_SCHEMA_VERSION, type Scene } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { currentScene, openCoffeePoster } from '../helpers/render-compare'
import { openEditor } from '../helpers/workbench-ui'

/*
 * The layer style dialog, the filter dialogs, Ctrl+Alt+F and the blend mode
 * shortcuts as a person uses them, and how the canvas keeps up with filters
 * and styles on a 4000-pixel picture.
 */

type Element = Scene['elements'][number]

async function element(page: Page, name: string): Promise<Element | undefined> {
  return (await currentScene(page)).elements.find((candidate) => candidate.name === name)
}

/** A gradient picture of this size over the given part of the canvas, in output pixels. */
async function addPicture(page: Page, name: string, side: number, box: { x: number; y: number; width: number; height: number }, canvasSide?: number): Promise<string> {
  return page.evaluate(async ({ version, name, side, box, canvasSide }) => {
    const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
    const current = (await api.getWorkspaceBootstrap()).scene
    const rgba = new Uint8Array(side * side * 4)
    for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) rgba.set([x * 255 / side, y * 255 / side, (x + y) % 256, 255], (y * side + x) * 4)
    const picture = await api.importPixels({ projectId: current.projectId, name, width: side, height: side, rgba })
    const canvas = canvasSide === null ? current.canvas : { ...current.canvas, aspectWidth: 1, aspectHeight: 1, outputWidth: canvasSide, outputHeight: canvasSide }
    const id = crypto.randomUUID()
    await api.executeSceneCommands({
      projectId: current.projectId,
      expectedSceneRevision: current.revision,
      batch: { id: crypto.randomUUID(), origin: 'user', summary: '加图', commands: [
        ...(canvasSide === null ? [] : [{ kind: 'scene.set-canvas' as const, canvas }]),
        { kind: 'element.add', element: {
          id, version, type: 'image', name, description: '', zIndex: 0, opacity: 1, visible: true, locked: false, groupId: null,
          semanticRole: 'content', referencePolicy: 'include', assetId: picture.id,
          transform: { x: box.x / canvas.outputWidth, y: box.y / canvas.outputHeight, width: box.width / canvas.outputWidth, height: box.height / canvas.outputHeight, rotation: 0 },
          crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
        } }
      ] as never }
    })
    return id
  }, { version: ELEMENT_SCHEMA_VERSION, name, side, box, canvasSide: canvasSide ?? null })
}

const row = (page: Page, id: string) => page.locator(`[data-layer-id="${id}"]`)

test('the layer style dialog previews and records one step, styles copy between layers, filters come from the properties and Ctrl+Alt+F repeats one', async () => {
  test.setTimeout(150_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-ui-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-styles-ui-')
  try {
    const imageId = await addPicture(page, '渐变', 64, { x: 100, y: 120, width: 200, height: 160 })
    await openEditor(page)
    await page.getByRole('tab', { name: '图层' }).click()
    await row(page, imageId).locator('.layer-copy').click()

    // fx → 投影 opens the dialog; 取消 leaves the layer as it was.
    const openShadow = async (): Promise<void> => {
      await page.getByRole('toolbar', { name: '图层操作' }).getByRole('button', { name: '添加图层样式' }).click()
      await page.getByRole('menu', { name: '添加图层样式' }).getByRole('menuitem', { name: '投影…' }).click()
    }
    const dialog = page.getByRole('dialog', { name: '图层样式' })
    await openShadow()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('spinbutton', { name: '距离（像素）数值' }).fill('20')
    await dialog.getByRole('spinbutton', { name: '距离（像素）数值' }).press('Enter')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    expect((await element(page, '渐变')) as { style?: unknown }).not.toHaveProperty('style.dropShadow')

    // 确定 records it, as one step; the row shows fx.
    await openShadow()
    await dialog.getByRole('spinbutton', { name: '距离（像素）数值' }).fill('20')
    await dialog.getByRole('spinbutton', { name: '距离（像素）数值' }).press('Enter')
    await dialog.getByRole('checkbox', { name: '启用描边' }).check()
    await dialog.getByRole('button', { name: '确定' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => {
      const style = ((await element(page, '渐变')) as { style?: Extract<Element, { type: 'image' }>['style'] }).style
      return [style?.dropShadow?.distance, style?.stroke?.enabled]
    }).toEqual([20, true])
    await expect(row(page, imageId).getByRole('button', { name: '编辑渐变的图层样式' })).toBeVisible()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => ((await element(page, '渐变')) as { style?: { dropShadow?: unknown } }).style?.dropShadow).toBeUndefined()
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => ((await element(page, '渐变')) as { style?: { dropShadow?: { distance: number } } }).style?.dropShadow?.distance).toBe(20)

    // 拷贝图层样式 from the picture, 粘贴图层样式 onto the title.
    await row(page, imageId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '拷贝图层样式' }).click()
    const title = (await element(page, '标题'))!
    await row(page, title.id).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '粘贴图层样式' }).click()
    await expect.poll(async () => ((await element(page, '标题')) as { style?: { dropShadow?: { distance: number } } }).style?.dropShadow?.distance).toBe(20)

    // A filter from the properties: 高斯模糊 with its radius.
    await row(page, imageId).locator('.layer-copy').click()
    await page.getByRole('tab', { name: '属性' }).click()
    await page.getByRole('combobox', { name: '添加滤镜' }).selectOption('gaussian-blur')
    const blur = page.getByRole('dialog', { name: '高斯模糊' })
    await expect(blur).toBeVisible()
    await blur.getByRole('spinbutton', { name: '半径（像素）数值' }).fill('8')
    await blur.getByRole('spinbutton', { name: '半径（像素）数值' }).press('Enter')
    await blur.getByRole('button', { name: '确定' }).click()
    const filters = async (): Promise<unknown[]> => {
      const image = await element(page, '渐变')
      return image?.type === 'image' ? (image.adjustments ?? []).map((adjustment) => adjustment.settings.kind === 'gaussian-blur' ? adjustment.settings.radius : adjustment.settings.kind) : []
    }
    await expect.poll(filters).toEqual([8])
    await expect(page.getByRole('list', { name: '这一层的调整与滤镜' }).getByRole('listitem')).toHaveCount(1)

    // Ctrl+Alt+F adds the last filter again, with its settings.
    await page.keyboard.press('Control+Alt+f')
    await expect.poll(filters).toEqual([8, 8])

    // A mask on the blurred picture goes on after the blur, and can still be applied.
    await page.getByRole('tab', { name: '图层' }).click()
    await page.getByRole('toolbar', { name: '图层操作' }).getByRole('button', { name: '添加蒙版' }).click()
    await expect.poll(async () => ((await element(page, '渐变')) as { mask?: unknown }).mask ?? null).not.toBeNull()
    await row(page, imageId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '应用蒙版' }).click()
    // Applied, the mask is gone into the pixels (all white here, so the picture is the same one).
    await expect.poll(async () => ((await element(page, '渐变')) as { mask?: unknown }).mask ?? null).toBeNull()
    await expect(page.getByText('还没画好', { exact: false })).toHaveCount(0)

    // Alt+Shift letters set blend modes, as in Photoshop.
    await page.getByRole('tab', { name: '图层' }).click()
    await row(page, imageId).locator('.layer-copy').click()
    for (const [key, mode] of [['Y', 'luminosity'], ['K', 'darken'], ['N', 'normal']] as const) {
      await page.keyboard.press(`Alt+Shift+${key}`)
      await expect.poll(async () => (await element(page, '渐变'))?.blendMode ?? 'normal').toBe(mode)
    }
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

async function startFrames(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const state = { gaps: [], last: performance.now(), on: true }
    globalThis.__styleFrames = state
    const tick = (now) => { state.gaps.push(now - state.last); state.last = now; if (state.on) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })()`)
}

async function stopFrames(page: Page): Promise<{ readonly frames: number; readonly median: number; readonly p95: number; readonly worst: number }> {
  const gaps = await page.evaluate('(() => { const state = globalThis.__styleFrames; state.on = false; return state.gaps })()') as number[]
  const sorted = [...gaps].sort((left, right) => left - right)
  const at = (share: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]! * 10) / 10
  return { frames: gaps.length, median: at(0.5), p95: at(0.95), worst: at(1) }
}

/** Moves the mouse from one point to another in steps, about one a frame. */
async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps: number): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

test('a 4000-pixel picture keeps up while a blur radius is dragged and while a styled title moves over it', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-ui-out-'))
  const { app, page, userData } = await openCoffeePoster(out, 'ai-canvas-styles-ui-')
  try {
    const imageId = await addPicture(page, '大图', 4000, { x: 0, y: 0, width: 4000, height: 4000 }, 4000)
    // The picture under the poster's text.
    await page.evaluate(async ({ imageId }) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      const title = current.elements.find((candidate) => candidate.name === '标题')!
      await api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '放到下面', commands: [
        { kind: 'element.reorder', elementId: imageId, toIndex: 1 },
        { kind: 'element.update', elementId: title.id, changes: { style: {
          dropShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 0.6, angle: 120, distance: 40, spread: 0, size: 30 },
          stroke: { enabled: true, size: 12, position: 'outside', color: '#FFFFFF', opacity: 1 }
        } } }
      ] as never } })
    }, { imageId })
    await openEditor(page)
    // As in the other canvas performance tests: without a graphics card the glass panels blur again in software whenever the canvas changes.
    await page.addStyleTag({ content: '* { backdrop-filter: none !important; }' })
    await page.getByRole('tab', { name: '图层' }).click()
    await row(page, imageId).locator('.layer-copy').click()
    await page.keyboard.press('Control+0')
    await page.waitForTimeout(800)

    // Dragging the radius of 高斯模糊: each step is a new preview of the 4000-pixel picture.
    await page.getByRole('tab', { name: '属性' }).click()
    await page.getByRole('combobox', { name: '添加滤镜' }).selectOption('gaussian-blur')
    const blur = page.getByRole('dialog', { name: '高斯模糊' })
    await expect(blur).toBeVisible()
    await page.waitForTimeout(500)
    const slider = (await blur.getByRole('slider', { name: '半径（像素）' }).boundingBox())!
    await startFrames(page)
    await glide(page, { x: slider.x + 2, y: slider.y + slider.height / 2 }, { x: slider.x + slider.width * 0.15, y: slider.y + slider.height / 2 }, 60)
    const radius = await stopFrames(page)
    await blur.getByRole('button', { name: '确定' }).click()
    await expect.poll(async () => { const image = (await currentScene(page)).elements.find((candidate) => candidate.id === imageId); return image?.type === 'image' ? image.adjustments?.length ?? 0 : 0 }).toBe(1)

    // The styled title moves over the blurred picture.
    await page.getByRole('tab', { name: '图层' }).click()
    const titleId = (await currentScene(page)).elements.find((candidate) => candidate.name === '标题')!.id
    await row(page, titleId).locator('.layer-copy').click()
    const at = await page.evaluate(`(async () => {
      const scene = (await globalThis.desktop.getWorkspaceBootstrap()).scene
      const title = scene.elements.find((candidate) => candidate.id === ${JSON.stringify(titleId)})
      const root = document.querySelector('[data-testid="canvas-stage"]')
      const surface = root.querySelector('.konvajs-content').getBoundingClientRect()
      return { x: surface.left + Number(root.dataset.artboardX) + (title.transform.x + title.transform.width / 2) * Number(root.dataset.artboardWidth), y: surface.top + Number(root.dataset.artboardY) + (title.transform.y + title.transform.height / 2) * Number(root.dataset.artboardHeight) }
    })()`) as { x: number; y: number }
    await startFrames(page)
    await glide(page, at, { x: at.x + 160, y: at.y + 120 }, 60)
    const moving = await stopFrames(page)
    console.log(`PERF-STYLE-4000 blur-radius=${JSON.stringify(radius)} styled-title-move=${JSON.stringify(moving)}`)
    expect(radius.frames).toBeGreaterThan(20)
    expect(moving.frames).toBeGreaterThan(20)
    // A blur is worked out again for each step (at half the detail while dragged); here about 15 a second.
    expect(radius.p95).toBeLessThan(150)
    expect(moving.p95).toBeLessThan(50)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
