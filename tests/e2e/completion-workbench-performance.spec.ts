import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { captureWorkbench, hitWorkbenchControl as hit } from '../helpers/workbench-ui'
import { waitForPaintedShape } from '../helpers/canvas-hit-readiness'

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }
}
async function painted(page: Page) { await page.evaluate('new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))') }

test('measures real drag, resize and focus work with 100 Main elements, long conversation and eight results', async () => {
  test.setTimeout(150_000)
  const userData = await mkdtemp(join(tmpdir(), 'work-perf-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  try {
    await app.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __perfNetwork: number }
      scope.__perfNetwork = 0
      scope.fetch = async () => { scope.__perfNetwork++; throw new Error('OFFLINE_WORKBENCH_PERFORMANCE') }
    })
    const page = await app.firstWindow()
    await page.bringToFront()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    await hit(page.getByRole('button', { name: '形状', exact: true }))
    const setup = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const scene = (await api.getWorkspaceBootstrap()).scene
      const shape = scene.elements.find((element) => element.type === 'shape')!
      const result = await api.executeSceneCommands({ projectId: scene.projectId, expectedSceneRevision: scene.revision,
        batch: { id: crypto.randomUUID(), origin: 'user', summary: '100 element offline performance fixture', commands: [
          { kind: 'element.remove', elementId: shape.id },
          ...Array.from({ length: 100 }, (_, index) => ({ kind: 'element.add' as const, element: { ...shape,
            id: crypto.randomUUID(), name: `性能色块 ${index + 1}`, zIndex: index,
            transform: { ...shape.transform, x: .3 + (index % 10) * .041, y: .2 + Math.floor(index / 10) * .04, width: .027, height: .025 }
          } }))
        ] } })
      if (!result.ok) throw new Error('Main fixture commit rejected')
      for (let index = 0; index < 20; index++) {
        const current = (await api.getWorkspaceBootstrap()).scene
        const run = await api.startAgentRun({ text: `请解释画布中当前构图，第${index + 1}次复核，不要生成图片。${'保留主体与文字，画面需留白。'.repeat(14)}`,
          sceneSummary: { revision: current.revision, canvas: current.canvas, elementCount: current.elements.length, elements: [] },
          selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }, 'auto', 'new_task')
        const limit = Date.now() + 5000
        while (Date.now() < limit) {
          const saved = (await api.getConversationSnapshot()).runs.find((item) => item.id === run.id)
          if (saved && ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(saved.status)) break
          await new Promise((wait) => setTimeout(wait, 10))
        }
      }
      for (let index = 0; index < 2; index++) await api.enqueueGeneration({ prompt: `Offline performance candidate ${index + 1}`, negativePrompt: '',
        aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, count: 4, providerId: 'mock', model: 'mock-balanced',
        references: [], parameters: {}, sourceMessageId: null, parentResultId: null, referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '' })
      return { sceneCount: (await api.getWorkspaceBootstrap()).scene.elements.length, messageCount: (await api.getConversationSnapshot()).messages.length }
    })
    expect(setup.sceneCount).toBe(100)
    expect(setup.messageCount).toBeGreaterThanOrEqual(40)
    await expect.poll(() => page.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.listGenerationJobs()).flatMap((job) => job.results).length)).toBe(8)
    await hit(page.getByRole('button', { name: '选择 V', exact: true }))

    const drags: number[] = [], resizes: number[] = [], focuses: number[] = [], windowResizes: number[] = []
    const frameTimes: number[] = []
    const filters: unknown[] = []
    for (let index = 0; index < 5; index++) {
      await page.evaluate(`(() => {
        const scope = globalThis
        scope.__perfFrames = []; let last = performance.now()
        const tick = (now) => { scope.__perfFrames.push(now - last); last = now; scope.__perfFrame = requestAnimationFrame(tick) }
        scope.__perfFrame = requestAnimationFrame(tick)
      })()`)
      await captureWorkbench(app, test.info().outputPath(`drag-${index}-ready.png`))
      await page.screenshot({ path: test.info().outputPath(`drag-${index}-hit-ready.png`) })
      const target = await waitForPaintedShape(page)
      await page.mouse.click(target.x, target.y)
      await expect(page.locator(`[data-layer-id="${target.shapeId}"]`)).toHaveAttribute('aria-selected', 'true')
      await painted(page)
      const before = await page.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === id)!, target.shapeId)
      const started = performance.now()
      await page.mouse.move(target.x, target.y); await page.mouse.down()
      await page.mouse.move(target.x + 35, target.y + 24, { steps: 5 }); await page.mouse.up()
      await expect.poll(() => page.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === id)?.transform.x, target.shapeId)).not.toBe(before.transform.x)
      await painted(page); drags.push(performance.now() - started)
      const undo = page.getByRole('button', { name: '撤销', exact: true }); await hit(undo)
      await expect.poll(() => page.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap()).scene.elements.find((element) => element.id === id)?.transform.x, target.shapeId)).toBe(before.transform.x)
      const composer = page.locator('[data-island-id="composer"]')
      const resize = composer.getByRole('separator', { name: '调整Agent 创作大小' })
      const box = (await resize.boundingBox())!
      const sizeBefore = (await composer.boundingBox())!
      const resizeStarted = performance.now()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 - 9, { steps: 4 })
      await expect(composer).toHaveAttribute('data-island-interacting', 'true')
      const filter = await composer.evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).backdropFilter)
      expect(filter).toMatch(/blur\((8|10)px\)|none/)
      filters.push(filter)
      await page.mouse.up(); await expect(composer).toHaveAttribute('data-island-interacting', 'false')
      await expect.poll(async () => (await composer.boundingBox())!.width).toBeGreaterThan(sizeBefore.width)
      await painted(page); resizes.push(performance.now() - resizeStarted)
      const focusStarted = performance.now()
      await hit(page.getByRole('button', { name: '对话', exact: true }))
      await expect(page.getByLabel('对话输入', { exact: true })).toBeVisible()
      await hit(page.getByRole('button', { name: '生成', exact: true }))
      await expect(page.getByTestId('generation-result')).toHaveCount(8)
      await expect.poll(() => page.locator('.result-focus img').evaluateAll((nodes) => nodes.length > 0 && nodes.every((node) => (node as unknown as { complete: boolean }).complete && (node as unknown as { naturalWidth: number }).naturalWidth > 0))).toBe(true)
      await painted(page); focuses.push(performance.now() - focusStarted)
      await hit(page.getByRole('button', { name: '画布', exact: true }))
      const windowStarted = performance.now()
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900), index % 2 ? 1440 : 1480)
      await painted(page); windowResizes.push(performance.now() - windowStarted)
      frameTimes.push(...await page.evaluate('(() => { cancelAnimationFrame(globalThis.__perfFrame); return globalThis.__perfFrames })()') as number[])
    }
    expect(Math.max(...drags)).toBeLessThan(1500)
    expect(Math.max(...resizes)).toBeLessThan(1500)
    expect(Math.max(...focuses)).toBeLessThan(3000)
    expect(Math.max(...windowResizes)).toBeLessThan(1000)
    const network = await app.evaluate(() => (globalThis as typeof globalThis & { __perfNetwork: number }).__perfNetwork)
    expect(network).toBe(0)
    const report = { userData, setup, results: 8, repetitions: 5, environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpuCount: cpus().length, totalMemory: totalmem(), runtime: await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getRuntimeInfo()) },
      measured: { dragToMainCommitMs: summary(drags), islandResizeToPaintMs: summary(resizes), conversationAndEightResultsToPaintMs: summary(focuses), windowResizeToPaintMs: summary(windowResizes), animationFrameIntervalsMs: summary(frameTimes) },
      interactionFilters: filters, actualProviderRequests: network, limitation: 'Same host, five repeats; Playwright pointer and Main-commit time includes automation overhead. Not a physical-device or universal latency claim.' }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(report.measured).map(([key, value]) => [key, { median: value.median, p95: value.p95, max: value.max }]))))
    await writeFile(test.info().outputPath('performance-facts.json'), JSON.stringify(report, null, 2))
    await captureWorkbench(app, test.info().outputPath('100-elements.png'))
  } finally { await app.close() }
})
