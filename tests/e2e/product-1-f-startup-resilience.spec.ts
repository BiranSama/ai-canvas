import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'

const STARTUP_CYCLES = 30

async function launch(
  userData: string,
  externalRequests: string[],
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<{ readonly app: ElectronApplication; readonly window: Page; readonly pageErrors: string[] }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1', ...extraEnvironment }
  })
  const window = await app.firstWindow()
  const pageErrors: string[] = []
  window.on('pageerror', (error) => pageErrors.push(error.message))
  window.on('request', (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
  })
  await window.waitForLoadState('domcontentloaded')
  return { app, window, pageErrors }
}

test('Stage F shows a local recovery surface instead of a blank window when renderer assets fail to load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-f-load-recovery-'))
  const externalRequests: string[] = []
  let running: ElectronApplication | null = null
  try {
    const launched = await launch(join(root, 'user-data'), externalRequests, {
      AI_CANVAS_E2E_FORCE_RENDERER_LOAD_FAILURE: '1'
    })
    running = launched.app

    await expect(launched.window.getByRole('alert')).toContainText('界面资源暂时没有载入')
    await expect(launched.window.getByRole('alert')).toContainText('不会自动发起生成、重试模型请求或增加费用')
    expect(await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    expect(launched.pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await running?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test(`Stage F preserves one committed workspace through ${STARTUP_CYCLES} full start-close-restart cycles without a blank window`, async () => {
  test.setTimeout(300_000)
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-f-30-startups-'))
  const userData = join(root, 'user-data')
  const externalRequests: string[] = []
  let running: ElectronApplication | null = null
  let expected: { readonly projectId: string; readonly sceneId: string; readonly revision: number } | null = null
  try {
    for (let cycle = 1; cycle <= STARTUP_CYCLES; cycle += 1) {
      const launched = await launch(userData, externalRequests)
      running = launched.app

      await expect.poll(() => launched.window.evaluate(() => {
        const page = globalThis as typeof globalThis & { readonly document: { readonly body: { readonly innerText: string } } }
        return page.document.body.innerText.trim().length
      }), {
        message: `startup cycle ${cycle} should render visible product text`
      }).toBeGreaterThan(20)
      await expect(launched.window.locator('#root .app-shell')).toBeVisible()
      await expect(launched.window.locator('.renderer-error-shell')).toHaveCount(0)

      const snapshot = await launched.window.evaluate(async ({ initialize }) => {
        const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
        const runtime = await api.getRuntimeInfo()
        const initial = await api.getWorkspaceBootstrap()
        if (!initialize) {
          return {
            runtime,
            projectId: initial.projectId,
            sceneId: initial.scene.id,
            revision: initial.scene.revision,
            canvas: initial.scene.canvas
          }
        }
        const mutation = await api.executeSceneCommands({
          expectedSceneRevision: initial.scene.revision,
          batch: {
            id: globalThis.crypto.randomUUID(),
            origin: 'user',
            summary: 'Stage F 建立可恢复启动基线',
            commands: [{
              kind: 'scene.set-canvas',
              canvas: {
                ...initial.scene.canvas,
                aspectWidth: 3,
                aspectHeight: 2,
                outputWidth: 1440,
                outputHeight: 960,
                globalStyle: 'Stage F 本地恢复基线'
              }
            }]
          }
        })
        if (!mutation.ok) throw new Error(mutation.error.message)
        return {
          runtime,
          projectId: mutation.receipt.state.scene.projectId,
          sceneId: mutation.receipt.state.scene.id,
          revision: mutation.receipt.state.scene.revision,
          canvas: mutation.receipt.state.scene.canvas
        }
      }, { initialize: cycle === 1 })

      expect(snapshot.runtime.nativeModules).toMatchObject({ betterSqlite3: true, sharp: true })
      expect(snapshot.canvas).toMatchObject({
        aspectWidth: 3,
        aspectHeight: 2,
        outputWidth: 1440,
        outputHeight: 960,
        globalStyle: 'Stage F 本地恢复基线'
      })
      if (expected === null) {
        expected = { projectId: snapshot.projectId, sceneId: snapshot.sceneId, revision: snapshot.revision }
      } else {
        expect(snapshot).toMatchObject(expected)
      }
      expect(launched.pageErrors).toEqual([])

      await launched.app.close()
      running = null
    }

    expect(expected).not.toBeNull()
    expect(externalRequests).toEqual([])
  } finally {
    await running?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
  }
})
