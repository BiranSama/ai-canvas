import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import sharp from 'sharp'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { GenerationWorkContext } from '../../src/shared/project-work-context'
import { captureWorkbench, hitWorkbenchControl as hit } from '../helpers/workbench-ui'

interface Work { kind: 'cover' | 'product' | 'copy'; name: string; projectId: string; projectPath: string; userData: string; titleId: string; imageId: string; compare: GenerationWorkContext }
interface Manifest { userData: string; works: Work[] }
const manifestPath = process.env.AI_CANVAS_AGGREGATE_WORKS
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function bootstrap(page: Page) { return page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()) }
async function openWork(page: Page, id: string) {
  const home = page.getByRole('button', { name: '返回项目库', exact: true })
  if (!await home.isVisible() && await page.locator('.project-menu-trigger').isVisible()) await hit(page.locator('.project-menu-trigger'))
  if (await home.isVisible()) await hit(home)
  await hit(page.locator(`[data-project-id="${id}"]`).getByRole('button', { name: /^打开项目：/ }))
  await expect.poll(async () => (await bootstrap(page)).projectId).toBe(id)
}
async function downloadCount(app: ElectronApplication) { return app.evaluate(() => (globalThis as typeof globalThis & { __workDownloads: unknown[] }).__workDownloads.length) }
async function exportCanvas(app: ElectronApplication, page: Page) {
  const before = await downloadCount(app)
  await hit(page.getByRole('button', { name: '导出', exact: true }))
  await expect.poll(() => downloadCount(app)).toBe(before + 1)
  return app.evaluate(() => (globalThis as typeof globalThis & { __workDownloads: { path: string; name: string; state: string }[] }).__workDownloads.at(-1)!)
}
async function setUpMain(app: ElectronApplication, outputDir: string, image: string) {
  await app.evaluate(({ session, ipcMain }, { outputDir, image }) => {
    const scope = globalThis as typeof globalThis & { __workDownloads: { path: string; name: string; state: string }[]; __workCalls: { url: string; fields: Record<string, string>; mask: string | null }[] }
    scope.__workDownloads = []; scope.__workCalls = []
    const edits: unknown[] = []
    ;(globalThis as typeof globalThis & { __editCalls: unknown[] }).__editCalls = edits
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const execute = handlers.get('scene:execute')!
    ipcMain.removeHandler('scene:execute')
    ipcMain.handle('scene:execute', async (...args: unknown[]) => { const result = await execute(...args); edits.push({ input: args[1], result }); return result })
    let downloadIndex = 0
    session.defaultSession.on('will-download', (_event, item) => {
      const name = item.getFilename().replace(/[<>:"/\\|?*]/g, '_')
      const file = `${outputDir}/${++downloadIndex}-${name}`
      item.setSavePath(file)
      item.once('done', (_event, state) => scope.__workDownloads.push({ path: file, name, state }))
    })
    scope.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith('https://completion.example.test/v1/images/')) throw new Error('AGGREGATE_UI_OFFLINE_NETWORK_DENIED')
      const fields: Record<string, string> = {}; let mask: string | null = null
      if (init?.body instanceof FormData) for (const [field, value] of init.body.entries()) {
        if (typeof value === 'string') fields[field] = value
        else if (field === 'mask') mask = Buffer.from(await value.arrayBuffer()).toString('base64')
      }
      else Object.assign(fields, JSON.parse(String(init?.body)))
      scope.__workCalls.push({ url: String(url), fields, mask })
      return Response.json({ data: Array.from({ length: Number(fields.n ?? 1) }, () => ({ b64_json: image })) })
    }
  }, { outputDir, image })
}

for (const kind of ['cover', 'product', 'copy'] as const) test(`complete ${kind} artwork through real Chinese editing, A/B, mask, export and restart`, async () => {
  test.skip(manifestPath === undefined, 'Provide AI_CANVAS_AGGREGATE_WORKS from the current real-Main aggregate batch.')
  test.setTimeout(150_000)
  const manifest = JSON.parse(await readFile(manifestPath!, 'utf8')) as Manifest
  const work = manifest.works.find((item) => item.kind === kind)!
  const other = manifest.works.find((item) => item.kind !== kind)!
  const userData = await mkdtemp(join(tmpdir(), `complete-${kind}-`))
  const index = JSON.parse(await readFile(join(manifest.userData, 'state', 'recent-projects.json'), 'utf8')) as { projects: { id: string; path: string }[] }
  for (const project of index.projects) {
    const path = join(userData, 'projects', basename(project.path))
    expect(resolve(project.path).startsWith(resolve('test-results') + '\\')).toBe(true)
    await cp(project.path, path, { recursive: true, force: false, errorOnExist: true })
    project.path = path
  }
  await mkdir(join(userData, 'state'), { recursive: true })
  await writeFile(join(userData, 'state', 'recent-projects.json'), JSON.stringify(index))
  const open = () => electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: 'r2', AI_CANVAS_STARTUP: 'library' } })
  let app = await open()
  let page = await app.firstWindow()
  const providerOutput = await readFile(join(resolve(manifestPath!, '..'), kind === 'product' ? 'product-current-main.png' : 'cover-source.png'))
  try {
    await setUpMain(app, test.info().outputDir, providerOutput.toString('base64'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.bringToFront()
    await openWork(page, work.projectId)
    await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      await api.setProviderConfig({ id: 'image-provider', kind: 'image', label: 'Offline acceptance fixture', baseUrl: 'https://completion.example.test/v1', defaultModel: 'completion-image-fixture',
        protocol: 'openai-images', timeoutMs: 45_000, concurrency: 1, capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } })
      await api.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-electron-only-no-real-key' })
      await api.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 8, maxImagesPerJob: 4, maxCostCnyPerJob: 10 })
    })
    const start = await bootstrap(page)
    const startingJobCount = (await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())).length
    const originalCompare = start.workContext!.generation
    await hit(page.getByRole('button', { name: '生成', exact: true }))
    await expect(page.locator('.result-focus')).toHaveAttribute('data-result-a', originalCompare.compareAId!)
    await expect(page.locator('.result-focus')).toHaveAttribute('data-result-b', originalCompare.compareBId!)
    await hit(page.getByRole('button', { name: '操作 A', exact: true }))
    await hit(page.getByRole('button', { name: '交换 A/B', exact: true }))
    await hit(page.getByRole('button', { name: '交换 A/B', exact: true }))
    await hit(page.getByRole('button', { name: '操作 B', exact: true }))
    await captureWorkbench(app, test.info().outputPath('01-same-work-compare.png'))
    await hit(page.getByRole('button', { name: '画布', exact: true }))
    await hit(page.getByRole('tab', { name: '图层', exact: true }))
    await page.locator(`[data-layer-id="${work.titleId}"] .layer-copy`).click()
    await expect(page.locator(`[data-layer-id="${work.titleId}"]`)).toHaveAttribute('aria-selected', 'true')
    await hit(page.getByRole('button', { name: '锁定准确主标题', exact: true }))
    await hit(page.getByRole('tab', { name: '属性', exact: true }))
    await expect(page.getByLabel('文字内容', { exact: true })).toBeDisabled()
    await hit(page.getByRole('tab', { name: '图层', exact: true }))
    await hit(page.getByRole('button', { name: '解锁准确主标题', exact: true }))
    await hit(page.getByRole('tab', { name: '属性', exact: true }))
    const title = kind === 'product' ? '晨雾' : '山海之间'
    await page.evaluate(`(() => {
      const events = []
      globalThis.__editEvents = events
      for (const type of ['focusin', 'focusout', 'input', 'change', 'compositionstart', 'compositionend']) document.addEventListener(type, (event) => {
        const target = event.target
        events.push({ type, label: target.getAttribute('aria-label'), value: target.value, active: document.activeElement?.getAttribute('aria-label') })
      }, true)
    })()`)
    await hit(page.getByLabel('文字内容', { exact: true }))
    await page.getByLabel('文字内容', { exact: true }).fill(`${title} · 新版`)
    await page.getByLabel('文字内容', { exact: true }).blur()
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'text').find((element) => element.id === work.titleId)?.content).toBe(`${title} · 新版`)
    await hit(page.getByRole('button', { name: '撤销', exact: true }))
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'text').find((element) => element.id === work.titleId)?.content).toBe(title)
    await hit(page.getByRole('button', { name: '高级', exact: true }))
    await page.getByLabel('字重', { exact: true }).selectOption('300')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'text').find((element) => element.id === work.titleId)?.fontWeight).toBe(300)
    const lightExport = await exportCanvas(app, page)
    await page.getByLabel('字重', { exact: true }).selectOption('700')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'text').find((element) => element.id === work.titleId)?.fontWeight).toBe(700)
    const boldExport = await exportCanvas(app, page)
    expect(digest(await readFile(lightExport.path))).not.toBe(digest(await readFile(boldExport.path)))
    await page.getByLabel('字重', { exact: true }).selectOption('500')
    await hit(page.getByRole('button', { name: '简易', exact: true }))
    await captureWorkbench(app, test.info().outputPath('02-same-work-editable-canvas.png'))

    await hit(page.getByRole('button', { name: '对话', exact: true }))
    await page.getByLabel('对话输入', { exact: true }).fill(`只属于${kind}的后续要求：保留准确中文和主体。`)
    await captureWorkbench(app, test.info().outputPath('03-same-work-conversation.png'))
    await hit(page.getByRole('button', { name: '生成', exact: true }))
    await hit(page.locator('.generation-compact-summary'))
    await page.getByTestId('generation-prompt').fill(`只属于${kind}的生成草稿，保留标题与主体。`)
    await hit(page.locator('.generation-compact-summary'))
    await expect.poll(async () => (await bootstrap(page)).workContext!.generation.prompt).toBe(`只属于${kind}的生成草稿，保留标题与主体。`)
    const saved = (await bootstrap(page)).workContext!

    // Delay a real old-project reference response at the IPC boundary. Switching
    // through the real library must not let that response repaint the new project.
    await app.evaluate(({ ipcMain }) => {
      const scope = globalThis as typeof globalThis & { __lateReference?: () => void }
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get('generation:reference-preview')!
      ipcMain.removeHandler('generation:reference-preview')
      ipcMain.handle('generation:reference-preview', async (...args: unknown[]) => {
        ipcMain.removeHandler('generation:reference-preview')
        ipcMain.handle('generation:reference-preview', original)
        const result = await original(...args)
        await new Promise<void>((release) => { scope.__lateReference = release })
        return result
      })
    })
    await hit(page.locator('.generation-compact-summary'))
    await hit(page.getByRole('button', { name: '当前画布', exact: true }))
    await expect.poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { __lateReference?: () => void }).__lateReference)).toBe('function')
    await openWork(page, other.projectId)
    const otherState = await bootstrap(page)
    expect(otherState.scene.projectId).toBe(other.projectId)
    await app.evaluate(() => (globalThis as typeof globalThis & { __lateReference?: () => void }).__lateReference?.())
    await expect.poll(async () => (await bootstrap(page)).workContext!.generation.prompt).toBe(otherState.workContext!.generation.prompt)
    expect((await bootstrap(page)).scene).toEqual(otherState.scene)
    await openWork(page, work.projectId)
    await expect(page.locator('.result-focus')).toHaveAttribute('data-result-b', saved.generation.compareBId!)
    await expect.poll(async () => (await bootstrap(page)).workContext!.conversationDraft).toBe(saved.conversationDraft)

    await hit(page.getByRole('button', { name: '画布', exact: true }))
    await hit(page.getByRole('tab', { name: '图层', exact: true }))
    await page.locator(`[data-layer-id="${work.imageId}"] .layer-copy`).click()
    await hit(page.getByRole('button', { name: '蒙版', exact: true }))
    const stage = page.getByTestId('canvas-stage')
    await page.screenshot({ path: test.info().outputPath('04-before-real-mask.png') })
    const geometry = await stage.evaluate((node) => {
      const rect = node.querySelector('.konvajs-content')!.getBoundingClientRect()
      return { x: rect.x + Number(node.getAttribute('data-artboard-x')), y: rect.y + Number(node.getAttribute('data-artboard-y')), width: Number(node.getAttribute('data-artboard-width')), height: Number(node.getAttribute('data-artboard-height')) }
    })
    const points = [[.1, .47], [.28, .47], [.28, .70], [.1, .70], [.1, .47]].map(([x, y]) => ({ x: geometry.x + x! * geometry.width, y: geometry.y + y! * geometry.height }))
    await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down()
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 3 })
    await page.mouse.up()
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'mask').length).toBe(1)
    await page.getByLabel('创作输入', { exact: true }).fill('只调整左侧环境光线，主体和准确文字保持不变。')
    await hit(page.getByTestId('local-edit-submit'))
    await expect.poll(() => page.evaluate(async (count) => {
      const jobs = await (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()
      return jobs.length === count + 1 && jobs[0]?.status === 'completed'
    }, startingJobCount), { timeout: 15000 }).toBe(true)
    const jobs = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs())
    const edited = jobs[0]!
    expect(edited.request).toMatchObject({ kind: 'edit', parameters: { targetElementId: work.imageId } })
    const calls = await app.evaluate(() => (globalThis as typeof globalThis & { __workCalls: { mask: string | null }[] }).__workCalls)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mask).not.toBeNull()
    expect(await sharp(Buffer.from(calls[0]!.mask!, 'base64')).metadata()).toMatchObject({ width: 1200, height: 1500, hasAlpha: true })
    await hit(page.getByRole('button', { name: '生成', exact: true }))
    await expect(page.locator('.result-focus')).toBeVisible()
    await page.getByLabel('比较版本 B', { exact: true }).selectOption(edited.results[0]!.id)
    await expect(page.getByRole('button', { name: '操作 B', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.result-focus')).toHaveAttribute('data-result-b', edited.results[0]!.id)
    const sceneBeforePlace = (await bootstrap(page)).scene
    await hit(page.getByTestId('insert-generation-result'))
    await expect.poll(async () => (await bootstrap(page)).scene.elements.some((element) => element.type === 'image' && element.assetId === edited.results[0]!.assetId)).toBe(true)
    // The final poster keeps the explicitly chosen earlier visual; the new local
    // result remains a reversible branch and is also exported by its own action.
    await hit(page.getByRole('button', { name: '撤销', exact: true }))
    await expect.poll(async () => (await bootstrap(page)).scene.elements).toEqual(sceneBeforePlace.elements)
    const withMask = await bootstrap(page)
    const mask = withMask.scene.elements.find((element) => element.type === 'mask')!
    await hit(page.getByRole('button', { name: '选择 V', exact: true }))
    await hit(page.getByRole('tab', { name: '图层', exact: true }))
    await page.locator(`[data-layer-id="${mask.id}"] .layer-copy`).click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await bootstrap(page)).scene.elements.filter((element) => element.type === 'mask').length).toBe(0)
    const finalScene = (await bootstrap(page)).scene
    const finalExport = await exportCanvas(app, page)
    const bytes = await readFile(finalExport.path)
    expect(finalExport.state).toBe('completed')
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1200, height: 1500 })
    const finalImage = finalScene.elements.find((element) => element.id === work.imageId)!
    if (finalImage.type !== 'image') throw new Error('The selected final artwork image is missing')
    const source = await page.evaluate(async (assetId) => (globalThis as unknown as { desktop: DesktopApi }).desktop.readGenerationAsset(assetId, false), finalImage.assetId)
    const sample = { left: 1000, top: 910, width: 32, height: 32 }
    expect(await sharp(bytes).extract(sample).removeAlpha().raw().toBuffer()).toEqual(await sharp(Buffer.from(source.split(',')[1]!, 'base64')).extract(sample).removeAlpha().raw().toBuffer())
    await cp(finalExport.path, test.info().outputPath(`${kind}-final-canvas.png`), { errorOnExist: true, force: false })
    await hit(page.getByRole('button', { name: '生成', exact: true }))
    const exportBefore = await downloadCount(app)
    await hit(page.getByRole('button', { name: /^导出结果 / }))
    await expect.poll(() => downloadCount(app)).toBe(exportBefore + 1)
    const resultExport = await app.evaluate(() => (globalThis as typeof globalThis & { __workDownloads: { path: string; name: string }[] }).__workDownloads.at(-1)!)
    expect(resultExport.name).toContain(edited.results[0]!.id.slice(0, 8))
    await expect.poll(async () => (await bootstrap(page)).workContext?.generation.compareBId).toBe(edited.results[0]!.id)
    const after = await bootstrap(page)
    await app.close()
    app = await open(); page = await app.firstWindow()
    await setUpMain(app, test.info().outputDir, providerOutput.toString('base64'))
    await openWork(page, work.projectId)
    expect((await bootstrap(page)).scene).toEqual(finalScene)
    await expect.poll(async () => (await bootstrap(page)).workContext?.generation).toEqual(after.workContext!.generation)
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __workCalls: unknown[] }).__workCalls.length)).toBe(0)
    await expect(page.locator('.result-focus img')).toHaveCount(2)
    await expect.poll(() => page.locator('.result-focus img').evaluateAll(images => images.every(image => {
      const state = image as unknown as { complete: boolean; naturalWidth: number }
      return state.complete && state.naturalWidth > 0
    }))).toBe(true)
    await expect.poll(() => page.getByLabel('结果胶片条').locator('.filmstrip-loading').count()).toBe(0)
    await captureWorkbench(app, test.info().outputPath('05-reopened-same-work.png'))
    await writeFile(test.info().outputPath('aggregate-ui-facts.json'), JSON.stringify({ kind, sourceManifest: manifestPath, userData, startProjectId: work.projectId, otherProjectId: other.projectId,
      initialSceneRevision: start.scene.revision, finalScene, export: { ...finalExport, sha256: digest(bytes) }, resultExport, newJob: edited, fakeHttpCount: calls.length, actualProviderRequests: 0, restarted: true }, null, 2))
  } finally {
    await writeFile(test.info().outputPath('last-state.json'), JSON.stringify({ state: await bootstrap(page), edits: await app.evaluate(() => (globalThis as typeof globalThis & { __editCalls: unknown[] }).__editCalls), events: await page.evaluate(() => (globalThis as typeof globalThis & { __editEvents?: unknown[] }).__editEvents), body: await page.locator('body').innerText() }, null, 2))
    await captureWorkbench(app, test.info().outputPath('last-native.png')); await app.close()
  }
})
