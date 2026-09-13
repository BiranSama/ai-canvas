import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  appearanceSettingsSchema,
  appearanceSettingsUpdateSchema,
  resolveEffectiveAppearanceTheme
} from '../../src/shared/appearance-settings'

describe('Appearance Settings v1', () => {
  it('resolves system theme without changing the saved preference', () => {
    expect(DEFAULT_APPEARANCE_SETTINGS).toMatchObject({
      schemaVersion: 1,
      theme: 'system',
      glassMaterial: 'crystal'
    })
    expect(resolveEffectiveAppearanceTheme('system', 'dark')).toBe('obsidian')
    expect(resolveEffectiveAppearanceTheme('system', 'light')).toBe('pearl')
    expect(resolveEffectiveAppearanceTheme('dusk', 'light')).toBe('dusk')
  })

  it('accepts the approved themes and materials and rejects unknown modes', () => {
    expect(appearanceSettingsUpdateSchema.parse({
      theme: 'dusk',
      glassMaterial: 'satin',
      opticalQuality: 'balanced',
      motion: 'reduced',
      sceneReflection: 'neutral'
    })).toMatchObject({ theme: 'dusk', glassMaterial: 'satin' })
    expect(appearanceSettingsSchema.safeParse({
      ...DEFAULT_APPEARANCE_SETTINGS,
      theme: 'neon'
    }).success).toBe(false)
  })
})

