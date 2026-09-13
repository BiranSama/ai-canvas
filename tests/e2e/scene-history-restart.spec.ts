import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function launch(userData: string, externalRequests: string[]): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  const window = await app.firstWindow()
  window.on('request', (request) => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

test('AH1 S9 restores committed Scene undo and redo stacks after a full Windows app restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s9-history-'))
  const externalRequests: string[] = []
  let running: ElectronApplication | null = null
  try {
    const first = await launch(userData, externalRequests)
    running = first.app
    const beforeRestart = await first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const initial = await api.getWorkspaceBootstrap()
      const firstMutation = await api.executeSceneCommands({
        expectedSceneRevision: initial.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'user',
          summary: 'S9 持久历史：横向画布',
          commands: [{
            kind: 'scene.set-canvas',
            canvas: { ...initial.scene.canvas, aspectWidth: 3, aspectHeight: 2, outputWidth: 1500, outputHeight: 1000 }
          }]
        }
      })
      if (!firstMutation.ok) throw new Error(firstMutation.error.message)
      const secondMutation = await api.executeSceneCommands({
        expectedSceneRevision: firstMutation.receipt.state.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'user',
          summary: 'S9 持久历史：提高输出尺寸',
          commands: [{
            kind: 'scene.set-canvas',
            canvas: { ...firstMutation.receipt.state.scene.canvas, outputWidth: 2100, outputHeight: 1400 }
          }]
        }
      })
      if (!secondMutation.ok) throw new Error(secondMutation.error.message)
      const undone = await api.undoScene({
        expectedSceneRevision: secondMutation.receipt.state.scene.revision,
        batchId: secondMutation.receipt.batch?.id ?? null
      })
      if (!undone.ok) throw new Error(undone.error.message)
      return undone.receipt.state
    })
    expect(beforeRestart).toMatchObject({ canUndo: true, canRedo: true, scene: { revision: 3, canvas: { outputWidth: 1500 } } })
    await first.app.close()
    running = null

    const second = await launch(userData, externalRequests)
    running = second.app
    const afterRestart = await second.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const redone = await api.redoScene({ expectedSceneRevision: bootstrap.scene.revision, batchId: null })
      if (!redone.ok) throw new Error(redone.error.message)
      const undone = await api.undoScene({ expectedSceneRevision: redone.receipt.state.scene.revision, batchId: null })
      if (!undone.ok) throw new Error(undone.error.message)
      return { bootstrap, redone: redone.receipt.state, undone: undone.receipt.state }
    })
    expect(afterRestart.bootstrap).toMatchObject({ canUndo: true, canRedo: true, scene: { revision: 3, canvas: { outputWidth: 1500 } } })
    expect(afterRestart.redone).toMatchObject({ canUndo: true, canRedo: false, scene: { revision: 4, canvas: { outputWidth: 2100 } } })
    expect(afterRestart.undone).toMatchObject({ canUndo: true, canRedo: true, scene: { revision: 5, canvas: { outputWidth: 1500 } } })
    expect(externalRequests).toEqual([])
  } finally {
    await running?.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
