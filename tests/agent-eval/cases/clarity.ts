import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS, NO_PAID_GENERATION } from './shared'

/** A person who has said enough is not asked again; what they left open is decided and said (issue #8, item 2). */
export const CLARITY_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'clarity-01',
    category: 'clarity',
    title: '说清了用途、标题和主体，没说比例：直接做',
    source: 'issue #8 第 2 项；海报默认竖版',
    scene: 'empty',
    request: { text: '做一张咖啡店开业海报，标题『晨光咖啡』，主体是一杯拿铁，暖色调，先不要生成图片' },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'no_question', note: '用途、标题、主体、色调都给了' },
      { kind: 'text_present', text: '晨光咖啡' },
      { kind: 'element_exists', select: [{ role: 'subject' }, { type: 'placeholder' }, { nameIncludes: '拿铁' }], min: 1 },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'clarity-02',
    category: 'clarity',
    title: '上一轮给过的比例和标题不再问',
    source: 'issue #8 第 2 项：已给信息仍被重复追问',
    scene: 'empty',
    setup: { turns: [{ text: '做一张 4:5 的香水海报，标题『晨雾』，先不要生成图片' }] },
    request: { text: '再加一行副标题『清晨第一缕香』，放在标题下面' },
    limits: LIMITS.multiTurn,
    assertions: [
      { kind: 'no_question' },
      { kind: 'canvas_aspect', width: 4, height: 5 },
      { kind: 'text_present', text: '清晨第一缕香' },
      { kind: 'text_present', text: '晨雾' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'clarity-03',
    category: 'clarity',
    title: '口语化的小改动直接改',
    source: 'issue #8 第 2 项',
    scene: 'perfume-poster',
    request: { text: '标题太小了，大一点，颜色换成暖金色' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'no_question' },
      { kind: 'scene_changed' },
      NO_PAID_GENERATION
    ]
  }
]
