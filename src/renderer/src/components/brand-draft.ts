import { MAX_BANNED_WORDS, MAX_BRAND_COPY, type BrandKitInput, type UserMemorySnapshot } from '../../../shared/user-memory'

/** The brand form as typed: copy one line each, banned words in one field. */
export interface BrandDraft {
  readonly name: string
  readonly colors: readonly string[]
  readonly titleFont: string
  readonly bodyFont: string
  /** One line each. */
  readonly copy: string
  /** Separated by commas, 顿号 or new lines. */
  readonly bannedWords: string
}

export function draftOf(snapshot: UserMemorySnapshot): BrandDraft {
  const { brand } = snapshot
  return { name: brand.name, colors: brand.colors, titleFont: brand.titleFont, bodyFont: brand.bodyFont, copy: brand.copy.join('\n'), bannedWords: brand.bannedWords.join('、') }
}

/** The draft as the brand to save, or what is wrong with it. */
export function brandInputOf(draft: BrandDraft): BrandKitInput | string {
  const copy = draft.copy.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const bannedWords = [...new Set(draft.bannedWords.split(/[,，、;；\n]/).map((word) => word.trim()).filter((word) => word !== ''))]
  if (copy.length > MAX_BRAND_COPY) return `常用文案最多 ${MAX_BRAND_COPY} 条。`
  if (copy.some((line) => line.length > 200)) return '每条常用文案在 200 字以内。'
  if (bannedWords.length > MAX_BANNED_WORDS) return `禁用词最多 ${MAX_BANNED_WORDS} 个。`
  if (bannedWords.some((word) => word.length > 40)) return '每个禁用词在 40 字以内。'
  return { name: draft.name.trim(), colors: [...draft.colors], titleFont: draft.titleFont.trim(), bodyFont: draft.bodyFont.trim(), copy, bannedWords }
}
