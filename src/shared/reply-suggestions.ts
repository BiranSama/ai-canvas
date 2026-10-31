/*
 * An Agent reply ends with one line naming what the person might do next:
 * 「下一步：生成图片｜标题再大一点」. The conversation shows those as choices
 * and the rest as the reply.
 */

const NEXT_LINE = /^\s*下一步[：:]\s*(.+?)\s*$/u
const MAX_SUGGESTIONS = 4
const MAX_SUGGESTION_LENGTH = 24

export interface ReplyWithSuggestions {
  readonly text: string
  readonly suggestions: readonly string[]
}

/** The reply without its 下一步 line, and the suggestions on that line; a reply without one is returned as it is. */
export function splitReplySuggestions(reply: string): ReplyWithSuggestions {
  const lines = reply.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (line.trim() === '') continue
    const match = NEXT_LINE.exec(line)
    if (match === null) break
    const suggestions = [...new Set(match[1]!.split(/[｜|]/u).map((part) => part.trim().replace(/[。.]$/u, '')).filter((part) => part !== '' && part.length <= MAX_SUGGESTION_LENGTH))]
      .slice(0, MAX_SUGGESTIONS)
    if (suggestions.length === 0) break
    return { text: lines.slice(0, index).join('\n').trim(), suggestions }
  }
  return { text: reply, suggestions: [] }
}

/** A note added to a reply, before its 下一步 line so the suggestions stay last. */
export function withReplyNote(reply: string, note: string): string {
  const { text, suggestions } = splitReplySuggestions(reply)
  return [text, note, ...suggestions.length === 0 ? [] : [`下一步：${suggestions.join('｜')}`]].filter((part) => part !== '').join('\n\n')
}
