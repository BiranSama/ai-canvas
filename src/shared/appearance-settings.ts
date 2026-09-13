import { z } from 'zod'

export const appearanceThemeSchema = z.enum(['system', 'pearl', 'obsidian', 'dusk'])
export const glassMaterialSchema = z.enum(['crystal', 'satin', 'solid'])
export const opticalQualitySchema = z.enum(['auto', 'fine', 'balanced', 'performance'])
export const appearanceMotionSchema = z.enum(['system', 'full', 'reduced'])
export const sceneReflectionSchema = z.enum(['artwork', 'neutral'])

export const appearanceSettingsUpdateSchema = z.object({
  theme: appearanceThemeSchema,
  glassMaterial: glassMaterialSchema,
  opticalQuality: opticalQualitySchema,
  motion: appearanceMotionSchema,
  sceneReflection: sceneReflectionSchema
})

export const appearanceSettingsSchema = appearanceSettingsUpdateSchema.extend({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime({ offset: true })
})

export const effectiveAppearanceThemeSchema = z.enum(['pearl', 'obsidian', 'dusk'])

export const appearanceSettingsSnapshotSchema = z.object({
  settings: appearanceSettingsSchema,
  effectiveTheme: effectiveAppearanceThemeSchema
})

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = appearanceSettingsSchema.parse({
  schemaVersion: 1,
  theme: 'system',
  glassMaterial: 'crystal',
  opticalQuality: 'auto',
  motion: 'system',
  sceneReflection: 'artwork',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

export function resolveEffectiveAppearanceTheme(
  theme: AppearanceTheme,
  systemTheme: 'light' | 'dark'
): EffectiveAppearanceTheme {
  if (theme === 'system') return systemTheme === 'dark' ? 'obsidian' : 'pearl'
  return theme
}

export type AppearanceTheme = z.infer<typeof appearanceThemeSchema>
export type GlassMaterial = z.infer<typeof glassMaterialSchema>
export type OpticalQuality = z.infer<typeof opticalQualitySchema>
export type AppearanceMotion = z.infer<typeof appearanceMotionSchema>
export type SceneReflection = z.infer<typeof sceneReflectionSchema>
export type AppearanceSettingsUpdate = z.infer<typeof appearanceSettingsUpdateSchema>
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>
export type EffectiveAppearanceTheme = z.infer<typeof effectiveAppearanceThemeSchema>
export type AppearanceSettingsSnapshot = z.infer<typeof appearanceSettingsSnapshotSchema>

