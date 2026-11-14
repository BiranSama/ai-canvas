import { z } from 'zod'

/*
 * What the person keeps for every project, on this computer: their brand
 * (name, logo, colours, fonts, copy, words to keep out) and the preferences
 * and facts they confirmed. Project rules and project memory stay in each
 * project; these are read alongside them, as reference, never as rules.
 * Preferences are also learned from use: light signals (no pictures) are
 * summed up now and then into candidates the person confirms or ignores.
 */

export const MAX_BRAND_COLORS = 6
export const MAX_BRAND_COPY = 10
export const MAX_BANNED_WORDS = 30
export const MAX_USER_MEMORIES = 200
export const MAX_PREFERENCE_SIGNALS = 200
/** New signals that make a summary due. */
export const SIGNALS_PER_SUMMARY = 12
/** Candidates a summary may offer. */
export const CANDIDATES_PER_SUMMARY = 3
/** User memories written into a turn's brief. */
export const MEMORIES_PER_BRIEF = 20
/** Projects remembered with the brand turned off. */
export const MAX_PROJECTS_WITHOUT_BRAND = 2_000

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const shortText = (max: number) => z.string().trim().min(1).max(max)

export const brandLogoSchema = z.object({
  /** The file under the brand folder, named by the app. */
  fileName: z.string().regex(/^logo-[0-9a-f-]{36}\.(png|jpg|webp)$/),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  updatedAt: z.string().datetime({ offset: true })
}).strict()

export const brandKitSchema = z.object({
  name: z.string().trim().max(80).default(''),
  logo: brandLogoSchema.nullable().default(null),
  colors: z.array(hexColor).max(MAX_BRAND_COLORS).default([]),
  titleFont: z.string().trim().max(120).default(''),
  bodyFont: z.string().trim().max(120).default(''),
  copy: z.array(shortText(200)).max(MAX_BRAND_COPY).default([]),
  bannedWords: z.array(shortText(40)).max(MAX_BANNED_WORDS).default([])
}).strict()

/** What the settings page saves; the logo has its own calls. */
export const brandKitInputSchema = brandKitSchema.omit({ logo: true })

export const userMemoryKindSchema = z.enum(['preference', 'fact'])

export const userMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  kind: userMemoryKindSchema,
  content: shortText(1_000),
  /** Where it came from: typed in settings, proposed by the Agent, or learned from use; always confirmed. */
  source: z.enum(['user', 'agent', 'learned']),
  enabled: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict()

export const userMemoryCandidateSchema = z.object({
  id: z.string().uuid(),
  kind: userMemoryKindSchema,
  content: shortText(1_000),
  source: z.enum(['agent', 'learned']),
  status: z.enum(['pending', 'confirmed', 'ignored']),
  createdAt: z.string().datetime({ offset: true })
}).strict()

export const preferenceSignalKindSchema = z.enum(['accepted', 'undone', 'redone', 'edited', 'said'])

export const preferenceSignalSchema = z.object({
  kind: preferenceSignalKindSchema,
  /** One line, in the person's language: what they did or said. */
  text: shortText(300),
  at: z.string().datetime({ offset: true })
}).strict()

export const backgroundModelUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Null while some call's price was unknown. */
  estimatedCostCny: z.number().nonnegative().nullable()
}).strict()

export const userMemoryFileSchema = z.object({
  version: z.literal(1),
  brand: brandKitSchema.prefault({}),
  memories: z.array(userMemoryEntrySchema).max(MAX_USER_MEMORIES).default([]),
  candidates: z.array(userMemoryCandidateSchema).max(MAX_USER_MEMORIES).default([]),
  signals: z.array(preferenceSignalSchema).max(MAX_PREFERENCE_SIGNALS).default([]),
  learning: z.object({
    enabled: z.boolean().default(true),
    /** Signals recorded since the last summary. */
    newSignals: z.number().int().nonnegative().default(0),
    lastSummaryAt: z.string().datetime({ offset: true }).nullable().default(null)
  }).strict().prefault({}),
  /** The fast model's calls made outside any turn: naming projects, summing up preferences. */
  backgroundUsage: backgroundModelUsageSchema.default({ calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostCny: 0 }),
  /** Projects where 使用品牌 is off, by id: the brand lives on this computer, so this does too. */
  projectsWithoutBrand: z.array(z.string().min(1).max(200)).max(MAX_PROJECTS_WITHOUT_BRAND).default([])
}).strict()

export type BrandLogo = z.infer<typeof brandLogoSchema>
export type BrandKit = z.infer<typeof brandKitSchema>
export type BrandKitInput = z.infer<typeof brandKitInputSchema>
export type UserMemoryKind = z.infer<typeof userMemoryKindSchema>
export type UserMemoryEntry = z.infer<typeof userMemoryEntrySchema>
export type UserMemoryCandidate = z.infer<typeof userMemoryCandidateSchema>
export type PreferenceSignalKind = z.infer<typeof preferenceSignalKindSchema>
export type PreferenceSignal = z.infer<typeof preferenceSignalSchema>
export type BackgroundModelUsage = z.infer<typeof backgroundModelUsageSchema>
export type UserMemoryFile = z.infer<typeof userMemoryFileSchema>

export function emptyUserMemoryFile(): UserMemoryFile {
  return userMemoryFileSchema.parse({ version: 1 })
}

/** What the renderer sees: everything but the signals' text, which stays in Main. */
export const userMemorySnapshotSchema = z.object({
  brand: brandKitSchema,
  /** A data URL of the logo for the settings page, or null. */
  logoPreview: z.string().max(12_000_000).nullable(),
  memories: z.array(userMemoryEntrySchema),
  candidates: z.array(userMemoryCandidateSchema),
  learning: z.object({
    enabled: z.boolean(),
    signals: z.number().int().nonnegative(),
    newSignals: z.number().int().nonnegative(),
    lastSummaryAt: z.string().datetime({ offset: true }).nullable()
  }),
  backgroundUsage: backgroundModelUsageSchema,
  /** Whether the open project uses the brand; true without one. */
  projectUsesBrand: z.boolean()
})

export type UserMemorySnapshot = z.infer<typeof userMemorySnapshotSchema>

export const userMemoryChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), kind: userMemoryKindSchema, content: shortText(1_000) }).strict(),
  z.object({ action: z.literal('edit'), id: z.string().uuid(), kind: userMemoryKindSchema, content: shortText(1_000) }).strict(),
  z.object({ action: z.literal('enable'), id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('confirm'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('ignore'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('learning'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('clear-signals') }).strict(),
  z.object({ action: z.literal('project-brand'), projectId: z.string().min(1).max(200), enabled: z.boolean() }).strict()
])

export type UserMemoryChange = z.infer<typeof userMemoryChangeSchema>

export const brandLogoInputSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 20 * 1024 * 1024, '图片要在 20MB 以内。')
})

/** The brand as a turn's brief carries it: only what is set. */
export interface BrandBrief {
  readonly name: string | null
  readonly hasLogo: boolean
  readonly colors: readonly string[]
  readonly titleFont: string | null
  readonly bodyFont: string | null
  readonly copy: readonly string[]
  readonly bannedWords: readonly string[]
}

export function brandBrief(brand: BrandKit): BrandBrief | null {
  const brief: BrandBrief = {
    name: brand.name === '' ? null : brand.name,
    hasLogo: brand.logo !== null,
    colors: brand.colors,
    titleFont: brand.titleFont === '' ? null : brand.titleFont,
    bodyFont: brand.bodyFont === '' ? null : brand.bodyFont,
    copy: brand.copy,
    bannedWords: brand.bannedWords
  }
  const empty = brief.name === null && !brief.hasLogo && brief.colors.length === 0 && brief.titleFont === null && brief.bodyFont === null && brief.copy.length === 0 && brief.bannedWords.length === 0
  return empty ? null : brief
}

/** The banned words a text uses, compared without case, in the order the brand lists them. */
export function bannedWordsIn(text: string, bannedWords: readonly string[]): string[] {
  const lower = text.toLocaleLowerCase()
  return bannedWords.filter((word) => word.trim() !== '' && lower.includes(word.trim().toLocaleLowerCase()))
}

/** The brand's lines for a turn's brief, or none. */
export function brandBriefLines(brief: BrandBrief): string[] {
  return [
    ...(brief.name === null ? [] : [`品牌名：${brief.name}`]),
    ...(brief.hasLogo ? ['有 Logo：需要时用 place_result 的 result=logo 放上去。'] : []),
    ...(brief.colors.length === 0 ? [] : [`主色：${brief.colors.join('、')}`]),
    ...(brief.titleFont === null ? [] : [`标题字体：${brief.titleFont}`]),
    ...(brief.bodyFont === null ? [] : [`正文字体：${brief.bodyFont}`]),
    ...(brief.copy.length === 0 ? [] : [`常用文案：${brief.copy.map((line) => `「${line}」`).join(' ')}`]),
    ...(brief.bannedWords.length === 0 ? [] : [`禁用词（画面文字里不要出现）：${brief.bannedWords.join('、')}`])
  ]
}

/**
 * Where a logo goes: inside the box (percent of the canvas, [x, y, width,
 * height]) keeping its shape and centred, or by default a fifth of the
 * width in the top-left corner. Returned as fractions of the canvas.
 */
export function logoPlacement(
  box: readonly [number, number, number, number] | undefined,
  logo: { readonly width: number; readonly height: number },
  canvas: { readonly outputWidth: number; readonly outputHeight: number }
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rotation: number } {
  // The logo's width over its height, measured in fractions of the canvas.
  const aspect = (logo.width / logo.height) * (canvas.outputHeight / canvas.outputWidth)
  const [x, y, width, height] = box ?? [4, 4, 20, Math.min(20, 20 / aspect)]
  const fitted = width / aspect <= height ? { width, height: width / aspect } : { width: height * aspect, height }
  return { x: (x + (width - fitted.width) / 2) / 100, y: (y + (height - fitted.height) / 2) / 100, width: fitted.width / 100, height: fitted.height / 100, rotation: 0 }
}
