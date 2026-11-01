import { app } from 'electron'
import type { AppUpdateUnsupportedReason } from '../../shared/app-update'
import { AppUpdateService, type UpdaterEngine } from './app-update-service'

/** Only the installed Windows build updates itself; the portable one has nowhere to install to. */
export function appUpdateUnsupportedReason(): AppUpdateUnsupportedReason | null {
  if (!app.isPackaged || process.env.AI_CANVAS_E2E !== undefined) return 'development'
  if (process.platform !== 'win32') return 'platform'
  if ((process.env.PORTABLE_EXECUTABLE_DIR ?? '') !== '') return 'portable'
  return null
}

export async function createAppUpdateService(): Promise<AppUpdateService> {
  const currentVersion = app.getVersion()
  const reason = appUpdateUnsupportedReason()
  if (reason !== null) return new AppUpdateService({ currentVersion, engine: null, unsupportedReason: reason })
  try {
    // Loaded only where it runs: electron-updater reads the installed app's update settings as it starts.
    const updater = await import('electron-updater')
    const engine = ((updater as unknown as { readonly default?: typeof updater }).default ?? updater).autoUpdater
    return new AppUpdateService({ currentVersion, engine: engine as unknown as UpdaterEngine })
  } catch (error) {
    console.error('[AI Canvas] Automatic updates are unavailable:', error)
    return new AppUpdateService({ currentVersion, engine: null, unsupportedReason: 'platform' })
  }
}
