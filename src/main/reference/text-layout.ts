/**
 * Line breaking for rendered text, approximating the canvas (Konva) so that a
 * main-process render wraps, truncates and fills boxes like the editor does.
 * Widths are estimated per glyph class; no font files are read.
 */

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

export function glyphWidth(character: string, fontSize: number): number {
  if (WIDE.test(character)) return fontSize
  if (character === ' ') return fontSize * 0.28
  if (/[A-Z]/.test(character)) return fontSize * 0.64
  if (/[a-z]/.test(character)) return fontSize * 0.52
  if (/[0-9]/.test(character)) return fontSize * 0.56
  return fontSize * 0.34
}

export function measureText(text: string, fontSize: number, letterSpacing: number): number {
  const glyphs = [...text]
  return glyphs.reduce((total, glyph) => total + glyphWidth(glyph, fontSize), 0) + Math.max(0, glyphs.length - 1) * letterSpacing
}

export interface TextLine {
  readonly text: string
  /** The last line of its paragraph; justified text leaves it ragged. */
  readonly paragraphEnd: boolean
}

function breakParagraph(paragraph: string, maxWidth: number, fontSize: number, letterSpacing: number, mode: 'word' | 'character'): TextLine[] {
  const lines: TextLine[] = []
  let current = ''
  const push = (text: string): void => {
    lines.push({ text, paragraphEnd: false })
  }
  // Word mode keeps runs of Latin letters together; wide glyphs and spaces may break anywhere.
  const tokens = mode === 'word' ? paragraph.match(/[^\s⺀-鿿豈-﫿＀-￯]+|\s+|./gu) ?? [] : [...paragraph]
  for (const token of tokens) {
    const candidate = current + token
    if (current === '' || measureText(candidate, fontSize, letterSpacing) <= maxWidth) {
      current = candidate
      continue
    }
    push(current.trimEnd())
    current = token.trimStart()
    // A single token wider than the box breaks between glyphs, as the editor does.
    while (current !== '' && measureText(current, fontSize, letterSpacing) > maxWidth) {
      let cut = 1
      while (cut < current.length && measureText(current.slice(0, cut + 1), fontSize, letterSpacing) <= maxWidth) cut += 1
      push(current.slice(0, cut))
      current = current.slice(cut)
    }
  }
  lines.push({ text: current, paragraphEnd: true })
  return lines
}

/**
 * Lines that fit the box. Text that does not fit vertically is cut at the last
 * fitting line, which ends in an ellipsis, so an overflow is visible.
 */
export function layoutTextLines(input: {
  readonly content: string
  readonly fontSize: number
  readonly letterSpacing: number
  readonly lineHeight: number
  readonly width: number
  readonly height: number
  readonly wrapping: 'none' | 'word' | 'character'
  readonly vertical: boolean
}): TextLine[] {
  if (input.vertical) return [...input.content].map((text) => ({ text, paragraphEnd: true }))
  const paragraphs = input.content.split('\n')
  const wrapping = input.wrapping
  const lines = wrapping === 'none'
    ? paragraphs.map((text) => ({ text, paragraphEnd: true }))
    : paragraphs.flatMap((paragraph) => breakParagraph(paragraph, Math.max(input.fontSize, input.width), input.fontSize, input.letterSpacing, wrapping))
  const maxLines = Math.max(1, Math.floor(input.height / (input.fontSize * input.lineHeight) + 0.001))
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]!
  let text = last.text
  while (text.length > 0 && measureText(`${text}…`, input.fontSize, input.letterSpacing) > input.width) text = text.slice(0, -1)
  kept[maxLines - 1] = { text: `${text}…`, paragraphEnd: true }
  return kept
}
