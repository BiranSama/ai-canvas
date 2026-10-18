import { describe, expect, it } from 'vitest'
import { layoutTextLines, measureText } from '../../src/main/reference/text-layout'

const base = { fontSize: 20, letterSpacing: 0, lineHeight: 1.2, height: 1_000, vertical: false } as const

describe('rendered text layout', () => {
  it('wraps Chinese between any glyphs and Latin text at spaces, like the editor', () => {
    expect(layoutTextLines({ ...base, content: '晨雾里的第一缕光', width: 85, wrapping: 'word' }).map((line) => line.text))
      .toEqual(['晨雾里的', '第一缕光'])
    expect(layoutTextLines({ ...base, content: 'MORNING MIST EDITION', width: 120, wrapping: 'word' }).map((line) => line.text))
      .toEqual(['MORNING', 'MIST', 'EDITION'])
  })

  it('keeps manual breaks, marks paragraph ends and leaves unwrapped text alone', () => {
    const lines = layoutTextLines({ ...base, content: '第一段很长很长\n第二段', width: 85, wrapping: 'character' })
    expect(lines).toEqual([
      { text: '第一段很', paragraphEnd: false },
      { text: '长很长', paragraphEnd: true },
      { text: '第二段', paragraphEnd: true }
    ])
    expect(layoutTextLines({ ...base, content: '不换行的一整句话', width: 40, wrapping: 'none' })).toHaveLength(1)
  })

  it('cuts text that overflows the box with an ellipsis, so the overflow is visible', () => {
    const lines = layoutTextLines({ ...base, content: '一二三四五六七八九十', width: 85, height: 50, wrapping: 'word' })
    expect(lines.map((line) => line.text)).toEqual(['一二三四', '五六七…'])
  })

  it('counts letter spacing between glyphs', () => {
    expect(measureText('晨雾', 20, 5)).toBe(45)
  })
})
