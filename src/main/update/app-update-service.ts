import type { AppUpdateSnapshot, AppUpdateStatus, AppUpdateUnsupportedReason } from '../../shared/app-update'

/** The part of electron-updater this service drives; a fake stands in for it in tests. */
export interface UpdaterEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update' | 'update-not-available' | 'error', listener: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', listener: (info: { readonly version: string }) => void): unknown
  on(event: 'download-progress', listener: (progress: { readonly percent: number }) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateTimers {
  setTimeout(callback: () => void, ms: number): unknown
  setInterval(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The first check waits until the app has settled; later ones come every six hours. */
export const FIRST_CHECK_DELAY_MS = 15_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000

const SYSTEM_TIMERS: UpdateTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms)
    handle.unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Checks GitHub Releases in the background, downloads a new version as soon
 * as one is out and installs it on restart or quit. A build that cannot
 * update itself (development, portable) says why instead.
 */
export class AppUpdateService {
  readonly #currentVersion: string
  readonly #engine: UpdaterEngine | null
  readonly #timers: UpdateTimers
  readonly #now: () => Date
  readonly #listeners = new Set<(snapshot: AppUpdateSnapshot) => void>()
  readonly #handles: unknown[] = []
  #status: AppUpdateStatus

  constructor(options: {
    readonly currentVersion: string
    readonly engine: UpdaterEngine | null
    readonly unsupportedReason?: AppUpdateUnsupportedReason
    readonly timers?: UpdateTimers
    readonly now?: () => Date
  }) {
    this.#currentVersion = options.currentVersion
    this.#engine = options.engine
    this.#timers = options.timers ?? SYSTEM_TIMERS
    this.#now = options.now ?? (() => new Date())
    this.#status = options.engine === null
      ? { kind: 'unsupported', reason: options.unsupportedReason ?? 'development' }
      : { kind: 'idle', checkedAt: null }
    if (options.engine !== null) this.#wire(options.engine)
  }

  snapshot(): AppUpdateSnapshot {
    return { currentVersion: this.#currentVersion, status: this.#status }
  }

  subscribe(listener: (snapshot: AppUpdateSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Schedules the background checks; does nothing for a build that cannot update itself. */
  start(): void {
    if (this.#engine === null || this.#handles.length > 0) return
    this.#handles.push(this.#timers.setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS))
    this.#handles.push(this.#timers.setInterval(() => void this.check(), CHECK_INTERVAL_MS))
  }

  stop(): void {
    for (const handle of this.#handles.splice(0)) this.#timers.clear(handle)
  }

  /** Checks now, unless a check or download is already under way or a new version is waiting to be installed. */
  async check(): Promise<AppUpdateSnapshot> {
    const engine = this.#engine
    const busy = this.#status.kind === 'checking' || this.#status.kind === 'downloading' || this.#status.kind === 'ready'
    if (engine === null || busy) return this.snapshot()
    this.#set({ kind: 'checking' })
    try {
      await engine.checkForUpdates()
    } catch {
      this.#fail()
    }
    // A check that ends without any of the engine's events (no release feed at all) still ends.
    if (this.#status.kind === 'checking') this.#set({ kind: 'idle', checkedAt: this.#now().toISOString() })
    return this.snapshot()
  }

  /** Restarts into the downloaded version, installing quietly; false when nothing is waiting. */
  install(): boolean {
    if (this.#engine === null || this.#status.kind !== 'ready') return false
    this.stop()
    this.#engine.quitAndInstall(true, true)
    return true
  }

  #wire(engine: UpdaterEngine): void {
    engine.autoDownload = true
    engine.autoInstallOnAppQuit = true
    engine.on('checking-for-update', () => {
      if (this.#status.kind !== 'downloading' && this.#status.kind !== 'ready') this.#set({ kind: 'checking' })
    })
    engine.on('update-not-available', () => this.#set({ kind: 'idle', checkedAt: this.#now().toISOString() }))
    engine.on('update-available', (info) => this.#set({ kind: 'downloading', version: info.version, percent: 0 }))
    engine.on('download-progress', (progress) => {
      if (this.#status.kind !== 'downloading') return
      this.#set({ kind: 'downloading', version: this.#status.version, percent: Math.min(100, Math.max(0, progress.percent)) })
    })
    engine.on('update-downloaded', (info) => this.#set({ kind: 'ready', version: info.version }))
    engine.on('error', () => this.#fail())
  }

  #fail(): void {
    // A version already downloaded stays ready; a failed later check does not take it away.
    if (this.#status.kind === 'ready') return
    this.#set({ kind: 'failed', checkedAt: this.#now().toISOString() })
  }

  #set(status: AppUpdateStatus): void {
    this.#status = status
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}
