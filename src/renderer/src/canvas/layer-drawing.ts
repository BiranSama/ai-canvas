import type { SceneElement } from '../../../domain'

type TextElement = Extract<SceneElement, { type: 'text' }>

export const TEXT_SHADOW_OPACITY = 0.62

/** A text layer's sizes in the box's units, as it is drawn. */
export function textMetrics(element: TextElement, width: number, height: number, outputScale: number): { readonly fontSize: number; readonly letterSpacing: number; readonly strokeWidth: number; readonly shadowBlur: number } {
  return {
    fontSize: Math.min(height * 0.95, Math.max(7, element.fontSize * outputScale)),
    // Letter spacing is in output pixels, like the font size, so it keeps its proportion at any zoom or window size.
    letterSpacing: Math.min(element.letterSpacing * outputScale, width * 0.03),
    strokeWidth: element.strokeWidth * outputScale,
    shadowBlur: element.shadowBlur * outputScale
  }
}

export function textWrap(element: TextElement): 'none' | 'char' | 'word' {
  return element.orientation === 'vertical' ? 'char' : element.wrapping === 'none' ? 'none' : element.wrapping === 'character' ? 'char' : 'word'
}

/** Whether a layer is part of the finished picture: exports draw these, the canvas shows the rest only while editing. */
export function isFinalContent(element: SceneElement): boolean {
  if (element.type === 'sketch') return element.finalVisible
  if (element.type === 'shape') return element.role === 'final'
  return element.type === 'image' || element.type === 'text' || element.type === 'adjustment'
}
