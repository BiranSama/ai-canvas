import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { nativeTheme } from 'electron'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  appearanceSettingsSchema,
  appearanceSettingsSnapshotSchema,
  appearanceSettingsUpdateSchema,
  resolveEffectiveAppearanceTheme,
  type AppearanceSettings,
  type AppearanceSettingsSnapshot,
  type AppearanceSettingsUpdate
} from '../../shared/appearance-settings'

type AppearanceListener = (snapshot: AppearanceSettingsSnapshot) => void

function cloneDefault(now: string): AppearanceSettings {
  return appearanceSettingsSchema.parse({ ...DEFAULT_APPEARANCE_SETTINGS, updatedAt: now })
}

function writeAtomically(filePath: string, settings: AppearanceSettings): void {
  const temporaryPath = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

export class AppearanceSettingsService {
  readonly #filePath: string
  readonly #listeners = new Set<AppearanceListener>()
  #settings: AppearanceSettings

  constructor(filePath: string, now: () => string = () => new Date().toISOString()) {
    this.#filePath = filePath
    this.#settings = this.#read(now())
    this.#applyNativeTheme()
    nativeTheme.on('updated', this.#handleNativeThemeUpdated)
  }

  #read(now: string): AppearanceSettings {
    try {
      return appearanceSettingsSchema.parse(JSON.parse(readFileSync(this.#filePath, 'utf8')))
    } catch {
      return cloneDefault(now)
    }
  }

  #applyNativeTheme(): void {
    nativeTheme.themeSource = this.#settings.theme === 'pearl'
      ? 'light'
      : this.#settings.theme === 'obsidian' || this.#settings.theme === 'dusk'
        ? 'dark'
        : 'system'
  }

  readonly #handleNativeThemeUpdated = (): void => {
    this.#emit()
  }

  snapshot(): AppearanceSettingsSnapshot {
    return appearanceSettingsSnapshotSchema.parse({
      settings: this.#settings,
      effectiveTheme: resolveEffectiveAppearanceTheme(
        this.#settings.theme,
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      )
    })
  }

  update(input: AppearanceSettingsUpdate, now: string = new Date().toISOString()): AppearanceSettingsSnapshot {
    const update = appearanceSettingsUpdateSchema.parse(input)
    const next = appearanceSettingsSchema.parse({ schemaVersion: 1, ...update, updatedAt: now })
    writeAtomically(this.#filePath, next)
    this.#settings = next
    this.#applyNativeTheme()
    this.#emit()
    return this.snapshot()
  }

  subscribe(listener: AppearanceListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }

  close(): void {
    nativeTheme.off('updated', this.#handleNativeThemeUpdated)
    this.#listeners.clear()
  }
}

