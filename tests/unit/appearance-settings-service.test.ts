import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { nativeThemeListeners, nativeTheme } = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    nativeThemeListeners: listeners,
    nativeTheme: {
      themeSource: 'system',
      shouldUseDarkColors: false,
      on: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
      off: vi.fn((_event: string, listener: () => void) => listeners.delete(listener))
    }
  }
})

vi.mock('electron', () => ({ nativeTheme }))

import { AppearanceSettingsService } from '../../src/main/appearance/appearance-settings-service'

const roots: string[] = []

afterEach(async () => {
  nativeTheme.themeSource = 'system'
  nativeTheme.shouldUseDarkColors = false
  nativeThemeListeners.clear()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

describe('Main AppearanceSettingsService', () => {
  it('falls back from corrupt content and atomically persists an approved theme', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-appearance-'))
    roots.push(root)
    const filePath = join(root, 'state', 'appearance-settings.json')
    await writeFile(join(root, 'corrupt.json'), '{broken', 'utf8')
    const corruptService = new AppearanceSettingsService(join(root, 'corrupt.json'), () => '2026-08-31T08:00:00.000Z')
    expect(corruptService.snapshot()).toMatchObject({ settings: { theme: 'system' }, effectiveTheme: 'pearl' })
    corruptService.close()

    const service = new AppearanceSettingsService(filePath, () => '2026-08-31T08:00:00.000Z')
    const snapshot = service.update({
      theme: 'obsidian',
      glassMaterial: 'satin',
      opticalQuality: 'balanced',
      motion: 'reduced',
      sceneReflection: 'neutral'
    }, '2026-08-31T08:01:00.000Z')

    expect(snapshot).toMatchObject({ settings: { theme: 'obsidian', glassMaterial: 'satin' }, effectiveTheme: 'obsidian' })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 1, theme: 'obsidian' })
    service.close()
  })
})
