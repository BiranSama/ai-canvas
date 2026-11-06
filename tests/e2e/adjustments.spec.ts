import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ELEMENT_SCHEMA_VERSION, type Scene } from '../../src/domain'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import { adjustPixels, defaultAdjustment } from '../../src/shared/adjustments'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { exportThroughPanel } from '../helpers/export-file'

/*
 * Adjustments look the same wherever the picture is drawn: the canvas's
 * export and Main's renderer (the reference a model receives) agree pixel
 * for pixel, for an image layer's own adjustments, one made in a selection,
 * and adjustment layers with a mask and opacity.
 */

const WIDTH = 1024
const HEIGHT = 1280
const IMAGE = { x: 100, y: 120, width: 200, height: 160 }

async function openCoffeePoster(exportDirectory: string): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-adjust-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library', AI_CANVAS_E2E_EXPORT_DIR: exportDirectory }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('region', { name: '连上服务' }).getByRole('button', { name: '先用示例看看' }).click()
  await page.getByRole('region', { name: '从示例开始' }).getByRole('button', { name: '从示例开始：咖啡店海报' }).click()
  await expect(page.locator('.conversation-title p')).toContainText('4:5')
  return { app, page, userData }
}

function scene(page: Page): Promise<Scene> {
  return page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene)
}

async function projectAssets(userData: string, projectId: string): Promise<(assetId: string) => Promise<string | null>> {
  for (const entry of await readdir(join(userData, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.aicanvas')) continue
    const folder = join(userData, 'projects', entry.name)
    const db = new Database(join(folder, 'project.db'), { readonly: true })
    const matches = (db.prepare('SELECT id FROM projects').get() as { id: string }).id === projectId
    const rows = db.prepare('SELECT id, relative_path FROM assets').all() as { id: string; relative_path: string }[]
    db.close()
    if (matches) return async (assetId) => { const row = rows.find((candidate) => candidate.id === assetId); return row === undefined ? null : join(folder, row.relative_path) }
  }
  throw new Error('The project folder was not found.')
}

async function raw(source: string | Buffer): Promise<Buffer> {
  return sharp(typeof source === 'string' ? await readFile(source) : source).ensureAlpha().raw().toBuffer()
}

function worstDifference(left: Buffer, right: Buffer): number {
  let worst = 0
  for (let index = 0; index < left.length; index += 1) worst = Math.max(worst, Math.abs(left[index]! - right[index]!))
  return worst
}

test('adjustments draw the same in the export and in Main', async () => {
  test.setTimeout(120_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-adjust-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const ids = await page.evaluate(async ({ version, image, width, height }) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      const rgba = new Uint8Array(image.width * image.height * 4)
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) rgba.set([Math.round(x / image.width * 255), Math.round(y / image.height * 255), 160, 255], (y * image.width + x) * 4)
      }
      const picture = await api.importPixels({ projectId: current.projectId, name: '渐变', width: image.width, height: image.height, rgba })
      const half = new Uint8Array(image.width * image.height)
      for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) half[y * image.width + x] = x < image.width / 2 ? 255 : 0
      const clip = await api.importPixels({ projectId: current.projectId, name: '选区', width: image.width, height: image.height, gray: half })
      const top = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) top.fill(y < height / 2 ? 255 : 96, y * width, (y + 1) * width)
      const mask = await api.importPixels({ projectId: current.projectId, name: '调整蒙版', width, height, gray: top })
      const base = { version, description: '', zIndex: 0, visible: true, locked: false, groupId: null, referencePolicy: 'include' as const }
      const imageId = crypto.randomUUID()
      const invertId = crypto.randomUUID()
      const blackWhiteId = crypto.randomUUID()
      const whole = { x: 0, y: 0, width: 1, height: 1, rotation: 0 }
      const result = await api.executeSceneCommands({
        projectId: current.projectId,
        expectedSceneRevision: current.revision,
        batch: { id: crypto.randomUUID(), origin: 'user', summary: '调整测试', commands: [
          // Text is drawn differently by the browser and by Main, so it is set aside here.
          ...current.elements.filter((element) => element.type === 'text').map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } })),
          { kind: 'element.add', element: {
            ...base, id: imageId, type: 'image', name: '渐变', opacity: 1, semanticRole: 'content', assetId: picture.id,
            transform: { x: image.x / width, y: image.y / height, width: image.width / width, height: image.height / height, rotation: 0 },
            crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general',
            adjustments: [
              { id: crypto.randomUUID(), enabled: true, settings: { kind: 'hue-saturation', hue: 120, saturation: 20, lightness: 0, colorize: null } },
              { id: crypto.randomUUID(), enabled: true, clip: clip.id, settings: { kind: 'levels', channels: {
                rgb: { inputBlack: 20, inputWhite: 230, gamma: 1.5, outputBlack: 0, outputWhite: 255 },
                red: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
                green: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
                blue: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }
              } } }
            ]
          } },
          { kind: 'element.add', element: { ...base, id: invertId, type: 'adjustment', name: '反相 1', opacity: 0.5, semanticRole: 'adjustment', transform: whole, settings: { kind: 'invert' } } },
          { kind: 'element.add', element: {
            ...base, id: blackWhiteId, type: 'adjustment', name: '黑白 1', opacity: 0.7, semanticRole: 'adjustment', transform: whole,
            settings: { kind: 'black-white', reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null },
            mask: { assetId: mask.id, enabled: true }
          } }
        ] }
      })
      return { ok: result.ok, imageId, invertId, blackWhiteId }
    }, { version: ELEMENT_SCHEMA_VERSION, image: IMAGE, width: WIDTH, height: HEIGHT })
    expect(ids.ok).toBe(true)

    const exported = await raw(await exportThroughPanel(page))
    const current = await scene(page)
    const resolveAsset = await projectAssets(userData, current.projectId)
    const main = await new CompositeReferenceRenderer(resolveAsset).render(current, 'final')
    expect(main.warnings).toEqual([])
    const reference = await raw(main.buffer)
    expect(exported.length).toBe(WIDTH * HEIGHT * 4)
    expect(worstDifference(exported, reference)).toBeLessThanOrEqual(2)

    // A pixel in the selected half of the image went through each adjustment in turn.
    const pixel = new Uint8ClampedArray([Math.round(20 / IMAGE.width * 255), Math.round(80 / IMAGE.height * 255), 160, 255])
    adjustPixels(pixel, { kind: 'hue-saturation', hue: 120, saturation: 20, lightness: 0, colorize: null })
    const identity = { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }
    adjustPixels(pixel, { kind: 'levels', channels: { rgb: { ...identity, inputBlack: 20, inputWhite: 230, gamma: 1.5 }, red: identity, green: identity, blue: identity } })
    adjustPixels(pixel, { kind: 'invert' }, { amount: 0.5 })
    adjustPixels(pixel, defaultAdjustment('black-white'), { amount: 0.7 })
    const drawnPixel = [...exported.subarray(((IMAGE.y + 80) * WIDTH + IMAGE.x + 20) * 4, ((IMAGE.y + 80) * WIDTH + IMAGE.x + 20) * 4 + 3)]
    drawnPixel.forEach((value, channel) => expect(Math.abs(value - pixel[channel]!)).toBeLessThanOrEqual(2))

    // The adjustment layers did change the picture: the cream background is greyed in the top half.
    const at = (x: number, y: number): number[] => [...exported.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)]
    const [r, g, b] = at(900, 100)
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(6)

  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
