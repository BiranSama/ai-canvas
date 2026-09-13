import {
  DEFAULT_APPEARANCE_SETTINGS,
  appearanceSettingsSnapshotSchema,
  resolveEffectiveAppearanceTheme,
  type AppearanceSettingsSnapshot
} from '../../../shared/appearance-settings'

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
}

export function defaultAppearanceSnapshot(): AppearanceSettingsSnapshot {
  return appearanceSettingsSnapshotSchema.parse({
    settings: DEFAULT_APPEARANCE_SETTINGS,
    effectiveTheme: resolveEffectiveAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS.theme, systemTheme())
  })
}

export function supportsLiquidGlassRefraction(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  return CSS.supports('backdrop-filter', 'blur(1px)')
    && CSS.supports('backdrop-filter', 'url("#ai-liquid-glass-fine") blur(1px)')
}

export function resolveOpticalProjection(snapshot: AppearanceSettingsSnapshot): 'fine' | 'balanced' | 'performance' {
  const requested = snapshot.settings.opticalQuality
  if (requested !== 'auto') return requested
  const cores = navigator.hardwareConcurrency ?? 4
  return supportsLiquidGlassRefraction() && cores >= 8 ? 'fine' : cores >= 4 ? 'balanced' : 'performance'
}

export function applyAppearanceSnapshot(input: AppearanceSettingsSnapshot): AppearanceSettingsSnapshot {
  const snapshot = appearanceSettingsSnapshotSchema.parse(input)
  const root = document.documentElement
  root.dataset.appearanceTheme = snapshot.effectiveTheme
  root.dataset.appearanceThemePreference = snapshot.settings.theme
  root.dataset.glassMaterial = snapshot.settings.glassMaterial
  root.dataset.opticalQuality = resolveOpticalProjection(snapshot)
  root.dataset.opticalQualityPreference = snapshot.settings.opticalQuality
  root.dataset.appearanceMotion = snapshot.settings.motion
  root.dataset.sceneReflection = snapshot.settings.sceneReflection
  root.dataset.glassRefraction = supportsLiquidGlassRefraction() ? 'supported' : 'fallback'
  root.style.colorScheme = snapshot.effectiveTheme === 'pearl' ? 'light' : 'dark'
  return snapshot
}
