import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { blendModeSchema, ELEMENT_SCHEMA_VERSION, type Scene } from '../../src/domain'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { exportThroughPanel } from '../helpers/export-file'

/*
 * Blend modes, filters and layer styles look the same wherever the picture
 * is drawn: the canvas's export and Main's renderer (the reference a model
 * receives) agree pixel for pixel.
 */

const WIDTH = 1024
const HEIGHT = 1280

async function openCoffeePoster(exportDirectory: string): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-'))
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

/** The largest difference between two pictures, and where it is. */
function worstDifference(left: Buffer, right: Buffer): { readonly value: number; readonly x: number; readonly y: number } {
  let worst = { value: 0, x: 0, y: 0 }
  for (let index = 0; index < left.length; index += 1) {
    const value = Math.abs(left[index]! - right[index]!)
    if (value > worst.value) worst = { value, x: Math.floor(index / 4) % WIDTH, y: Math.floor(index / 4 / WIDTH) }
  }
  return worst
}

test('blend modes, filters and layer styles draw the same in the export and in Main', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const result = await page.evaluate(async ({ version, width, height, modes }) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      const size = 96
      const ramp = new Uint8Array(size * size * 4)
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) ramp.set([Math.round(x / size * 255), Math.round(y / size * 255), 200 - Math.round(x / size * 120), 255], (y * size + x) * 4)
      const gradient = await api.importPixels({ projectId: current.projectId, name: '渐变', width: size, height: size, rgba: ramp })
      // A soft-edged disc on transparency, as a cut-out subject is.
      const disc = new Uint8Array(size * size * 4)
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const edge = Math.min(1, Math.max(0, 40 - Math.hypot(x - 48, y - 48)))
          disc.set([230, 120, 40, Math.round(edge * 255)], (y * size + x) * 4)
        }
      }
      const subject = await api.importPixels({ projectId: current.projectId, name: '主体', width: size, height: size, rgba: disc })
      const left = new Uint8Array(size * size)
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) left[y * size + x] = x < size / 2 ? 255 : 0
      const mask = await api.importPixels({ projectId: current.projectId, name: '蒙版', width: size, height: size, gray: left })
      const base = { version, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include' as const, semanticRole: 'content' }
      const at = (x: number, y: number, w = 96, h = 96, rotation = 0) => ({ x: x / width, y: y / height, width: w / width, height: h / height, rotation })
      const image = (name: string, assetId: string, transform: ReturnType<typeof at>, extra: Record<string, unknown> = {}) => ({
        kind: 'element.add' as const,
        element: { ...base, id: crypto.randomUUID(), zIndex: 0, type: 'image', name, opacity: 1, assetId, transform, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general', ...extra }
      })
      const commands = [
        // Text, and shape edges between pixels, are drawn differently by the browser and by Main, so they are set aside here;
        // the background, which covers the canvas, stays.
        ...current.elements.filter((element) => element.type === 'text' || (element.type === 'shape' && (element.transform.width < 1 || element.transform.height < 1)))
          .map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } })),
        // Every blend mode over the poster.
        ...modes.map((blendMode, index) => image(`混合 ${blendMode}`, gradient.id, at(60 + (index % 8) * 112, 60 + Math.floor(index / 8) * 112), { blendMode, opacity: index % 3 === 0 ? 0.6 : 1 })),
        // The filters, one with its mask going on after a blur.
        image('模糊', gradient.id, at(60, 320, 192, 192), { adjustments: [
          { id: crypto.randomUUID(), enabled: true, settings: { kind: 'gaussian-blur', radius: 6 } },
          { id: crypto.randomUUID(), enabled: true, settings: { kind: 'add-noise', amount: 15, distribution: 'gaussian', monochromatic: false, seed: 42 } }
        ] }),
        image('锐化', gradient.id, at(300, 320, 192, 192), { adjustments: [{ id: crypto.randomUUID(), enabled: true, settings: { kind: 'unsharp-mask', amount: 150, radius: 2, threshold: 2 } }] }),
        image('动感模糊', gradient.id, at(540, 320, 192, 192), { adjustments: [{ id: crypto.randomUUID(), enabled: true, settings: { kind: 'motion-blur', angle: 30, distance: 24 } }], mask: { assetId: mask.id, enabled: true } }),
        // Every style on a soft cut-out, and on an opaque picture.
        image('样式主体', subject.id, at(120, 620, 192, 192), { blendMode: 'multiply', style: {
          dropShadow: { enabled: true, blendMode: 'multiply', color: '#102030', opacity: 0.7, angle: 120, distance: 14, spread: 10, size: 12 },
          outerGlow: { enabled: true, blendMode: 'screen', color: '#FFE080', opacity: 0.8, spread: 0, size: 10 },
          innerShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 0.5, angle: 90, distance: 6, choke: 0, size: 6 },
          stroke: { enabled: true, size: 5, position: 'outside', color: '#FFFFFF', opacity: 1 },
          colorOverlay: { enabled: true, blendMode: 'color', color: '#2060C0', opacity: 0.4 }
        } }),
        image('渐变叠加', gradient.id, at(520, 640, 192, 160), { opacity: 0.8, style: {
          gradientOverlay: { enabled: true, blendMode: 'overlay', opacity: 0.9, style: 'linear', angle: 45, scale: 100, reverse: false, stops: [{ offset: 0, color: '#FF0000' }, { offset: 0.5, color: '#00FF00' }, { offset: 1, color: '#0000FF' }] },
          stroke: { enabled: true, size: 8, position: 'center', color: '#202020', opacity: 0.8 },
          dropShadow: { enabled: true, blendMode: 'normal', color: '#000000', opacity: 0.5, angle: -30, distance: 10, spread: 0, size: 16 }
        } })
      ]
      return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '样式测试', commands: commands as never } })
    }, { version: ELEMENT_SCHEMA_VERSION, width: WIDTH, height: HEIGHT, modes: blendModeSchema.options })
    expect(result.ok).toBe(true)

    const exported = await raw(await exportThroughPanel(page))
    const current = await scene(page)
    const resolveAsset = await projectAssets(userData, current.projectId)
    const main = await new CompositeReferenceRenderer(resolveAsset).render(current, 'final')
    expect(main.warnings).toEqual([])
    const reference = await raw(main.buffer)
    expect(exported.length).toBe(WIDTH * HEIGHT * 4)
    if (process.env.AI_CANVAS_STYLE_DUMP !== undefined) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(process.env.AI_CANVAS_STYLE_DUMP, 'export.png'), await sharp(exported, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer())
      await writeFile(join(process.env.AI_CANVAS_STYLE_DUMP, 'main.png'), main.buffer)
      await writeFile(join(process.env.AI_CANVAS_STYLE_DUMP, 'scene.json'), JSON.stringify(current, null, 1))
    }
    const worst = worstDifference(exported, reference)
    expect(worst.value, `worst at ${worst.x},${worst.y}`).toBeLessThanOrEqual(2)

    // The styles did change the picture: the outside stroke is white just above the disc.
    const pixel = (x: number, y: number): number[] => [...exported.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)]
    const [r, g, b] = pixel(120 + 96, 620 + 96 - 80 - 4)
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(200)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('adjustment layers lay their result over the picture in each blend mode, the same in the export and in Main', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const result = await page.evaluate(async ({ version, width, height, modes }) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      // A colourful picture drawn pixel for pixel, so both renderers start from the same pixels.
      const rgba = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set([Math.round(x / width * 255), Math.round((y % 80) / 80 * 255), Math.round((1 - x / width) * 200) + 30, 255], (y * width + x) * 4)
      const picture = await api.importPixels({ projectId: current.projectId, name: '底图', width, height, rgba })
      const base = { version, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include' as const }
      const whole = { x: 0, y: 0, width: 1, height: 1, rotation: 0 }
      const commands: unknown[] = [
        ...current.elements.map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } })),
        { kind: 'element.add', element: { ...base, id: crypto.randomUUID(), zIndex: 0, type: 'image', name: '底图', opacity: 1, semanticRole: 'content', assetId: picture.id, transform: whole, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general' } }
      ]
      // One curves adjustment layer a band, each in its own blend mode, half of them partly transparent.
      const band = Math.floor(height / modes.length)
      for (const [index, blendMode] of modes.entries()) {
        const gray = new Uint8Array(width * height)
        gray.fill(255, index * band * width, (index + 1) * band * width)
        const mask = await api.importPixels({ projectId: current.projectId, name: `蒙版 ${index}`, width, height, gray })
        commands.push({ kind: 'element.add', element: {
          ...base, id: crypto.randomUUID(), zIndex: 0, type: 'adjustment', name: `曲线 ${blendMode}`, opacity: index % 2 === 0 ? 1 : 0.6, blendMode, semanticRole: 'adjustment', transform: whole,
          settings: { kind: 'curves', channels: { rgb: [[0, 0], [100, 170], [255, 255]], red: [[0, 30], [255, 220]], green: [[0, 0], [255, 255]], blue: [[0, 0], [128, 90], [255, 255]] } },
          mask: { assetId: mask.id, enabled: true }
        } })
      }
      return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '调整图层混合', commands: commands as never } })
    }, { version: ELEMENT_SCHEMA_VERSION, width: WIDTH, height: HEIGHT, modes: blendModeSchema.options })
    expect(result.ok).toBe(true)
    const exported = await raw(await exportThroughPanel(page))
    const current = await scene(page)
    const main = await new CompositeReferenceRenderer(await projectAssets(userData, current.projectId)).render(current, 'final')
    expect(main.warnings).toEqual([])
    const worst = worstDifference(exported, await raw(main.buffer))
    expect(worst.value, `worst at ${worst.x},${worst.y}`).toBeLessThanOrEqual(2)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('a turned layer turns about its corner and keeps its shadow falling the picture\'s way, as Main draws it', async () => {
  test.setTimeout(180_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-styles-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const result = await page.evaluate(async ({ version, width, height }) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      const size = 96
      const square = new Uint8Array(size * size * 4)
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) square.set(x > 8 && y > 8 && x < 88 && y < 88 ? [40, 120, 220, 255] : [0, 0, 0, 0], (y * size + x) * 4)
      const picture = await api.importPixels({ projectId: current.projectId, name: '方块', width: size, height: size, rgba: square })
      const base = { version, description: '', visible: true, locked: false, groupId: null, referencePolicy: 'include' as const, semanticRole: 'content' }
      return api.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision, batch: { id: crypto.randomUUID(), origin: 'user', summary: '旋转', commands: [
        ...current.elements.filter((element) => element.type === 'text' || element.type === 'placeholder' || (element.type === 'shape' && (element.transform.width < 1 || element.transform.height < 1)))
          .map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { visible: false } })),
        { kind: 'element.add', element: {
          ...base, id: crypto.randomUUID(), zIndex: 0, type: 'image', name: '转过的方块', opacity: 1, assetId: picture.id, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general',
          transform: { x: 400 / width, y: 400 / height, width: 192 / width, height: 192 / height, rotation: 90 },
          style: { dropShadow: { enabled: true, blendMode: 'multiply', color: '#000000', opacity: 1, angle: 0, distance: 40, spread: 100, size: 4 } }
        } }
      ] as never } })
    }, { version: ELEMENT_SCHEMA_VERSION, width: WIDTH, height: HEIGHT })
    expect(result.ok).toBe(true)
    const exported = await raw(await exportThroughPanel(page))
    const current = await scene(page)
    const main = await new CompositeReferenceRenderer(await projectAssets(userData, current.projectId)).render(current, 'final')
    const worst = worstDifference(exported, await raw(main.buffer))
    // A turned picture is resampled a little differently by the browser and by librsvg.
    expect(worst.value, `worst at ${worst.x},${worst.y}`).toBeLessThanOrEqual(4)
    // Turned a quarter about its top-left corner, the square lies left of x = 400; light from the right casts its shadow further left.
    const pixel = (x: number, y: number): number[] => [...exported.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)]
    expect(pixel(400 - 96, 400 + 96)).toEqual([40, 120, 220])
    const shadow = pixel(400 - 192 - 20 + 2, 400 + 96)
    expect(Math.max(...shadow)).toBeLessThan(20)
    const light = pixel(400 + 20, 400 + 96)
    expect(Math.min(...light)).toBeGreaterThan(150)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
