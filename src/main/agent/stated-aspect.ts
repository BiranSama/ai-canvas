/*
 * The shape a person asked for, in their words: a ratio such as 4:5, 4：5,
 * 16比9 or 16×9, an orientation (竖版, 横版, 方形), or a format whose shape
 * goes without saying (a poster stands, a banner lies, an avatar is square).
 */

const RATIO = /(?<!\d)(\d{1,3})\s*([:：xX×]|比)\s*(\d{1,3})(?!\d)/g

/** Ratios are written with small numbers; 512x768 is a size in pixels, not a ratio. */
const LARGEST_TIMES_RATIO = 32
/** The canvas takes ratio terms up to this. */
const LARGEST_RATIO = 100

type Shape = 'upright' | 'wide' | 'square'

/** Words that name the shape itself; they win over a format's usual shape. */
const ORIENTATIONS: readonly (readonly [Shape, RegExp])[] = [
  ['upright', /竖版|竖构图|竖屏|竖幅|竖图|竖向|纵向/],
  ['wide', /横版|横构图|横屏|横图|横向/],
  ['square', /正方形|方形|方图/]
]

/** Formats whose shape people take for granted; checked in this order, the most specific first. */
const FORMATS: readonly (readonly [Shape, RegExp])[] = [
  ['square', /头像|唱片封面|专辑封面|商品主图|电商主图|九宫格|图标|logo/i],
  ['wide', /横幅|banner|公众号(?:封面|头图|首图)|头图|电脑壁纸|桌面壁纸|幻灯片|ppt|视频封面|名片|网页|网站/i],
  ['upright', /海报|手机壁纸|锁屏|小红书|抖音|快手|视频号|易拉宝|长图|传单|宣传单|邀请函|书封|书籍封面|杂志封面|菜单/i]
]

/** The first ratio written in the text, or null. */
export function statedRatio(text: string): { readonly aspectWidth: number; readonly aspectHeight: number } | null {
  for (const match of text.matchAll(RATIO)) {
    const aspectWidth = Number(match[1])
    const aspectHeight = Number(match[3])
    const largest = /[xX×]/.test(match[2]!) ? LARGEST_TIMES_RATIO : LARGEST_RATIO
    if (aspectWidth > 0 && aspectHeight > 0 && aspectWidth <= largest && aspectHeight <= largest) return { aspectWidth, aspectHeight }
  }
  return null
}

/** The shape the text names, by orientation or by format, or null. */
function statedShape(text: string): Shape | null {
  for (const [shape, words] of [...ORIENTATIONS, ...FORMATS]) if (words.test(text)) return shape
  return null
}

/** Whether the text already says the picture's shape, given the ratio a plan chose. */
export function statesAspect(text: string, planned: { readonly aspectWidth: number; readonly aspectHeight: number } | undefined): boolean {
  if (statedRatio(text) !== null) return true
  if (planned === undefined) return false
  const { aspectWidth: width, aspectHeight: height } = planned
  const shape = statedShape(text)
  return shape !== null && shape === (height > width ? 'upright' : width > height ? 'wide' : 'square')
}
