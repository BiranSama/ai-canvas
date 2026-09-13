import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { AppearanceSettingsService } from './appearance/appearance-settings-service'
import { GenerationRuntime } from './generation/generation-runtime'
import { registerDesktopIpc } from './ipc/register-desktop-ipc'
import { createMainWindow, hardenSession } from './window'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let generationRuntime: Promise<GenerationRuntime> | null = null
let allowQuit = false
let closingWindows = false
let finalizingQuit = false
let appearanceSettings: AppearanceSettingsService | null = null

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(() => {
    hardenSession()
    const userDataDirectory = app.getPath('userData')
    appearanceSettings = new AppearanceSettingsService(join(userDataDirectory, 'state', 'appearance-settings.json'))
    const projectLibraryDirectory = process.env.AI_CANVAS_E2E === undefined
      ? join(app.getPath('documents'), 'AI Canvas')
      : join(userDataDirectory, 'projects')
    generationRuntime = GenerationRuntime.create(userDataDirectory, { projectLibraryDirectory })
    const result = createMainWindow()
    registerDesktopIpc(result.backgroundMaterial, generationRuntime, appearanceSettings)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const nextResult = createMainWindow()
        if (generationRuntime !== null && appearanceSettings !== null) {
          registerDesktopIpc(nextResult.backgroundMaterial, generationRuntime, appearanceSettings)
        }
      }
    })
  })

  app.on('before-quit', (event) => {
    if (allowQuit || generationRuntime === null) return
    event.preventDefault()
    // Let each Renderer persist its last unsent draft before closing Main's
    // project repository. This also covers app.quit, which precedes beforeunload.
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      if (closingWindows) return
      closingWindows = true
      for (const window of windows) {
        window.once('closed', () => {
          if (BrowserWindow.getAllWindows().length === 0) { closingWindows = false; app.quit() }
        })
        window.close()
      }
      // A rejected draft save leaves its window and Main repository available.
      closingWindows = false
      return
    }
    if (finalizingQuit) return
    finalizingQuit = true
    void generationRuntime
      .then((runtime) => runtime.close())
      .finally(() => {
        appearanceSettings?.close()
        appearanceSettings = null
        allowQuit = true
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
