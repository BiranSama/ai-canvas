import { openGenerationOptions } from '../helpers/workbench-ui'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import Database from 'better-sqlite3'

test.setTimeout(65_000)
let app: ElectronApplication
let page: Page
async function launch(userData: string) {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  await app.evaluate(() => { const state = globalThis as typeof globalThis & { __contextNetwork: number }; state.__contextNetwork = 0; state.fetch = async () => { state.__contextNetwork++; throw new Error('OFFLINE_CONTEXT_NETWORK_BLOCKED') } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  return app
}
async function bootstrap() { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()) }
async function noNetwork() { expect(await app.evaluate(() => (globalThis as typeof globalThis & { __contextNetwork: number }).__contextNetwork)).toBe(0) }
async function projectDatabase(userData: string, projectId: string): Promise<string> {
  for (const entry of await readdir(join(userData, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.aicanvas')) continue
    const path = join(userData, 'projects', entry.name, 'project.db')
    const db = new Database(path, { readonly: true })
    const matches = (db.prepare('SELECT id FROM projects').get() as { id: string }).id === projectId
    db.close()
    if (matches) return path
  }
  throw new Error('Synthetic project database not found')
}
test.afterEach(async () => { if (app !== undefined && app.windows().length > 0) { await noNetwork(); await app.close() } })

test('shows unknown and verified zero honestly, deduplicates task fees and restores them from Main', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'cost-ui-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const id = (await bootstrap()).projectId
  for (let index = 0; index < 3; index++) {
    if (index > 0) await page.getByRole('button', { name: /展开参数/ }).click()
    await page.getByTestId('generation-prompt').fill(`费用语义合成作品 ${index + 1}`)
    await openGenerationOptions(page)
    await page.getByLabel('生成数量').selectOption(index === 2 ? '2' : '1')
    await page.getByTestId('generation-submit').click()
    await expect(page.getByTestId('generation-result')).toHaveCount(index === 2 ? 4 : index + 1)
  }
  const jobs = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
  await noNetwork(); await app.close()
  const db = new Database(await projectDatabase(userData, id))
  const actual = (amount: number) => JSON.stringify({ version: 1, estimate: null,
    actual: { status: 'actual_known', amount, currency: 'CNY', source: 'provider_receipt',
      evidence: { receiptId: `fake-ui-${amount}`, observedAt: new Date().toISOString() } } })
  db.prepare('UPDATE generation_jobs SET cost_json = ? WHERE id = ?').run(actual(1.5), jobs[0]!.id)
  db.prepare('UPDATE generation_jobs SET cost_json = ? WHERE id = ?').run(actual(0), jobs[1]!.id)
  db.prepare('UPDATE generation_jobs SET cost_json = NULL WHERE id = ?').run(jobs[2]!.id)
  db.close()
  await launch(userData)
  await page.locator(`[data-project-id="${id}"]`).getByRole('button').first().click()
  await expect(page.getByTestId('generation-cost-summary')).toHaveText('已知实际 ¥1.50 · 1 笔费用未知')
  const resultIds = jobs.flatMap((job) => job.results.map((result) => result.id))
  const pick = async (resultId: string) => {
    const index = resultIds.indexOf(resultId)
    expect(index).toBeGreaterThanOrEqual(0)
    await page.getByTestId('generation-result').nth(index).click()
  }
  // Family rows are real UI; the synthetic SQL above is only fixture setup.
  await pick(jobs[2]!.results[0]!.id)
  await page.getByRole('button', { name: '结果家族', exact: false }).click()
  await expect(page.locator('.result-provenance')).toContainText('费用未知')
  await expect(page.locator('.result-provenance')).not.toContainText('实际回执 · ¥0.00')
  await pick(jobs[1]!.results[0]!.id)
  await expect(page.locator('.result-provenance')).toContainText('实际回执 · ¥0.00')
  await pick(jobs[0]!.results[1]!.id)
  await expect(page.locator('.result-provenance')).toContainText('实际回执 · ¥1.50')
  await page.screenshot({ path: test.info().outputPath('cost-known-and-unknown.png') })
  const persisted = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
  await writeFile(test.info().outputPath('cost-main-facts.json'), JSON.stringify({ jobs: persisted, network: 0, syntheticReceipt: true }, null, 2))
  await page.getByRole('button', { name: '供应商设置', exact: true }).click()
  await expect(page.getByLabel('每任务预约额度')).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Provider 执行边界' })).toContainText('价格未知时，预约不保证实际人民币扣费上限')
  await page.getByRole('button', { name: '关闭供应商设置', exact: true }).click()
})

test('A/B versions, unsent drafts and current view survive three focuses, project library switches and restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'context-ui-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await page.getByTestId('generation-prompt').fill('A 山海之间，远山与留白')
  await openGenerationOptions(page)
  await page.getByLabel('生成数量').selectOption('3')
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(3)
  const jobsA = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
  const ids = jobsA.flatMap((job) => job.results.map((result) => result.id))
  await page.getByTestId('generation-result').nth(1).click()
  await page.getByRole('button', { name: '比较', exact: true }).click()
  await page.getByLabel('比较版本 A').selectOption(ids[1]!)
  await page.getByLabel('比较版本 B').selectOption(ids[2]!)
  await page.getByRole('button', { name: '操作 B', exact: true }).click()
  await page.getByRole('button', { name: '结果家族', exact: false }).click()
  const selected = await bootstrap()
  await expect.poll(async () => (await bootstrap()).workContext?.generation.compareBId).toBe(ids[2])
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await page.getByLabel('对话输入').fill('A 下一轮只调整光线，尚未发送')
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByLabel('创作输入')).toHaveValue('A 下一轮只调整光线，尚未发送')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByLabel('比较版本 A')).toHaveValue(ids[1]!)
  await expect(page.getByLabel('比较版本 B')).toHaveValue(ids[2]!)
  await expect(page.getByRole('button', { name: '操作 B', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: test.info().outputPath('A-compare-before-switch.png') })
  await page.getByRole('button', { name: '返回项目库', exact: true }).click()
  await page.locator('.new-project-main').click()
  await expect.poll(async () => (await bootstrap()).projectId).not.toBe(selected.projectId)
  const b = await bootstrap()
  expect(b.projectId).not.toBe(selected.projectId)
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByTestId('generation-prompt')).toHaveValue('')
  await expect(page.getByLabel('生成数量')).toHaveValue('1')
  await expect(page.locator('.result-focus img')).toHaveCount(0)
  await expect(page.getByTestId('insert-generation-result')).toHaveCount(0)
  await page.getByTestId('generation-prompt').fill('B 自己的草稿')
  await page.getByRole('button', { name: '返回项目库', exact: true }).click()
  // Reopen through the project card so the production hydrator consumes Main's context.
  await page.locator(`[data-project-id="${selected.projectId}"]`).getByRole('button').first().click()
  await expect(page.getByLabel('比较版本 B')).toHaveValue(ids[2]!)
  await expect.poll(async () => (await bootstrap()).workContext?.conversationDraft).toBe('A 下一轮只调整光线，尚未发送')
  const beforeRestart = await bootstrap()
  await noNetwork()
  await app.close()
  await launch(userData)
  await page.locator(`[data-project-id="${selected.projectId}"]`).getByRole('button').first().click()
  await expect(page.getByLabel('比较版本 A')).toHaveValue(ids[1]!)
  await expect(page.getByLabel('比较版本 B')).toHaveValue(ids[2]!)
  await page.screenshot({ path: test.info().outputPath('A-compare-after-restart.png') })
  const afterRestart = await bootstrap()
  expect(afterRestart.scene).toEqual(beforeRestart.scene)
  expect(afterRestart.workContext?.generation).toMatchObject({ prompt: 'A 山海之间，远山与留白', quantity: 3, compareEnabled: true, compareAId: ids[1], compareBId: ids[2], compareActiveSide: 'B' })
  await writeFile(test.info().outputPath('context-main-facts.json'), JSON.stringify({ userData, ids, a: selected.projectId, b: b.projectId, beforeRestart, afterRestart, network: 0 }, null, 2))
})

for (const closeMode of ['window', 'app'] as const) test(`saves the final unblurred text before ${closeMode} close`, async () => {
  const userData = await mkdtemp(join(tmpdir(), `context-${closeMode}-`))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '对话', exact: true }).click()
  const id = (await bootstrap()).projectId
  await page.getByLabel('对话输入').fill(`最后一个字：${closeMode}，退出前未离开输入框`)
  await noNetwork()
  const exited = app.waitForEvent('close')
  if (closeMode === 'window') await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close() })
  else await app.evaluate(({ app: nativeApp }) => { nativeApp.quit() })
  await exited
  await launch(userData)
  await page.locator(`[data-project-id="${id}"]`).getByRole('button').first().click()
  await expect(page.getByLabel('对话输入')).toHaveValue(`最后一个字：${closeMode}，退出前未离开输入框`)
})

test('save-as makes an independent project and keeps its restored Generate controls editable', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'context-copy-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await page.getByTestId('generation-prompt').fill('副本之前的未发送要求')
  await openGenerationOptions(page)
  await page.getByLabel('生成数量').selectOption('2')
  const a = await bootstrap()
  const destination = join(userData, 'projects', '独立副本.aicanvas')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, destination)
  await page.getByRole('button', { name: '项目菜单：未命名创作', exact: true }).click()
  await page.getByRole('menuitem', { name: '另存为', exact: true }).click()
  await expect.poll(async () => (await bootstrap()).projectId).not.toBe(a.projectId)
  await expect(page.getByRole('button', { name: '项目菜单：独立副本', exact: true })).toBeVisible()
  await expect(page.getByTestId('generation-prompt')).toHaveValue('副本之前的未发送要求')
  await page.getByTestId('generation-prompt').fill('副本自己的新要求')
  await openGenerationOptions(page)
  await page.getByLabel('生成数量').selectOption('1')
  await expect.poll(async () => (await bootstrap()).workContext?.generation.prompt).toBe('副本自己的新要求')
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(1)
  const b = await bootstrap()
  await page.getByRole('button', { name: '返回项目库', exact: true }).click()
  await expect(page.locator(`[data-project-id="${a.projectId}"]`)).toBeVisible()
  await expect(page.locator(`[data-project-id="${b.projectId}"]`)).toBeVisible()
  await page.locator(`[data-project-id="${a.projectId}"] .project-card-open`).click()
  await expect(page.getByTestId('generation-prompt')).toHaveValue('副本之前的未发送要求')
  await expect(page.getByLabel('生成数量')).toHaveValue('2')
  await expect(page.getByTestId('generation-result')).toHaveCount(0)
  await writeFile(test.info().outputPath('save-as-main-facts.json'), JSON.stringify({ a, b, sourceReopened: await bootstrap(), network: 0 }, null, 2))
})

for (const revisitA of [false, true]) test(`rejects a delayed file read after A to B${revisitA ? ' to A' : ''}`, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'context-import-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '画布', exact: true }).click()
  const a = await bootstrap()
  await page.evaluate(() => {
    const browser = globalThis as unknown as { File: { prototype: { arrayBuffer: () => Promise<ArrayBuffer> } }; __releaseRead: () => void; __readFinished: boolean }
    const original = browser.File.prototype.arrayBuffer
    browser.__readFinished = false
    browser.File.prototype.arrayBuffer = async function () {
      browser.File.prototype.arrayBuffer = original
      await new Promise<void>((resolve) => { browser.__releaseRead = resolve })
      const bytes = await original.call(this)
      browser.__readFinished = true
      return bytes
    }
  })
  await page.locator('.canvas-view > input[type="file"]').last().setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') })
  await page.getByRole('button', { name: '返回项目库', exact: true }).click()
  await page.locator('.new-project-main').click()
  await expect.poll(async () => (await bootstrap()).projectId).not.toBe(a.projectId)
  const b = await bootstrap()
  if (revisitA) {
    await page.getByRole('button', { name: '返回项目库', exact: true }).click()
    await page.locator(`[data-project-id="${a.projectId}"] .project-card-open`).click()
    await expect.poll(async () => (await bootstrap()).projectId).toBe(a.projectId)
  }
  await page.evaluate(() => (globalThis as unknown as { __releaseRead: () => void }).__releaseRead())
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __readFinished: boolean }).__readFinished)).toBe(true)
  expect((await bootstrap()).scene.elements).toHaveLength(0)
  for (const id of [a.projectId, b.projectId]) {
    const db = new Database(await projectDatabase(userData, id), { readonly: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({ count: 0 }); db.close()
  }
})

test('a refused close save leaves the window and Main available, then a user retry saves and closes', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'context-refusal-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '对话', exact: true }).click()
  const a = await bootstrap()
  const db = new Database(await projectDatabase(userData, a.projectId))
  db.exec("CREATE TRIGGER synthetic_context_denied BEFORE INSERT ON project_work_context BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_CONTEXT_SAVE_DENIED'); END;")
  await page.getByLabel('对话输入').fill('保存失败后仍保留这段文字')
  await app.evaluate(({ app: nativeApp }) => { nativeApp.quit() })
  await expect(page.getByRole('alert')).toContainText('工作状态未保存')
  expect(app.windows()).toHaveLength(1)
  expect((await bootstrap()).projectId).toBe(a.projectId)
  await expect(page.getByLabel('对话输入')).toHaveValue('保存失败后仍保留这段文字')
  db.exec('DROP TRIGGER synthetic_context_denied'); db.close()
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await bootstrap()).workContext?.conversationDraft).toBe('保存失败后仍保留这段文字')
  await noNetwork()
  await app.close()
})

test('clears unavailable comparison references and actionable previews while keeping the written request', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'context-missing-'))
  await launch(userData)
  await page.locator('.new-project-main').click()
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await page.getByTestId('generation-prompt').fill('结果移除后仍保留这条画面要求')
  await openGenerationOptions(page)
  await page.getByLabel('生成数量').selectOption('2')
  await page.getByTestId('generation-submit').click()
  await expect(page.getByTestId('generation-result')).toHaveCount(2)
  await page.getByRole('button', { name: '比较', exact: true }).click()
  const a = await bootstrap()
  const jobs = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
  const results = jobs.flatMap((job) => job.results)
  const databasePath = await projectDatabase(userData, a.projectId)
  const db = new Database(databasePath)
  db.pragma('foreign_keys = ON')
  const row = db.prepare('SELECT relative_path FROM assets WHERE id = ?').get(results[0]!.assetId) as { relative_path: string }
  const filePath = resolve(dirname(databasePath), row.relative_path)
  expect(relative(dirname(databasePath), filePath)).not.toMatch(/^\.\./)
  await unlink(filePath)
  await page.evaluate(async (assetId) => { try { await (globalThis as unknown as { desktop: DesktopApi }).desktop.readGenerationAsset(assetId, false) } catch { /* actual missing-file boundary */ } }, results[0]!.assetId)
  await expect(page.getByTestId('generation-result')).toHaveCount(1)
  await expect(page.getByLabel('比较版本 B')).toHaveCount(0)
  await expect(page.getByTestId('generation-status')).toContainText('不可用')
  db.prepare('DELETE FROM generation_results WHERE id = ?').run(results[1]!.id); db.close()
  await expect(page.getByTestId('generation-result')).toHaveCount(0)
  await expect(page.locator('.result-focus img')).toHaveCount(0)
  await expect(page.getByTestId('insert-generation-result')).toHaveCount(0)
  await expect(page.getByTestId('generation-prompt')).toHaveValue('结果移除后仍保留这条画面要求')
  await expect.poll(async () => (await bootstrap()).workContext?.generation.compareEnabled).toBe(false)
})
