import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { join } from 'node:path'
import { rendererContentSecurityPolicy } from './security/content-security-policy'
import { readWindowState, trackWindowState } from './window-state'
import { coordinateWindowClose } from './window-close-coordinator'

const LIGHT_OVERLAY = {
  color: '#00000000',
  symbolColor: '#202329',
  height: 60
}

const DARK_OVERLAY = {
  color: '#00000000',
  symbolColor: '#F3F3F0',
  height: 60
}

const RENDERER_LOAD_ATTEMPTS = 2

export function rendererLoadRecoveryDataUrl(): string {
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>AI Canvas · 工作区恢复</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; color: #172033; background: radial-gradient(circle at 42% 28%, #f8fbff, #e9eef5 72%); }
    main { width: min(430px, calc(100vw - 48px)); padding: 34px; border: 1px solid rgba(255,255,255,.88); border-radius: 28px; background: rgba(247,250,253,.9); box-shadow: 0 28px 70px rgba(38,52,68,.15); }
    small { color: #55789f; font-weight: 650; letter-spacing: .08em; }
    h1 { margin: 14px 0 10px; font-size: 25px; font-weight: 610; letter-spacing: -.04em; }
    p { margin: 0; color: #667489; font-size: 12px; line-height: 1.75; }
    @media (prefers-color-scheme: dark) {
      body { color: #eef3fa; background: radial-gradient(circle at 42% 28%, #293343, #171b22 72%); }
      main { border-color: rgba(255,255,255,.13); background: rgba(31,38,48,.92); box-shadow: 0 28px 70px rgba(0,0,0,.32); }
      p { color: #aeb9c8; }
    }
  </style>
</head>
<body>
  <main role="alert">
    <small>工作区恢复</small>
    <h1>界面资源暂时没有载入</h1>
    <p>项目与已保存设置仍保留在本机。请关闭并重新打开 AI Canvas；应用不会自动发起生成、重试模型请求或增加费用。</p>
  </main>
</body>
</html>`
  return `data:text/html;charset=UTF-8,${encodeURIComponent(document)}`
}

export interface WindowResult {
  readonly window: BrowserWindow
  readonly backgroundMaterial: 'mica' | 'solid'
}

function isTrustedNavigation(targetUrl: string, currentUrl: string): boolean {
  if (targetUrl === 'about:blank') return true
  if (currentUrl.length === 0) return false

  try {
    return new URL(targetUrl).origin === new URL(currentUrl).origin
  } catch {
    return false
  }
}

export function isRendererNetworkRequestAllowed(targetUrl: string, rendererUrl: string | undefined): boolean {
  if (rendererUrl === undefined || rendererUrl.length === 0) return false
  try {
    return new URL(targetUrl).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

export function createMainWindow(): WindowResult {
  const canUseMica = process.platform === 'win32'
  const overlay = nativeTheme.shouldUseDarkColors ? DARK_OVERLAY : LIGHT_OVERLAY
  const statePath = join(app.getPath('userData'), 'state', 'window-state.json')
  const restoredState = readWindowState(statePath)
  const window = new BrowserWindow({
    width: restoredState?.bounds.width ?? 1280,
    height: restoredState?.bounds.height ?? 800,
    ...(restoredState === null ? {} : { x: restoredState.bounds.x, y: restoredState.bounds.y }),
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'AI Canvas',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191A1C' : '#F4F3F0',
    backgroundMaterial: canUseMica ? 'mica' : 'none',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Chromium otherwise downloads a language dictionary in the background,
      // Renderer network remains disabled; Provider traffic is Main-only.
      spellcheck: false
    }
  })

  let backgroundMaterial: 'mica' | 'solid' = canUseMica ? 'mica' : 'solid'
  coordinateWindowClose(window)
  if (canUseMica) {
    try {
      window.setBackgroundMaterial('mica')
    } catch {
      backgroundMaterial = 'solid'
      window.setBackgroundMaterial('none')
    }
  }

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedNavigation(targetUrl, window.webContents.getURL())) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  window.webContents.once('did-finish-load', () => {
    window.webContents.setZoomFactor(1)
  })

  const syncOverlay = (): void => {
    window.setTitleBarOverlay(nativeTheme.shouldUseDarkColors ? DARK_OVERLAY : LIGHT_OVERLAY)
  }
  nativeTheme.on('updated', syncOverlay)
  window.on('closed', () => nativeTheme.off('updated', syncOverlay))
  trackWindowState(window, statePath)

  let revealed = false
  const revealWindow = (): void => {
    if (revealed || window.isDestroyed()) return
    revealed = true
    if (restoredState?.maximized === true) window.maximize()
    window.show()
  }
  window.once('ready-to-show', revealWindow)

  const loadWorkspace = async (): Promise<void> => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const rendererFile = process.env.AI_CANVAS_E2E_FORCE_RENDERER_LOAD_FAILURE === '1'
      ? join(__dirname, '../renderer/missing-index.html')
      : join(__dirname, '../renderer/index.html')
    for (let attempt = 0; attempt < RENDERER_LOAD_ATTEMPTS; attempt += 1) {
      try {
        if (rendererUrl !== undefined) await window.loadURL(rendererUrl)
        else await window.loadFile(rendererFile)
        revealWindow()
        return
      } catch {
        // Only the local UI document is retried. Provider work remains Main-only
        // and is never started by this recovery path.
      }
    }
    await window.loadURL(rendererLoadRecoveryDataUrl())
    revealWindow()
  }
  void loadWorkspace().catch(() => revealWindow())

  return { window, backgroundMaterial }
}

export function hardenSession(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const policy = rendererContentSecurityPolicy(rendererUrl)
  session.defaultSession.setSpellCheckerEnabled(false)
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback({ cancel: !isRendererNetworkRequestAllowed(details.url, rendererUrl) })
  )
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
