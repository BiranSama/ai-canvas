import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { AppearanceSettingsService } from './appearance/appearance-settings-service'
import { GenerationRuntime } from './generation/generation-runtime'
import { registerDesktopIpc } from './ipc/register-desktop-ipc'
import { subjectSegmentation } from './segmentation/subject-segmentation-electron'
import { openableFileArguments, queueOpenFiles } from './open-file-requests'
import { DESKTOP_EVENTS } from '../shared/desktop-api'
import { createMainWindow, hardenSession } from './window'

// Without a usable graphics card Chromium no longer falls back to software WebGL by itself; the object
// selection's model needs WebGL, and the window only ever shows the app's own pages.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let generationRuntime: Promise<GenerationRuntime> | null = null
let allowQuit = false
let closingWindows = false
let finalizingQuit = false
let appearanceSettings: AppearanceSettingsService | null = null

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  // Images opened from the system become projects, as Photoshop opens them as documents.
  queueOpenFiles(openableFileArguments(process.argv.slice(1), process.cwd()))
  const announceOpenFiles = (): void => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(DESKTOP_EVENTS.openFileRequested)
  }
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (queueOpenFiles(openableFileArguments([path], process.cwd()))) announceOpenFiles()
  })

  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (queueOpenFiles(openableFileArguments(argv.slice(1), workingDirectory))) announceOpenFiles()
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(() => {
    hardenSession()
    // The default menu's accelerators (Ctrl+R reload, Ctrl+Shift+I developer
    // tools, Ctrl+plus and minus page zoom) would take keys Photoshop uses.
    // The development build keeps them.
    if (process.env.ELECTRON_RENDERER_URL === undefined) Menu.setApplicationMenu(null)
    const userDataDirectory = app.getPath('userData')
    appearanceSettings = new AppearanceSettingsService(join(userDataDirectory, 'state', 'appearance-settings.json'))
    const projectLibraryDirectory = process.env.AI_CANVAS_E2E === undefined
      ? join(app.getPath('documents'), 'AI Canvas')
      : join(userDataDirectory, 'projects')
    generationRuntime = GenerationRuntime.create(userDataDirectory, { projectLibraryDirectory, subject: subjectSegmentation })
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
