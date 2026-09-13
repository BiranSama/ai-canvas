import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

test('AH1 S3 publishes ordered Main scene events and keeps history across Renderer reload', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s3-authority-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const committed = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const eventPromise = new Promise<Parameters<Parameters<DesktopApi['onSceneChanged']>[0]>[0]>((resolveEvent) => {
        const unsubscribe = api.onSceneChanged((event) => {
          unsubscribe()
          resolveEvent(event)
        })
      })
      const result = await api.executeSceneCommands({
        expectedSceneRevision: bootstrap.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'user',
          summary: 'S3 调整画布比例',
          commands: [{
            kind: 'scene.set-canvas',
            canvas: {
              ...bootstrap.scene.canvas,
              aspectWidth: 3,
              aspectHeight: 2,
              outputWidth: 1500,
              outputHeight: 1000
            }
          }]
        }
      })
      if (!result.ok) throw new Error(result.error.message)
      const event = await eventPromise
      return { result, event }
    })

    expect(committed.result.receipt.state).toMatchObject({ sequence: 1, canUndo: true, scene: { revision: 1 } })
    expect(committed.event).toMatchObject({
      reason: 'user',
      action: 'execute',
      state: { sequence: 1, scene: { revision: 1, canvas: { aspectWidth: 3, aspectHeight: 2 } } }
    })

    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    const reloaded = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return api.getWorkspaceBootstrap()
    })
    expect(reloaded).toMatchObject({ sceneSequence: 1, canUndo: true, canRedo: false, scene: { revision: 1 } })
    await expect(window.getByRole('button', { name: '撤销' })).toBeEnabled()

    const history = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const bootstrap = await api.getWorkspaceBootstrap()
      const undone = await api.undoScene({ expectedSceneRevision: bootstrap.scene.revision, batchId: null })
      if (!undone.ok) throw new Error(undone.error.message)
      const redone = await api.redoScene({ expectedSceneRevision: undone.receipt.state.scene.revision, batchId: null })
      if (!redone.ok) throw new Error(redone.error.message)
      return { undone, redone }
    })
    expect(history.undone.receipt.state).toMatchObject({ sequence: 2, canRedo: true, scene: { revision: 2 } })
    expect(history.redone.receipt.state).toMatchObject({ sequence: 3, canUndo: true, canRedo: false, scene: { revision: 3 } })
  } finally {
    await app.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
