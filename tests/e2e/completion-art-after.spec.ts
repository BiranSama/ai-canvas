import { _electron as electron, expect, test } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

// Opt-in evidence capture opens copies of the retained synthetic before works.
// It never opens or upgrades the source snapshot in place.
const baseline = process.env.AI_CANVAS_ART_BASELINE
for (const fixture of [
  { id: 'cover', folder: 'completion-art-baseline-co-7eea5--cover-across-three-focuses' },
  { id: 'product', folder: 'completion-art-baseline-co-65a2e-roduct-across-three-focuses' }
]) {
  test(`same-work after layout: ${fixture.id}`, async () => {
    test.skip(baseline === undefined, 'Set AI_CANVAS_ART_BASELINE to a retained synthetic before batch.')
    const info = test.info()
    const original = JSON.parse(await readFile(join(baseline!, fixture.folder, `${fixture.id}-capture-facts.json`), 'utf8')) as { userData: string }
    expect(resolve(original.userData).startsWith(resolve('test-results') + '\\')).toBe(true)
    const userData = await mkdtemp(join(tmpdir(), `after-${fixture.id}-`))
    const index = JSON.parse(await readFile(join(original.userData, 'state', 'recent-projects.json'), 'utf8')) as { version: number; projects: { path: string }[] }
    for (const project of index.projects) {
      const target = join(userData, 'projects', basename(project.path))
      await cp(project.path, target, { recursive: true, errorOnExist: true, force: false })
      project.path = target
    }
    await mkdir(join(userData, 'state'), { recursive: true })
    await writeFile(join(userData, 'state', 'recent-projects.json'), JSON.stringify(index))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'),
      env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'workspace' } })
    try {
      await app.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __captureNetwork: number }
        scope.__captureNetwork = 0
        scope.fetch = async () => { scope.__captureNetwork++; throw new Error('OFFLINE_CAPTURE_NETWORK_BLOCKED') }
      })
      const page = await app.firstWindow()
      await page.getByRole('button', { name: '打开项目：未命名创作', exact: true }).click()
      await expect(page.getByRole('button', { name: '对话', exact: true })).toBeVisible()
      const scene = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
      const before = JSON.parse(await readFile(join(baseline!, fixture.folder, `${fixture.id}-scene-before.json`), 'utf8')) as { scene: unknown }
      expect(scene.scene).toEqual(before.scene)
      const facts: unknown[] = []
      for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
        await page.setViewportSize(size)
        for (const focus of [{ id: 'conversation', label: '对话' }, { id: 'canvas', label: '画布' }, { id: 'generate', label: '生成' }]) {
          await page.getByRole('button', { name: focus.label, exact: true }).click()
          if (focus.id !== 'generate') await expect(page.getByTestId('canvas-stage')).toBeVisible()
          else await expect(page.getByTestId('generation-result')).toHaveCount(1)
          await page.screenshot({ path: info.outputPath(`${fixture.id}-${focus.id}-${size.width}x${size.height}-after.png`), animations: 'disabled' })
          facts.push({ size, focus: focus.id, geometry: await page.evaluate(`({ dpr: devicePixelRatio,
            stage: document.querySelector('[data-testid="canvas-stage"]')?.getBoundingClientRect().toJSON(),
            result: document.querySelector('[data-testid="generation-result"]')?.getBoundingClientRect().toJSON(),
            controls: [...document.querySelectorAll('button')].filter(n => n.checkVisibility()).map(n => ({name:n.getAttribute('aria-label') || n.textContent, box:n.getBoundingClientRect().toJSON()})) })`) })
        }
      }
      const network = await app.evaluate(() => (globalThis as typeof globalThis & { __captureNetwork: number }).__captureNetwork)
      expect(network).toBe(0)
      await writeFile(info.outputPath(`${fixture.id}-after-facts.json`), JSON.stringify({ userData, originalUserData: original.userData, facts, network, sceneUnchanged: true }, null, 2))
    } finally { await app.close() }
  })
}
