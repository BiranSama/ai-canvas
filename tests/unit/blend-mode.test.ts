import { describe, expect, it } from 'vitest'
import {
  blendModeLabel,
  blendModeToCanvasOperation,
  blendModeToSvgStyle,
  elementSupportsBlendMode,
  resolveBlendMode
} from '../../src/shared/blend-mode'

describe('Product 1.0 blend mode contract', () => {
  it('maps every approved Scene value exactly and throws instead of silently falling back', () => {
    expect(blendModeToCanvasOperation('normal')).toBe('source-over')
    expect(blendModeToCanvasOperation('multiply')).toBe('multiply')
    expect(blendModeToCanvasOperation('screen')).toBe('screen')
    expect(blendModeToCanvasOperation('overlay')).toBe('overlay')
    expect(blendModeToCanvasOperation('soft-light')).toBe('soft-light')
    expect(() => blendModeToCanvasOperation('difference' as never)).toThrow(/Unsupported blend mode/)
  })

  it('keeps SVG and user-language representations controlled', () => {
    expect(blendModeToSvgStyle('normal')).toBe('')
    expect(blendModeToSvgStyle('soft-light')).toBe(' style="mix-blend-mode:soft-light"')
    expect(blendModeLabel('multiply')).toBe('正片叠底')
    expect(blendModeLabel('screen')).toBe('滤色')
  })

  it('resolves legacy omission to normal while limiting the v1 editing surface', () => {
    expect(resolveBlendMode({})).toBe('normal')
    expect(resolveBlendMode({ blendMode: 'overlay' })).toBe('overlay')
    for (const type of ['text', 'image', 'shape', 'sketch', 'light'] as const) expect(elementSupportsBlendMode(type)).toBe(true)
    for (const type of ['placeholder', 'mask', 'group'] as const) expect(elementSupportsBlendMode(type)).toBe(false)
  })
})
