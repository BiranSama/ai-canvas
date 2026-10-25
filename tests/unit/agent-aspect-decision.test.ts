import { describe, expect, it } from 'vitest'
import { GenerationPolicy } from '../../src/main/agent/generation-policy'
import { decisionFor } from '../../src/main/agent/persistent-agent-loop'
import { statedRatio } from '../../src/main/agent/stated-aspect'
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

  it('never asks when the person stated the ratio, however it was written', () => {
    for (const text of ['做一张 1:1 的咖啡店海报', '做一张 1：1 的咖啡店海报', '做一张 16比9 的横幅', '做一张 16×9 的横幅', '做一张 16 x 9 的横幅']) {
      expect(decisionFor(request(text, 0), canvasPlan(1, 1), new GenerationPolicy()), text).toBeNull()
    }
  })

  it('takes an orientation as stated when the plan follows it, and asks when it does not', () => {
    expect(decisionFor(request('做一张竖版咖啡店海报', 0), canvasPlan(4, 5), new GenerationPolicy())).toBeNull()
    expect(decisionFor(request('做一张横版咖啡店海报', 0), canvasPlan(3, 2), new GenerationPolicy())).toBeNull()
    expect(decisionFor(request('做一张方形头像', 0), canvasPlan(1, 1), new GenerationPolicy())).toBeNull()
    expect(decisionFor(request('做一张横版咖啡店海报', 0), canvasPlan(4, 5), new GenerationPolicy())).toMatchObject({ kind: 'aspect_ratio' })
  })

  it('reads a ratio written in any of the usual ways, and not a pixel size', () => {
    expect(['4:5', '4：5', '16比9', '16 比 9', '16×9', '16x9', '16 X 9'].map(statedRatio)).toEqual([
      { aspectWidth: 4, aspectHeight: 5 }, { aspectWidth: 4, aspectHeight: 5 }, { aspectWidth: 16, aspectHeight: 9 }, { aspectWidth: 16, aspectHeight: 9 },
      { aspectWidth: 16, aspectHeight: 9 }, { aspectWidth: 16, aspectHeight: 9 }, { aspectWidth: 16, aspectHeight: 9 }
    ])
    expect(statedRatio('做一张 1024x1280 的海报')).toBeNull()
    expect(statedRatio('做一张 512x768 的海报')).toBeNull()
    expect(statedRatio('做一张 512x768 的海报，比例 2:3')).toEqual({ aspectWidth: 2, aspectHeight: 3 })
    expect(statedRatio('做一张咖啡海报')).toBeNull()
  })
})
