/*
 * The shape a person asked for, in their words: a ratio such as 4:5, 4：5,
 * 16比9 or 16×9, or an orientation (竖版, 横版, 方形).
 */

const RATIO = /(?<!\d)(\d{1,3})\s*(?:[:：xX×]|比)\s*(\d{1,3})(?!\d)/

/** The first ratio written in the text, or null. */
export function statedRatio(text: string): { readonly aspectWidth: number; readonly aspectHeight: number } | null {
  const match = text.match(RATIO)
  if (match === null) return null
  const aspectWidth = Number(match[1])
  const aspectHeight = Number(match[2])
  return aspectWidth > 0 && aspectHeight > 0 ? { aspectWidth, aspectHeight } : null
}

/** Whether the text already says the picture's shape, given the ratio a plan chose. */
export function statesAspect(text: string, planned: { readonly aspectWidth: number; readonly aspectHeight: number } | undefined): boolean {
  if (statedRatio(text) !== null) return true
  if (planned === undefined) return false
  const { aspectWidth: width, aspectHeight: height } = planned
  if (/竖版|竖构图|竖屏|竖幅|竖图|竖向|纵向/.test(text)) return height > width
  if (/横版|横构图|横屏|横幅|横图|横向/.test(text)) return width > height
  if (/正方形|方形|方图/.test(text)) return width === height
  return false
}
