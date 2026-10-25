import { describe, expect, it } from 'vitest'
import { GenerationPolicy } from '../../src/main/agent/generation-policy'
import { decisionFor } from '../../src/main/agent/persistent-agent-loop'
import type { AgentPlan, AgentRequest } from '../../src/shared/agent'

const canvas = { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, backgroundColor: '#f7f5ef', transparent: false, globalStyle: '' }

function request(text: string, elementCount: number): AgentRequest {
  const { aspectWidth, aspectHeight, outputWidth, outputHeight, globalStyle } = canvas
  return {
    text,
    sceneSummary: { revision: 3, canvas: { aspectWidth, aspectHeight, outputWidth, outputHeight, globalStyle }, elementCount, elements: [] },
    selectedIds: [], selectedElements: [], attachments: [], ephemeralAnnotation: null,
    autoGenerate: false, activeGenerationJobId: null
  }
}

function canvasPlan(aspectWidth: number, aspectHeight: number): AgentPlan {
  return {
    summary: '调整画布', response: '已调整', nextAction: null,
    tools: [{ kind: 'scene_batch', summary: '调整画布', commands: [{ kind: 'scene.set-canvas', canvas: { ...canvas, aspectWidth, aspectHeight, globalStyle: '安静的灰蓝色' } }] }]
  }
}

describe('aspect-ratio decision', () => {
  it('does not ask for a ratio when an existing composition is restyled at the same ratio', () => {
    expect(decisionFor(request('把背景调成安静的灰蓝色', 3), canvasPlan(4, 5), new GenerationPolicy())).toBeNull()
  })

  it('asks when the plan would change the ratio of an existing composition', () => {
    expect(decisionFor(request('把背景调成安静的灰蓝色', 3), canvasPlan(1, 1), new GenerationPolicy())).toMatchObject({
      kind: 'aspect_ratio', defaultOptionId: '1:1'
    })
  })

  it('asks when a new composition is laid out without a stated ratio', () => {
    expect(decisionFor(request('做一张咖啡店开业海报', 0), canvasPlan(4, 5), new GenerationPolicy())).toMatchObject({
      kind: 'aspect_ratio', defaultOptionId: '4:5'
    })
  })

  it('never asks when the person stated the ratio', () => {
    expect(decisionFor(request('做一张 1:1 的咖啡店海报', 0), canvasPlan(1, 1), new GenerationPolicy())).toBeNull()
  })
})
