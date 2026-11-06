import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readPsd, type Layer } from 'ag-psd'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
// Gives ag-psd what it needs to decode pixels outside a browser.
import '../../src/main/psd/psd-import'
import { ELEMENT_SCHEMA_VERSION, type Scene } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { exportThroughPanel } from '../helpers/export-file'

/*
 * The 导出 panel from a merchant example: a PSD that keeps groups, masks,
 * hidden layers and editable text and matches the PNG; a PDF to print on
 * A4; several sizes at once without touching the project; and one size
 * opened as its own laid-out project.
 */

async function openCoffeePoster(exportDirectory: string): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-export-'))
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

async function raw(path: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(await readFile(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function find(layers: readonly Layer[] | undefined, name: string): Layer | undefined {
  for (const layer of layers ?? []) {
    if (layer.name === name) return layer
    const inner = find(layer.children, name)
    if (inner !== undefined) return inner
  }
  return undefined
}

test('a PSD keeps groups, masks, hidden layers and editable text, and matches the PNG', async () => {
  test.setTimeout(120_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-export-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const before = (await scene(page)).elements.length
    // A mask that shows the left half of the price badge, the title and subtitle grouped, the shop name hidden, the bottom bar past the edge.
    const fixture = await page.evaluate(async (version) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const current = (await api.getWorkspaceBootstrap()).scene
      const named = (name: string) => current.elements.find((element) => element.name === name)!
      const gray = new Uint8Array(64 * 64)
      for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) gray[y * 64 + x] = x < 32 ? 255 : 0
      const mask = await api.importPixels({ projectId: current.projectId, name: '圆标蒙版', width: 64, height: 64, gray })
      const title = named('标题')
      const subtitle = named('副标题')
      const result = await api.executeSceneCommands({
        projectId: current.projectId,
        expectedSceneRevision: current.revision,
        batch: { id: crypto.randomUUID(), origin: 'user', summary: '导出测试', commands: [
          { kind: 'element.update', elementId: named('价格圆标').id, changes: { mask: { assetId: mask.id, enabled: true } } },
          { kind: 'element.update', elementId: named('标题').id, changes: { mask: { assetId: mask.id, enabled: true } } },
          { kind: 'element.update', elementId: named('店名').id, changes: { visible: false } },
          // The bottom bar reaches past the canvas: a PSD keeps the part outside it.
          { kind: 'element.update', elementId: named('底部色块').id, changes: { transform: { ...named('底部色块').transform, height: named('底部色块').transform.height + 0.1 } } },
          { kind: 'element.group', elementIds: [title.id, subtitle.id], group: {
            id: crypto.randomUUID(), version, type: 'group', name: '标题组', description: '', transform: title.transform, zIndex: 0, opacity: 1,
            visible: true, locked: false, groupId: null, semanticRole: 'composition', referencePolicy: 'include', childIds: [title.id, subtitle.id]
          } }
        ] }
      })
      return { ok: result.ok, badge: named('价格圆标').transform, title: title.transform }
    }, ELEMENT_SCHEMA_VERSION)
    expect(fixture.ok).toBe(true)
    await expect(page.locator('.conversation-title p')).toContainText(` ${before + 1} 个元素`)

    const psdPath = await exportThroughPanel(page, { kind: 'psd' })
    const pngPath = await exportThroughPanel(page)
    const psd = readPsd(await readFile(psdPath), { useImageData: true })
    const png = await raw(pngPath)
    expect({ width: psd.width, height: psd.height }).toEqual({ width: png.width, height: png.height })
    expect(psd.children?.[0]?.name).toBe('背景色')

    const group = find(psd.children, '标题组')
    expect(group?.children?.map((layer) => layer.name)).toEqual(['标题', '副标题'])
    expect(find(psd.children, '店名')?.hidden).toBe(true)
    const bar = find(psd.children, '底部色块')!
    expect(bar.bottom).toBeGreaterThan(psd.height + 100)
    expect(find(psd.children, '标题')?.text?.text).toBe('秋日拿铁')
    expect(find(psd.children, '价格')?.text?.text).toBe('¥18')

    // The badge keeps all its pixels; its mask hides the right half, in Photoshop as on the canvas.
    const badge = find(psd.children, '价格圆标')!
    expect(badge.mask?.disabled).not.toBe(true)
    const maskData = badge.mask!.imageData!
    const maskWidth = badge.mask!.right! - badge.mask!.left!
    const maskHeight = badge.mask!.bottom! - badge.mask!.top!
    expect(maskData.data[(Math.floor(maskHeight / 2) * maskWidth + Math.floor(maskWidth * 0.25)) * 4]).toBeGreaterThan(250)
    expect(maskData.data[(Math.floor(maskHeight / 2) * maskWidth + Math.floor(maskWidth * 0.75)) * 4]).toBeLessThan(5)
    const layerPixels = badge.imageData!
    const layerWidth = badge.right! - badge.left!
    const layerHeight = badge.bottom! - badge.top!
    expect(layerPixels.data[(Math.floor(layerHeight / 2) * layerWidth + Math.floor(layerWidth * 0.75)) * 4 + 3]).toBe(255)

    // The title's mask is the mask itself over the whole box, not read from the letters drawn now:
    // in the hidden half it hides even where there are no letters, so text typed there in Photoshop stays hidden.
    const titleLayer = find(psd.children, '标题')!
    const titleMask = titleLayer.mask!
    const maskAt = (u: number, v: number): number => {
      const x = Math.round((fixture.title.x + fixture.title.width * u) * psd.width) - titleMask.left!
      const y = Math.round((fixture.title.y + fixture.title.height * v) * psd.height) - titleMask.top!
      return titleMask.imageData!.data[(y * (titleMask.right! - titleMask.left!) + x) * 4]!
    }
    expect(maskAt(0.25, 0.1)).toBeGreaterThan(250)
    expect(maskAt(0.75, 0.1)).toBeLessThan(5)
    expect(maskAt(0.75, 0.5)).toBeLessThan(5)

    // The PSD's picture is the PNG export.
    let worst = 0
    const composite = psd.imageData!.data
    for (let index = 0; index < composite.length; index += 1) worst = Math.max(worst, Math.abs(composite[index]! - png.data[index]!))
    expect(worst).toBeLessThanOrEqual(2)
    // And there the right half of the badge is hidden: the cream background shows.
    const at = (x: number, y: number): number[] => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)]
    const badgeRight = { x: Math.round((fixture.badge.x + fixture.badge.width * 0.8) * png.width), y: Math.round((fixture.badge.y + fixture.badge.height * 0.5) * png.height) }
    expect(at(badgeRight.x, badgeRight.y)).toEqual(at(Math.round(0.05 * png.width), Math.round(0.5 * png.height)))
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('a print PDF, several sizes at once, and one size opened as its own laid-out project', async () => {
  test.setTimeout(150_000)
  const out = await mkdtemp(join(tmpdir(), 'ai-canvas-export-out-'))
  const { app, page, userData } = await openCoffeePoster(out)
  try {
    const original = await scene(page)
    await page.locator('.export-control > button').evaluate((button: { click(): void }) => button.click())
    const sheet = page.getByRole('dialog', { name: '导出' })
    await sheet.getByRole('button', { name: /^PDF/ }).click()
    await sheet.getByRole('radio', { name: '打印' }).click()
    await expect(sheet.getByText('210 × 263 mm · 2480×3100 像素 · 300 DPI')).toBeVisible()
    await sheet.getByRole('button', { name: '导出', exact: true }).click()
    const pdfSaved = sheet.locator('[data-saved-path]')
    await expect(pdfSaved).toBeVisible({ timeout: 60_000 })
    const pdf = (await readFile((await pdfSaved.getAttribute('data-saved-path'))!)).toString('latin1')
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf).toContain('/MediaBox [0 0 595.276 744.094]')
    expect(pdf).toContain('/Width 2480 /Height 3100')

    await sheet.getByRole('button', { name: /^多尺寸/ }).click()
    for (const name of ['横幅', '公众号封面']) await sheet.getByRole('checkbox', { name: new RegExp(name) }).check()
    await sheet.getByRole('button', { name: '导出 4 个尺寸' }).click()
    await expect(sheet.getByRole('status')).toContainText('已保存 4 个文件', { timeout: 60_000 })
    const sized = (await readdir(out)).filter((name) => name.endsWith('.png')).sort()
    expect(sized).toEqual([
      '咖啡店海报-公众号封面-900x383.png',
      '咖啡店海报-小红书笔记-1080x1440.png',
      '咖啡店海报-朋友圈、社群方图-1080x1080.png',
      '咖啡店海报-横幅-1920x1080.png'
    ].sort())
    for (const name of sized) {
      const [width, height] = /-(\d+)x(\d+)\.png$/.exec(name)!.slice(1).map(Number)
      expect(await sharp(await readFile(join(out, name))).metadata()).toMatchObject({ width, height })
    }
    // The project itself is as it was.
    const after = await scene(page)
    expect(after.revision).toBe(original.revision)
    expect(after.canvas).toEqual(original.canvas)

    // 另存为新项目: a copy laid out at 16:9 opens, ready to ask the agent to tidy it, and one undo brings the old layout back.
    const copyPath = join(out, '咖啡店海报-横幅.aicanvas')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, copyPath)
    const banner = sheet.locator('.export-size-card').filter({ hasText: '横幅' })
    await banner.getByRole('button', { name: '另存为新项目' }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(async () => (await scene(page)).canvas.outputWidth, { timeout: 30_000 }).toBe(1920)
    const copy = await scene(page)
    expect(copy.projectId).not.toBe(original.projectId)
    expect(copy.canvas).toMatchObject({ outputWidth: 1920, outputHeight: 1080, aspectWidth: 16, aspectHeight: 9 })
    await expect(page.getByRole('textbox', { name: '对话输入' })).toHaveValue('这是从 4:5 改成 16:9 的版本，帮我把排版调好，内容和风格不变')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => (await scene(page)).canvas.outputWidth).toBe(1024)
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
