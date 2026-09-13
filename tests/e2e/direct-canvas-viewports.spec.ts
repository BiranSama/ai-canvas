import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { waitForPaintedShape } from '../helpers/canvas-hit-readiness'

const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const

for (const viewport of VIEWPORTS) {
  test(`Direct Canvas keeps core controls reachable at ${viewport.width} by ${viewport.height}`, async ({ browserName }, testInfo) => {
    void browserName
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-direct-viewport-'))
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: '1' }
    })
    try {
      const window = await app.firstWindow()
      await window.setViewportSize(viewport)
      await window.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
      await expect(window.getByTestId('canvas-stage')).toBeVisible()
      await window.getByRole('button', { name: '文字 T' }).click()
      const contextBar = window.getByTestId('canvas-stage').getByRole('toolbar', { name: '所选元素快捷操作' })
      await expect(contextBar).toBeVisible()
      const zoomSlider = window.getByRole('slider', { name: '画布缩放比例' })
      await expect(zoomSlider).toBeVisible()

      await window.getByRole('button', { name: '形状', exact: true }).click()
      const shapePoint = await waitForPaintedShape(window)
      await window.mouse.dblclick(shapePoint.x, shapePoint.y)
      const shapeToolbar = window.getByTestId('canvas-stage').getByRole('toolbar', { name: '形状直接编辑' })
      await expect(shapeToolbar).toBeVisible()
      await expect(window.getByTestId('canvas-stage')).toHaveAttribute('data-shape-editing', shapePoint.shapeId)
      await writeFile(testInfo.outputPath('main-rendered-hit.json'), JSON.stringify(shapePoint, null, 2))

      if (viewport.width === 1440) {
        const scale = window.getByTestId('viewport-scale')
        const initialScale = Number((await scale.textContent())?.replace('%', ''))
        await window.getByRole('button', { name: '放大画布' }).click()
        await expect.poll(async () => Number((await scale.textContent())?.replace('%', ''))).toBeGreaterThan(initialScale)
        await window.getByRole('button', { name: '适合窗口' }).click()
        await expect.poll(async () => Number((await scale.textContent())?.replace('%', ''))).toBe(initialScale)
      }

      const boxes = await Promise.all([
        window.getByTestId('open-settings').boundingBox(),
        window.locator('.export-control').boundingBox(),
        window.locator('.canvas-workspace').boundingBox(),
        window.getByTestId('canvas-stage').boundingBox(),
        shapeToolbar.boundingBox(),
        zoomSlider.boundingBox()
      ])
      const [settings, exportControl, workspace, stage, context, zoom] = boxes
      if (settings === null || exportControl === null || workspace === null || stage === null || context === null || zoom === null) throw new Error('Direct Canvas geometry is incomplete.')
      expect(settings.x + settings.width).toBeLessThanOrEqual(exportControl.x)
      for (const box of [workspace, stage, context, zoom]) {
        expect(box.x).toBeGreaterThanOrEqual(-1)
        expect(box.y).toBeGreaterThanOrEqual(-1)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
      }
      for (const islandId of ['tools', 'composer', 'inspector'] as const) {
        const box = await window.locator(`[data-island-id="${islandId}"]`).boundingBox()
        if (box === null) throw new Error(`${islandId} island is not measurable.`)
        expect(box.x).toBeGreaterThanOrEqual(workspace.x - 1)
        expect(box.y).toBeGreaterThanOrEqual(workspace.y - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(workspace.x + workspace.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(workspace.y + workspace.height + 1)
      }
      const composer = await window.locator('[data-island-id="composer"]').boundingBox()
      const inspector = await window.locator('[data-island-id="inspector"]').boundingBox()
      if (composer === null || inspector === null) throw new Error('Default island separation is not measurable.')
      expect(composer.x + composer.width).toBeLessThanOrEqual(inspector.x - 17)

      await window.screenshot({ path: testInfo.outputPath(`direct-canvas-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
    } finally {
      await app.close()
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
