import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readShapeHitState, waitForPaintedShape } from '../helpers/canvas-hit-readiness'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { DESKTOP_CHANNELS } from '../../src/shared/desktop-api'

test('IPC-only project creation after Renderer hydration reproduces the recovery test close refusal', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'recovery-gap-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  const page = await app.firstWindow()
  try {
    await expect(page.getByRole('button', { name: /^项目菜单：/ })).toBeVisible()
    const before = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
    await app.evaluate(({ dialog, ipcMain }, { target, channel }) => {
      dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
      const state = globalThis as typeof globalThis & { __closeResults: boolean[] }
      state.__closeResults = []
      ipcMain.on(channel, (_event, receipt: { saved: boolean }) => { state.__closeResults.push(receipt.saved) })
    }, { target: join(userData, 'IPC-only.aicanvas'), channel: DESKTOP_CHANNELS.windowCloseReceipt })
    const created = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.createProject({ suggestedName: 'IPC-only' }))
    expect(created.bootstrap?.projectId).not.toBe(before.projectId)
    await expect(page.getByRole('button', { name: `项目菜单：${before.projectName}`, exact: true })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close() })
    await expect(page.getByRole('alert')).toContainText('工作状态未保存')
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __closeResults: boolean[] }).__closeResults)).toEqual([false])
    expect(app.windows()).toHaveLength(1)
    const current = await page.evaluate(() => (globalThis as unknown as { desktop: DesktopApi }).desktop.getWorkspaceBootstrap())
    expect(current.projectId).toBe(created.bootstrap?.projectId)
    expect(current.workContext).toBeNull()
    await writeFile(test.info().outputPath('ipc-project-close-counterexample.json'), JSON.stringify({ rendererProjectId: before.projectId, mainProjectId: current.projectId, closeSaved: false, windowRetained: true, actualProviderRequests: 0 }, null, 2))
  } finally {
    // Reload adopts the authoritative project; do not bypass the save guard.
    await page.reload()
    await expect(page.getByRole('button', { name: /^项目菜单：/ })).toBeVisible()
    await app.close()
  }
})

test('a Main shape can exist before its hit surface is painted, reproducing the old viewport precondition gap', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'paint-gap-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  const page = await app.firstWindow()
  try {
    await page.addInitScript({ content: `(() => {
      const original = window.requestAnimationFrame.bind(window)
      const cancel = window.cancelAnimationFrame.bind(window)
      const callbacks = new Map(); let id = 1_000_000
      const state = window
      state.__holdPaint = false
      window.requestAnimationFrame = (callback) => {
        if (!state.__holdPaint) return original(callback)
        const next = ++id; callbacks.set(next, callback); return next
      }
      window.cancelAnimationFrame = (handle) => { if (!callbacks.delete(handle)) cancel(handle) }
      state.__releasePaint = async () => {
        state.__holdPaint = false
        for (const callback of callbacks.values()) original(callback)
        callbacks.clear()
        await new Promise((resolve) => original(() => original(() => resolve())))
      }
    })()` })
    await page.reload()
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.getByRole('button', { name: '文字 T' }).click()
    await expect(page.getByRole('toolbar', { name: '所选元素快捷操作' })).toBeVisible()
    // A controlled delayed paint models a busy frame without changing Scene,
    // mouse events, selection, or Main persistence. The first click intentionally
    // follows the historical test's synthetic setup to demonstrate its flaw.
    await page.evaluate(`(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      window.__holdPaint = true
    })()`)
    await page.getByRole('button', { name: '形状', exact: true }).evaluate((button) => button.click())
    await expect.poll(() => readShapeHitState(page)).not.toBeNull()
    const before = (await readShapeHitState(page))!
    expect(before.painted).toBe(false)
    await page.mouse.dblclick(before.x, before.y)
    await expect(page.getByRole('toolbar', { name: '形状直接编辑' })).toHaveCount(0)
    await page.evaluate('window.__releasePaint?.()')
    await page.keyboard.press('Escape')
    const ready = await waitForPaintedShape(page)
    await page.mouse.dblclick(ready.x, ready.y)
    await expect(page.getByRole('toolbar', { name: '形状直接编辑' })).toBeVisible()
    await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-shape-editing', ready.shapeId)
    await writeFile(test.info().outputPath('paint-readiness-counterexample.json'), JSON.stringify({ before, ready, actualProviderRequests: 0 }, null, 2))
    await page.screenshot({ path: test.info().outputPath('painted-shape-real-doubleclick.png') })
  } finally {
    await page.evaluate('window.__releasePaint?.()').catch(() => undefined)
    await app.close()
  }
})

test('queue_next after a completed first Turn creates another Turn without a queue entry and loses no work', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'queue-gap-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
  const page = await app.firstWindow()
  try {
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    const start = async (first: boolean) => page.evaluate(async (initial) => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      const { scene } = await api.getWorkspaceBootstrap()
      const request = { text: initial ? '创建一张 1:1 月夜封面，标题 MOON TRACE。先不要生成图片。' : '创建下一张 1:1 晨雾封面，标题 PALE HORIZON。先不要生成图片。',
        sceneSummary: { revision: scene.revision, canvas: scene.canvas, elementCount: scene.elements.length, elements: [] }, selectedIds: [], selectedElements: [],
        attachments: [], ephemeralAnnotation: null, autoGenerate: false, activeGenerationJobId: null }
      return initial ? api.startAgentRun(request) : api.inputAgentRun(request, 'queue_next')
    }, first)
    const first = await start(true)
    await expect.poll(async () => page.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot()).turns.find((turn) => turn.inputMessageId === id)?.status, first.id)).toBe('completed')
    const second = await start(false)
    await expect.poll(async () => page.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot()).turns.find((turn) => turn.inputMessageId === id)?.status, second.id)).toBe('completed')
    const evidence = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
      return { harness: await api.getAgentHarnessSnapshot(), scene: (await api.getWorkspaceBootstrap()).scene, events: await api.replayAgentEvents(0, 10000) }
    })
    expect(first.id).not.toBe(second.id)
    expect(evidence.harness.turns).toHaveLength(2)
    expect(evidence.harness.turns.map((turn) => turn.status)).toEqual(['completed', 'completed'])
    expect(evidence.harness.queue).toEqual([])
    expect(evidence.harness.items.filter((item) => item.type === 'tool_result' && item.status === 'completed')).toHaveLength(2)
    expect(evidence.events.some((event) => event.type === 'queue.queued')).toBe(false)
    await writeFile(test.info().outputPath('completed-before-queue-counterexample.json'), JSON.stringify(evidence, null, 2))
  } finally { await app.close() }
})
