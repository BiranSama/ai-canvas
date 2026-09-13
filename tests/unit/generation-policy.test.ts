import { describe, expect, it } from 'vitest'
import type { AgentPlan, AgentRequest } from '../../src/shared/agent'
import { GenerationPolicy, hasExplicitGenerationInstruction } from '../../src/main/agent/generation-policy'

function request(text: string, autoGenerate = false): AgentRequest {
  return {
    text,
    sceneSummary: {
      revision: 0,
      canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024, globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    autoGenerate,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

const generationPlan: AgentPlan = {
  summary: '生成图片',
  response: '准备生成。',
  nextAction: null,
  tools: [{
    kind: 'generation',
    request: {
      prompt: 'test',
      negativePrompt: '',
      aspectWidth: 1,
      aspectHeight: 1,
      outputWidth: 1024,
      outputHeight: 1024,
      count: 1,
      providerId: 'mock',
      model: 'mock-balanced',
      references: [],
      parameters: {},
      sourceMessageId: null,
      parentResultId: null,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: ''
    }
  }]
}

describe('agent generation policy', () => {
  it('distinguishes explicit generation from a negated instruction', () => {
    expect(hasExplicitGenerationInstruction('现在生成图片')).toBe(true)
    expect(hasExplicitGenerationInstruction('先不要生成图片')).toBe(false)
    expect(hasExplicitGenerationInstruction('暂不出图，只调整布局')).toBe(false)
  })

  it('requires confirmation for an inferred generation tool unless auto generation is enabled', () => {
    const policy = new GenerationPolicy()
    expect(policy.requiresConfirmation(request('把画面做得更有质感'), generationPlan)).toBe(true)
    expect(policy.requiresConfirmation(request('把画面做得更有质感', true), generationPlan)).toBe(false)
    expect(policy.requiresConfirmation(request('请生成图片'), generationPlan)).toBe(false)
  })

  it.each(['不生成图片', '不需要生成图片', '不要再自动生图', '先不帮我生成图片'])('respects the direct negative instruction %s even when auto generation is enabled', (text) => {
    expect(hasExplicitGenerationInstruction(text)).toBe(false)
    expect(new GenerationPolicy().requiresConfirmation(request(text, true), generationPlan)).toBe(true)
  })

  it('does not mistake a negative style instruction for a prohibition on generating', () => {
    expect(hasExplicitGenerationInstruction('不要深色，现在生成图片')).toBe(true)
  })
})
