import { expect, it } from 'vitest'
import { splitReplySuggestions, withReplyNote } from '../../src/shared/reply-suggestions'

it('takes the next steps off the end of a reply as choices', () => {
  expect(splitReplySuggestions('排好了 4:5 的版式。\n下一步：生成图片｜标题再大一点｜换一种配色')).toEqual({
    text: '排好了 4:5 的版式。', suggestions: ['生成图片', '标题再大一点', '换一种配色']
  })
  // Half-width punctuation, a trailing full stop and blank lines after it are read the same way.
  expect(splitReplySuggestions('好了。\n\n下一步: 生成图片 | 换个颜色。\n\n')).toEqual({ text: '好了。', suggestions: ['生成图片', '换个颜色'] })
})

it('leaves a reply without a next-step line, or with one in the middle, as it is', () => {
  expect(splitReplySuggestions('标题放大了一些。')).toEqual({ text: '标题放大了一些。', suggestions: [] })
  const middle = '下一步：先看看效果\n然后再决定要不要生成。'
  expect(splitReplySuggestions(middle)).toEqual({ text: middle, suggestions: [] })
})

it('keeps at most four short, distinct choices', () => {
  const long = '这一个建议写得太长了已经超过了二十四个字的上限所以不算'
  expect(splitReplySuggestions(`好了。\n下一步：A｜B｜A｜${long}｜C｜D｜E`).suggestions).toEqual(['A', 'B', 'C', 'D'])
})

it('adds a note before the next-step line, so the suggestions stay last', () => {
  expect(withReplyNote('排好了版式。\n下一步：生成图片｜换个颜色', '还有 1 项要你看一下。'))
    .toBe('排好了版式。\n\n还有 1 项要你看一下。\n\n下一步：生成图片｜换个颜色')
  expect(withReplyNote('排好了版式。', '还有 1 项要你看一下。')).toBe('排好了版式。\n\n还有 1 项要你看一下。')
})
