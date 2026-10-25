/** A font family installed on this computer, as the font picker and the agent see it. */
export interface LocalFontFamily {
  /** The name stored on text elements: the English family name, which every renderer matches. */
  readonly family: string
  /** The Chinese name when the font has one, such as 微软雅黑 for Microsoft YaHei. */
  readonly localName: string | null
  /** Style names of the installed faces, such as Regular and Bold. */
  readonly styles: readonly string[]
  /** Whether the font covers Simplified or Traditional Chinese. */
  readonly chinese: boolean
}

/** Every name a family answers to, lower-cased, for matching what a person or the model typed. */
function familyKeys(font: LocalFontFamily): readonly string[] {
  return [font.family, ...(font.localName === null ? [] : [font.localName])].map((name) => name.toLowerCase())
}

/** The installed family a typed name refers to, by its English or Chinese name; null when none matches. */
export function findLocalFont(fonts: readonly LocalFontFamily[], name: string): LocalFontFamily | null {
  const key = name.trim().toLowerCase()
  return fonts.find((font) => familyKeys(font).includes(key)) ?? null
}

/** Families whose names contain the typed text, Chinese fonts first. */
export function searchLocalFonts(fonts: readonly LocalFontFamily[], query: string, limit = Infinity): readonly LocalFontFamily[] {
  const key = query.trim().toLowerCase()
  const matches = key === '' ? [...fonts] : fonts.filter((font) => familyKeys(font).some((name) => name.includes(key)))
  return matches
    .sort((left, right) => Number(right.chinese) - Number(left.chinese) || fontLabel(left).localeCompare(fontLabel(right), 'zh-Hans-CN'))
    .slice(0, limit)
}

/** 微软雅黑 (Microsoft YaHei), or the family alone when it has no Chinese name. */
export function fontLabel(font: LocalFontFamily): string {
  return font.localName === null ? font.family : `${font.localName} (${font.family})`
}
