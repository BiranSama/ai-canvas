import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { captureWorkbench, hitWorkbenchControl as hit } from '../helpers/workbench-ui'

for (const viewport of [{ width: 1440, height: 900, zoom: 1 }, { width: 1024, height: 700, zoom: 1.5 }]) {
  test(`all three instruments project at all four edges and restore at ${viewport.width} / ${viewport.zoom}`, async () => {
    test.setTimeout(90000)
    const userData = await mkdtemp(join(tmpdir(), 'all-docks-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('OFFLINE_DOCKS') } })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await hit(page.getByRole('button', { name: '文字 T', exact: true }))
      await hit(page.getByRole('tab', { name: '属性', exact: true }))
      await page.getByLabel('文字内容', { exact: true }).fill('仍然可编辑的山海之间')
      await page.getByLabel('文字内容', { exact: true }).blur()
      await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene.elements.find((element) => element.type === 'text')?.content).toBe('仍然可编辑的山海之间')
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom)
      }, viewport)
      await expect.poll(() => page.evaluate('innerWidth') as Promise<number>).toBeCloseTo(viewport.width / viewport.zoom, -1)
      const islands = [{ id: 'tools', label: '画布工具' }, { id: 'inspector', label: '图层与属性' }, { id: 'composer', label: 'Agent 创作' }]
      const records: unknown[] = []
      for (const instrument of islands) {
        const island = page.locator(`[data-island-id="${instrument.id}"]`)
        if (await island.getAttribute('data-island-mode') !== 'orb') {
          await island.getByRole('toolbar', { name: `${instrument.label}布局控制`, exact: true }).hover()
          await hit(island.getByRole('button', { name: `收起${instrument.label}为圆球`, exact: true }))
        }
      }
      for (const instrument of islands) {
        let island = page.locator(`[data-island-id="${instrument.id}"]`)
        await hit(page.getByRole('button', { name: `展开${instrument.label}`, exact: true }))
        for (const edge of [{ name: 'top', key: 'ArrowUp' }, { name: 'left', key: 'ArrowLeft' }, { name: 'bottom', key: 'ArrowDown' }, { name: 'right', key: 'ArrowRight' }]) {
          island = page.locator(`[data-island-id="${instrument.id}"]`)
          const grip = island.getByRole('toolbar', { name: `${instrument.label}布局控制`, exact: true })
          await grip.focus(); await grip.press(`Alt+${edge.key}`)
          await expect(island).toHaveAttribute('data-island-mode', `docked-${edge.name}`)
          await page.getByRole('button', { name: '画布', exact: true }).focus()
          await page.mouse.move(50, 30)
          const horizontal = edge.name === 'top' || edge.name === 'bottom'
          await expect.poll(async () => {
            const box = await island.boundingBox()
            return box !== null && (horizontal ? box.width > box.height : box.width <= 400)
          }).toBe(true)
          if (instrument.id === 'tools') {
            await hit(island.getByRole('button', { name: '蒙版', exact: true }))
            await hit(island.getByRole('button', { name: '选择 V', exact: true }))
          } else if (instrument.id === 'inspector') {
            await hit(island.getByRole('tab', { name: '属性', exact: true }))
            await expect(island.getByLabel('文字内容', { exact: true })).toHaveValue('仍然可编辑的山海之间')
            await hit(island.getByLabel('文字内容', { exact: true }))
            await island.getByLabel('文字内容', { exact: true }).fill('仍然可编辑的山海之间')
            await island.getByLabel('文字内容', { exact: true }).blur()
          } else {
            await hit(island.getByLabel('创作输入', { exact: true }))
            await island.getByLabel('创作输入', { exact: true }).fill('保留主体，只调整光线')
            await island.getByLabel('创作输入', { exact: true }).press('Tab')
            await expect(island.getByRole('button', { name: '发送创作指令', exact: true })).toBeFocused()
          }
          await expect.poll(() => page.locator('.glass-island').evaluateAll(nodes => nodes.every(node => node.getAnimations().every((animation: { playState: string }) => animation.playState !== 'running')))).toBe(true)
          records.push({ instrument, edge, box: await island.boundingBox(), native: await captureWorkbench(app, test.info().outputPath(`${instrument.id}-${edge.name}.png`)) })
          if (instrument.id === 'inspector') {
            await writeFile(test.info().outputPath(`status-${edge.name}-geometry.json`), JSON.stringify(await page.locator('.canvas-workspace').evaluate(node => [...node.querySelectorAll('.canvas-status, .glass-island, .canvas-size-float, .runtime-pill')].map(item => ({ className: item.className, rect: item.getBoundingClientRect().toJSON() }))), null, 2))
            await hit(page.getByRole('button', { name: '适合窗口', exact: true }))
            await hit(page.getByRole('button', { name: '进入专注', exact: true }))
            await hit(page.getByRole('button', { name: '退出专注', exact: true }))
            await hit(page.locator('.canvas-size-trigger'))
            const applySize = page.getByRole('button', { name: '应用画布尺寸', exact: true })
            await applySize.scrollIntoViewIfNeeded()
            await hit(applySize)
            // A docked inspector must not intercept a different instrument's restore orb.
            await hit(page.getByRole('button', { name: '展开Agent 创作', exact: true }))
            const composer = page.locator('[data-island-id="composer"]')
            await expect(composer).not.toHaveAttribute('data-island-mode', 'orb')
            await expect.poll(() => composer.evaluate(node => node.getAnimations().every((animation: { playState: string }) => animation.playState !== 'running'))).toBe(true)
            await composer.getByRole('toolbar', { name: 'Agent 创作布局控制', exact: true }).hover()
            await hit(composer.getByRole('button', { name: '收起Agent 创作为圆球', exact: true }))
          }
        }
        await island.getByRole('toolbar', { name: `${instrument.label}布局控制`, exact: true }).hover()
        await hit(island.getByRole('button', { name: `收起${instrument.label}为圆球`, exact: true }))
      }
      const scene = (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene
      expect(scene.elements).toHaveLength(1)
      expect(scene.elements[0]).toMatchObject({ type: 'text', content: '仍然可编辑的山海之间' })
      await writeFile(test.info().outputPath('dock-facts.json'), JSON.stringify({ userData, viewport, records, scene, actualProviderRequests: 0 }, null, 2))
    } finally { await captureWorkbench(app, test.info().outputPath('last-native.png')); await app.close() }
  })
}
