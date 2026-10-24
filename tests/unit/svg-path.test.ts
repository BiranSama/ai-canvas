import { describe, expect, it } from 'vitest'
import { createScene, isClosedPath, normalizeSvgPath, parseSvgPath, pathInBox, sceneSchema, ELEMENT_SCHEMA_VERSION } from '../../src/domain'

function normalized(text: string): string {
  const result = normalizeSvgPath(text)
  if ('error' in result) throw new Error(result.error)
  return result.path
}

describe('free-form shape paths', () => {
  it('turns every command into absolute lines and curves', () => {
    expect(normalized('M10 10 H50 V40 h-20 v-10 z')).toBe('M10 10L50 10L50 40L30 40L30 30Z')
    // Pairs after a move are lines, relative ones relative to the last point.
    expect(normalized('m10,10 20,0 0,20')).toBe('M10 10L30 10L30 30')
    expect(normalized('M0 0 C10 0 20 10 20 20 S30 40 40 40')).toBe('M0 0C10 0 20 10 20 20C20 30 30 40 40 40')
    expect(normalized('M0 0 Q10 20 20 0 T40 0')).toBe('M0 0Q10 20 20 0Q30 -20 40 0')
    expect(normalized('M1e1 .5L-.5 2.25')).toBe('M10 0.5L-0.5 2.25')
  })

  it('draws arcs as cubic curves through the right points', () => {
    const path = normalized('M0 50 A50 50 0 0 1 100 50')
    expect(path.startsWith('M0 50C')).toBe(true)
    expect(path.endsWith(' 100 50')).toBe(true)
    // A half circle splits into two quarter curves; the top of the arc is reached between them.
    expect(path.match(/C/g)).toHaveLength(2)
    expect(path).toContain(' 50 0C')
    // Flags may be written without separators.
    expect(normalized('M0 0a10 10 0 0110 10')).toMatch(/^M0 0C.* 10 10$/)
    expect(normalized('M0 0 A0 10 0 0 1 10 10')).toBe('M0 0L10 10')
  })

  it('explains paths it cannot use', () => {
    expect(parseSvgPath('L10 10')).toEqual({ error: '路径要以 M 开头。' })
    expect(parseSvgPath('M0 0 L10')).toMatchObject({ error: expect.stringContaining('L 缺少数字') })
    expect(parseSvgPath('M0 0 L500 10')).toMatchObject({ error: expect.stringContaining('坐标 500 超出范围') })
    expect(parseSvgPath('M0 0')).toEqual({ error: '路径至少要有一段线或曲线。' })
    expect(parseSvgPath('M0 0 L1 1 Z 5')).toMatchObject({ error: expect.stringContaining('Z 后面多了数字') })
  })

  it('maps the 0–100 box onto the drawn box and knows open from closed outlines', () => {
    expect(pathInBox('M0 0L100 50Z', 200, 80, 10, 20)).toBe('M10 20L210 60Z')
    expect(isClosedPath('M0 0L10 0L10 10Z')).toBe(true)
    expect(isClosedPath('M0 0L10 0L10 10Z M20 20L30 30')).toBe(false)
    expect(isClosedPath('M0 0 C10 0 20 10 20 20')).toBe(false)
  })

  it('refuses a path shape without a usable outline in the scene', () => {
    const base = createScene({ id: '60000000-0000-4000-8000-000000000001', projectId: '60000000-0000-4000-8000-000000000002', now: '2026-10-23T00:00:00.000Z' })
    const shape = {
      id: '60000000-0000-4000-8000-000000000010', version: ELEMENT_SCHEMA_VERSION, type: 'shape', name: '叶子', description: '',
      transform: { x: 0.1, y: 0.1, width: 0.3, height: 0.3, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal', visible: true, locked: false,
      groupId: null, semanticRole: 'content', referencePolicy: 'include', shape: 'path', fill: '#4A7A4A', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
    }
    expect(sceneSchema.safeParse({ ...base, elements: [shape] }).success).toBe(false)
    expect(sceneSchema.safeParse({ ...base, elements: [{ ...shape, path: 'M50 0 L100 100' }] }).success).toBe(true)
    expect(sceneSchema.safeParse({ ...base, elements: [{ ...shape, path: 'nonsense' }] }).success).toBe(false)
  })
})
