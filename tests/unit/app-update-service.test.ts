import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { AppUpdateService, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, type UpdaterEngine, type UpdateTimers } from '../../src/main/update/app-update-service'
import { describeAppUpdate, type AppUpdateSnapshot } from '../../src/shared/app-update'

class FakeEngine extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async (): Promise<unknown> => null)
  quitAndInstall = vi.fn()
}

function setup() {
  const engine = new FakeEngine()
  const scheduled: Array<{ readonly kind: 'once' | 'every'; readonly ms: number; readonly run: () => void }> = []
  const timers: UpdateTimers = {
    setTimeout: (run, ms) => { scheduled.push({ kind: 'once', ms, run }); return scheduled.length },
    setInterval: (run, ms) => { scheduled.push({ kind: 'every', ms, run }); return scheduled.length },
    clear: vi.fn()
  }
  const service = new AppUpdateService({ currentVersion: '0.3.0', engine: engine as unknown as UpdaterEngine, timers, now: () => new Date('2026-11-01T10:30:00') })
  const seen: AppUpdateSnapshot[] = []
  service.subscribe((snapshot) => seen.push(snapshot))
  return { engine, scheduled, timers, service, seen }
}

it('downloads in the background and installs on quit unless restarted first', () => {
  const { engine, service } = setup()
  expect(engine.autoDownload).toBe(true)
  expect(engine.autoInstallOnAppQuit).toBe(true)
  expect(service.snapshot()).toEqual({ currentVersion: '0.3.0', status: { kind: 'idle', checkedAt: null } })
})

it('checks 15 seconds after start, then every six hours', () => {
  const { engine, scheduled, service } = setup()
  service.start()
  service.start()
  expect(scheduled.map(({ kind, ms }) => ({ kind, ms }))).toEqual([{ kind: 'once', ms: FIRST_CHECK_DELAY_MS }, { kind: 'every', ms: CHECK_INTERVAL_MS }])
  expect(FIRST_CHECK_DELAY_MS).toBe(15_000)
  expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  scheduled[0]!.run()
  expect(engine.checkForUpdates).toHaveBeenCalledOnce()
})

it('follows a new version from found to downloaded, and restarts into it', async () => {
  const { engine, service, seen, timers } = setup()
  engine.checkForUpdates.mockImplementation(async () => {
    engine.emit('checking-for-update')
    engine.emit('update-available', { version: '0.4.0' })
    return null
  })
  await service.check()
  expect(service.snapshot().status).toEqual({ kind: 'downloading', version: '0.4.0', percent: 0 })
  engine.emit('download-progress', { percent: 42.5 })
  expect(service.snapshot().status).toEqual({ kind: 'downloading', version: '0.4.0', percent: 42.5 })
  expect(service.install()).toBe(false)
  engine.emit('update-downloaded', { version: '0.4.0' })
  expect(service.snapshot().status).toEqual({ kind: 'ready', version: '0.4.0' })
  expect(seen.map((snapshot) => snapshot.status.kind)).toEqual(['checking', 'checking', 'downloading', 'downloading', 'ready'])

  // Ready stays ready: no more checks, and a later error does not take it away.
  await service.check()
  expect(engine.checkForUpdates).toHaveBeenCalledOnce()
  engine.emit('error', new Error('offline'))
  expect(service.snapshot().status.kind).toBe('ready')

  service.start()
  expect(service.install()).toBe(true)
  expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true)
  expect(timers.clear).toHaveBeenCalledTimes(2)
})

it('says when it is up to date, and when a check failed', async () => {
  const { engine, service } = setup()
  engine.checkForUpdates.mockImplementationOnce(async () => { engine.emit('update-not-available'); return null })
  await service.check()
  expect(service.snapshot().status).toEqual({ kind: 'idle', checkedAt: new Date('2026-11-01T10:30:00').toISOString() })
  expect(describeAppUpdate(service.snapshot().status)).toBe('已是最新版本（10:30 检查）。')

  engine.checkForUpdates.mockImplementationOnce(async () => { engine.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')); throw new Error('net::ERR_INTERNET_DISCONNECTED') })
  await service.check()
  expect(service.snapshot().status.kind).toBe('failed')
  expect(describeAppUpdate(service.snapshot().status)).toContain('检查更新没有成功（10:30）')

  // A failed check is tried again.
  await service.check()
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(3)
})

it('does not start a second check while one is under way', async () => {
  const { engine, service } = setup()
  let finish!: () => void
  engine.checkForUpdates.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(null) }))
  const first = service.check()
  await service.check()
  expect(engine.checkForUpdates).toHaveBeenCalledOnce()
  finish()
  await first
  // A check that ends without any event still ends.
  expect(service.snapshot().status.kind).toBe('idle')
})

it('explains why a build does not update itself, and never touches an engine', async () => {
  const portable = new AppUpdateService({ currentVersion: '0.3.0', engine: null, unsupportedReason: 'portable' })
  portable.start()
  expect(await portable.check()).toEqual({ currentVersion: '0.3.0', status: { kind: 'unsupported', reason: 'portable' } })
  expect(portable.install()).toBe(false)
  expect(describeAppUpdate(portable.snapshot().status)).toBe('便携版不会自动更新，新版本请到发布页下载。')
  expect(describeAppUpdate({ kind: 'unsupported', reason: 'development' })).toBe('开发版不会自动更新。')
  expect(describeAppUpdate({ kind: 'downloading', version: '0.4.0', percent: 42.5 })).toBe('正在后台下载新版本 0.4.0（43%）。')
})
