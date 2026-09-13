import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { captureWorkbench, hitWorkbenchControl as hit } from '../helpers/workbench-ui'

for (const theme of ['pearl', 'dusk', 'obsidian'] as const) {
  test(`readable ${theme} instruments across all focuses, reduced motion and solid fallback`, async () => {
    test.setTimeout(90000)
    const userData = await mkdtemp(join(tmpdir(), 'material-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      await app.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __materialRequests: number }
        scope.__materialRequests = 0
        scope.fetch = async () => { scope.__materialRequests++; throw new Error('OFFLINE_MATERIALS') }
      })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
      await hit(page.getByRole('button', { name: '对话', exact: true }))
      await page.getByLabel('对话输入', { exact: true }).fill('创建一张 4:5 的山海封面，主体是一座远山，标题写“山海之间”，保留大面积留白，先不要生成图片。')
      await hit(page.getByRole('button', { name: '发送要求', exact: true }))
      await expect(page.getByTestId('operation-receipt')).toBeVisible()
      await hit(page.getByRole('button', { name: '生成', exact: true }))
      await page.getByTestId('generation-prompt').fill('山海之间，远山与留白')
      await hit(page.getByTestId('generation-submit'))
      await expect(page.getByTestId('generation-result')).toHaveCount(1)
      await hit(page.getByRole('button', { name: '供应商设置', exact: true }))
      const settings = page.getByRole('dialog', { name: '供应商设置', exact: true })
      await hit(settings.getByRole('button', { name: '外观', exact: true }))
      await hit(settings.locator(`[data-appearance-preview="${theme}"]`))
      await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', theme)
      await hit(settings.getByRole('button', { name: '关闭供应商设置', exact: true }))
      const scene = (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene
      const captures: unknown[] = []
      const cdp = await page.context().newCDPSession(page)
      for (const reduced of [false, true]) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [
          { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
          { name: 'prefers-reduced-transparency', value: reduced ? 'reduce' : 'no-preference' }
        ] })
        if (reduced) {
          await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]!
            window.setContentSize(1024, 700); window.webContents.setZoomFactor(1.5)
          })
          await expect(page.locator('html')).toHaveAttribute('data-reduced-transparency', 'true')
        }
        for (const focus of ['对话', '画布', '生成']) {
          await hit(page.getByRole('button', { name: focus, exact: true }))
          if (focus === '生成') await hit(page.locator('.generation-compact-summary'))
          const measured = await page.evaluate(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
            surfaces: [...document.querySelectorAll('.glass-island,.generation-composer,.conversation-composer,.workspace-header')]
              .filter(n=>n.checkVisibility()).map(n=>({ name:n.className, background:getComputedStyle(n).backgroundColor,
                filter:getComputedStyle(n).backdropFilter, transition:getComputedStyle(n).transitionDuration })),
            text: [...document.querySelectorAll('.generation-prompt,.generation-reference-control,.conversation-title,.preview-heading')]
              .filter(n=>n.checkVisibility()).map(n=>({ text:n.textContent, color:getComputedStyle(n).color })) })`)
          if (reduced) expect((measured as { surfaces: { filter: string }[] }).surfaces.every((surface) => surface.filter === 'none')).toBe(true)
          captures.push({ focus, reduced, measured, native: await captureWorkbench(app, test.info().outputPath(`${theme}-${reduced ? 'reduced-150' : 'regular-100'}-${focus}.png`)) })
          if (focus === '生成') await hit(page.locator('.generation-compact-summary'))
        }
      }
      await hit(page.getByRole('button', { name: '供应商设置', exact: true }))
      await hit(settings.getByRole('button', { name: '外观', exact: true }))
      await hit(settings.locator('[data-glass-preview="solid"]'))
      await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'solid')
      captures.push({ settings: true, native: await captureWorkbench(app, test.info().outputPath(`${theme}-settings-small.png`)) })
      await hit(settings.getByRole('button', { name: '关闭供应商设置', exact: true }))
      expect((await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())).scene).toEqual(scene)
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { __materialRequests: number }).__materialRequests)).toBe(0)
      await writeFile(test.info().outputPath('material-facts.json'), JSON.stringify({ theme, userData, captures, scene, actualProviderRequests: 0 }, null, 2))
    } finally { await captureWorkbench(app, test.info().outputPath('last-native.png')); await app.close() }
  })
}
