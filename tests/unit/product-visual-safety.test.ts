import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../../src/shared/generation'
import { mockSvg } from '../../src/main/generation/mock-image-provider'
import { projectLibraryLocationLabel } from '../../src/renderer/src/components/project-library-label'

const request: GenerationRequest = {
  prompt: '安静的山海封面，柔和雾光，文字只作为轻盈的排版与字效参考，并且保持足够的安全边距',
  negativePrompt: '',
  aspectWidth: 4,
  aspectHeight: 5,
  model: 'mock-balanced',
  providerId: 'mock',
  count: 1,
  outputWidth: 1024,
  outputHeight: 1280,
  parameters: {},
  references: [],
  sourceMessageId: null,
  parentResultId: null,
  referenceMode: 'hybrid',
  variationInstruction: '',
  preserveConstraints: ''
}

describe('Product visual safety helpers', () => {
  it('wraps the offline preview caption inside two bounded SVG lines', () => {
    const svg = mockSvg(request, 0)
    const lines = [...svg.matchAll(/<tspan x="10%"[^>]*>(.*?)<\/tspan>/g)].map((match) => match[1] ?? '')

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => [...line].length <= 24)).toBe(true)
    expect(svg).toContain('y="78%"')
  })

  it('shows a human location label instead of a full local path on the project surface', () => {
    expect(projectLibraryLocationLabel('C:\\Users\\Artist\\Documents\\AI Canvas\\Projects')).toBe('默认项目位置')
    expect(projectLibraryLocationLabel('D:/创作/海报项目')).toBe('海报项目')
  })
})
