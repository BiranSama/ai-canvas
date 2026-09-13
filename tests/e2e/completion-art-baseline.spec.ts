import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

// These retained synthetic projects are the before-state for the same-work
// comparison. No model is used to judge or generate artwork in this capture.
for (const fixture of [
  { id: 'cover', brief: '创建一张 4:5 的山海封面，主体是一座远山，标题写“山海之间”，保留大面积留白，先不要生成图片。' },
  { id: 'product', brief: '创建一张 4:5 的香水商品海报，保留瓶身轮廓与标签，标题写“晨雾”，柔和侧光与石质底座，先不要生成图片。' }
]) {
  test(`completion before-state keeps ${fixture.id} across three focuses`, async () => {
    const testInfo = test.info()
    test.setTimeout(60_000)
    const userData = await mkdtemp(join(tmpdir(), `${fixture.id}-`))
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' }
    })
    try {
      await app.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __completionNetworkAttempts: number }
        scope.__completionNetworkAttempts = 0
        scope.fetch = async () => { scope.__completionNetworkAttempts += 1; throw new Error('OFFLINE_BASELINE_NETWORK_BLOCKED') }
      })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.locator('.new-project-main').click()
      await expect(page.getByRole('button', { name: '项目菜单：未命名创作' })).toBeVisible()
      await page.getByRole('button', { name: '对话', exact: true }).click()
      await page.getByRole('textbox', { name: '对话输入' }).fill(fixture.brief)
      await page.getByRole('button', { name: '发送要求' }).click()
      await expect(page.getByTestId('operation-receipt')).toBeVisible({ timeout: 10_000 })
      const before = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      await writeFile(testInfo.outputPath(`${fixture.id}-scene-before.json`), JSON.stringify(before, null, 2))
      await page.getByRole('button', { name: '生成', exact: true }).click()
      await page.getByTestId('generation-prompt').fill(fixture.brief)
      await page.getByTestId('generation-submit').click()
      await expect(page.getByTestId('generation-result')).toHaveCount(1, { timeout: 15_000 })
      const facts: unknown[] = []
      for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
        await page.setViewportSize(size)
        for (const focus of [{ id: 'conversation', label: '对话' }, { id: 'canvas', label: '画布' }, { id: 'generate', label: '生成' }]) {
          await page.getByRole('button', { name: focus.label, exact: true }).click()
          if (focus.id === 'canvas') await expect(page.getByTestId('canvas-stage')).toBeVisible()
          if (focus.id === 'generate') await expect(page.getByTestId('generation-result')).toHaveCount(1)
          // The existing compact conversation deliberately hides its preview.
          // Record that baseline, then exercise its real restore control.
          await page.screenshot({ path: testInfo.outputPath(`${fixture.id}-${focus.id}-${size.width}x${size.height}-before.png`), animations: 'disabled' })
          if (focus.id === 'conversation' && !await page.getByTestId('canvas-stage').isVisible()) {
            await page.getByRole('button', { name: '实时画布', exact: true }).click()
            await expect(page.getByTestId('canvas-stage')).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath(`${fixture.id}-${focus.id}-${size.width}x${size.height}-preview-open-before.png`), animations: 'disabled' })
          }
          facts.push({ size, focus: focus.id, geometry: await page.evaluate(`({ dpr: devicePixelRatio,
            theme: document.documentElement.dataset.appearanceTheme,
            islands: [...document.querySelectorAll('[data-island-id]')].map((node) => ({ id: node.getAttribute('data-island-id'), box: node.getBoundingClientRect().toJSON() })),
            stage: document.querySelector('[data-testid="canvas-stage"]')?.getBoundingClientRect().toJSON()
          })`) })
        }
      }
      const networkAttempts = await app.evaluate(() => (globalThis as typeof globalThis & { __completionNetworkAttempts: number }).__completionNetworkAttempts)
      expect(networkAttempts).toBe(0)
      await writeFile(testInfo.outputPath(`${fixture.id}-capture-facts.json`), JSON.stringify({ fixture, userData, facts, networkAttempts, provider: 'offline mock; not real image quality evidence' }, null, 2))
    } finally { await app.close() }
  })
}
