import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
}

test('restores a visible Windows desktop position and size after a clean restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-window-state-'))
  let app: ElectronApplication | null = await launch(userData)
  try {
    await app.firstWindow()
    const target = await app.evaluate(({ BrowserWindow, screen }) => {
      const workArea = screen.getPrimaryDisplay().workArea
      const window = BrowserWindow.getAllWindows()[0]
      window?.setBounds({
        x: workArea.x + 24,
        y: workArea.y + 24,
        width: Math.max(1024, Math.min(1120, workArea.width - 48)),
        height: Math.max(700, Math.min(740, workArea.height - 48))
      })
      return window?.getBounds()
    })
    if (target === undefined) throw new Error('Main window did not open.')
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())).toEqual(target)
    await app.close()
    app = null

    const stored = JSON.parse(await readFile(join(userData, 'state', 'window-state.json'), 'utf8')) as unknown
    expect(stored).toMatchObject({ version: 1, bounds: target, maximized: false })

    app = await launch(userData)
    await app.firstWindow()
    const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())
    expect(restored).toEqual(target)
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
