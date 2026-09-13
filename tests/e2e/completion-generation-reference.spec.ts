import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { DesktopApi } from '../../src/shared/desktop-api'

test.setTimeout(65000)
let app: ElectronApplication
let page: Page
async function launch(userData: string) {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __referenceNetwork: number }
    state.__referenceNetwork = 0
    state.fetch = async () => { state.__referenceNetwork++; throw new Error('OFFLINE_REFERENCE_UI') }
  })
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 })
}
async function bootstrap() { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()) }
async function jobs() { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()) }
async function network() { expect(await app.evaluate(() => (globalThis as typeof globalThis & { __referenceNetwork: number }).__referenceNetwork)).toBe(0) }
test.afterEach(async () => { if (app?.windows().length) { await network(); await app.close() } })

test('reviews the real canvas before submission and continues only the selected image result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ref-ui-'))
  await launch(root); await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '形状', exact: true }).click()
  const initial = await bootstrap()
  await page.getByRole('button', { name: '生成画布', exact: true }).click()
  const reference = page.getByTestId('generation-reference-control')
  await expect(reference).toContainText(`版本 ${initial.scene.revision}`)
  await expect(reference.getByRole('img', { name: '本次参考预览 1' })).toBeVisible()
  expect(await jobs()).toHaveLength(0)
  await reference.getByRole('radio', { name: '结构参考', exact: true }).click()
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(1)
  const first = (await jobs())[0]!
  expect(first.request.references).toHaveLength(0)
  expect(first.request.parameters.promptIr).toMatchObject({ sceneId: initial.scene.id, sceneRevision: initial.scene.revision })
  await page.getByRole('button', { name: '继续变化', exact: true }).click()
  await expect(reference.getByRole('radio', { name: '画面参考', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(reference.getByRole('radio', { name: '结构参考', exact: true })).toHaveCount(0)
  await expect(reference.getByRole('radio', { name: '同时参考', exact: true })).toHaveCount(0)
  await page.getByLabel('本次变化', { exact: true }).fill('将侧光变得柔和')
  await page.getByLabel('保持不变', { exact: true }).fill('保留主体形状和位置')
  await page.getByLabel('保持不变', { exact: true }).blur()
  await page.screenshot({ path: test.info().outputPath('chosen-result-reference.png') })
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(2)
  const all = await jobs()
  const derived = all.find((entry) => entry.request.parentResultId !== null)!
  expect(derived.request.references.map((entry) => entry.assetId)).toEqual([first.results[0]!.assetId])
  expect(derived.request.referenceMode).toBe('visual')
  expect(derived.request.parameters.promptPackage).toBeUndefined()
  await writeFile(test.info().outputPath('reference-main-requests.json'), JSON.stringify({ initial, jobs: all, actualProviderRequests: 0 }, null, 2))
})

test('keeps a changed canvas reference stale until refreshed and persists a deliberate text-only choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stale-ref-ui-'))
  await launch(root); await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const reference = page.getByTestId('generation-reference-control')
  await expect(reference).toContainText('仅使用文字要求')
  await expect(reference.getByRole('radio')).toHaveCount(0)
  await page.getByTestId('generation-prompt').fill('合成参考测试作品')
  await reference.getByRole('button', { name: '当前画布', exact: true }).click()
  const before = await bootstrap()
  await expect(reference).toContainText(`版本 ${before.scene.revision}`)
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await page.getByRole('button', { name: '形状', exact: true }).click()
  await expect.poll(async () => (await bootstrap()).scene.revision).toBeGreaterThan(before.scene.revision)
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await expect(reference).toContainText('画布已修改')
  await expect(page.getByTestId('generation-submit')).toBeDisabled()
  await reference.getByRole('button', { name: '刷新参考预览', exact: true }).click()
  await expect(reference).toContainText(`版本 ${(await bootstrap()).scene.revision}`)
  await expect(page.getByTestId('generation-submit')).toBeEnabled()
  await reference.getByRole('button', { name: '仅文字', exact: true }).click()
  await expect(reference).toContainText('不附带画布或图片')
  await network(); await app.close()
  await launch(root)
  await page.locator(`[data-project-id="${before.projectId}"]`).getByRole('button').first().click()
  await expect(page.getByTestId('generation-reference-control')).toContainText('仅使用文字要求')
  await expect(page.getByTestId('generation-prompt')).toHaveValue('合成参考测试作品')
  expect(await jobs()).toHaveLength(0)
  await page.screenshot({ path: test.info().outputPath('text-reference-restored.png') })
})

test('imports exactly the selected reference image without placing it on the canvas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-ref-ui-'))
  const file = join(root, 'chosen.png')
  await sharp({ create: { width: 180, height: 240, channels: 4, background: '#b8bfaa' } }).png().toFile(file)
  await launch(join(root, 'userData')); await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const before = await bootstrap()
  const reference = page.getByTestId('generation-reference-control')
  const chooser = page.waitForEvent('filechooser')
  await reference.getByRole('button', { name: '指定图片', exact: true }).click()
  await (await chooser).setFiles(file)
  await expect(reference).toContainText('1 张指定图片')
  await expect(reference.getByRole('radio')).toHaveCount(1)
  await page.getByTestId('generation-prompt').fill('使用这张参考图探索柔和晨光')
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(1)
  expect((await jobs())[0]!.request.references).toHaveLength(1)
  expect((await bootstrap()).scene).toEqual(before.scene)
})
