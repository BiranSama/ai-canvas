import { findLocalFont, fontLabel, searchLocalFonts } from '../../../shared/local-fonts'
import type { AgentToolContext } from './types'

/**
 * The installed family a font name refers to, by its English or Chinese
 * name. When the computer's fonts are unknown the name is used as given.
 */
export function resolveFontName(name: string, context: AgentToolContext): { readonly family: string } | { readonly problem: string; readonly hint: string } {
  const fonts = context.fonts ?? []
  if (fonts.length === 0) return { family: name.trim() }
  const font = findLocalFont(fonts, name)
  if (font !== null) return { family: font.family }
  const words = name.trim().split(/\s+/)
  const close = searchLocalFonts(fonts, words[0] ?? '', 5)
  return {
    problem: `这台电脑上没有字体「${name.trim()}」。`,
    hint: close.length > 0 ? `相近的有：${close.map(fontLabel).join('、')}。` : '用第一条消息里「本机字体」列出的名字。'
  }
}
