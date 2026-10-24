import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS, NO_PAID_GENERATION } from './shared'

export const LOOK_ADVISE_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'look-advise-01',
    category: 'look_advise',
    title: '评价选中的生成结果',
    source: 'tests/unit/provider-agent-p0.test.ts（“这张生成的效果怎么样？”）',
    scene: 'generated-result',
    request: { text: '这张生成的效果怎么样？', select: [{ name: '生成结果 · 晨雾主图' }] },
    limits: LIMITS.advise,
    assertions: [
      { kind: 'scene_unchanged', note: '只评价，不改画布' },
      { kind: 'reply_min_length', chars: 20 },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'look-advise-02',
    category: 'look_advise',
    title: '给版式改进建议但不动手',
    source: 'tests/helpers/semantic-fixtures.ts#coffee-campaign',
    scene: 'semantic:coffee-campaign',
    request: { text: '这个版式还有哪些可以改进的地方？先给建议，不要改动画布' },
    limits: LIMITS.advise,
    assertions: [
      { kind: 'scene_unchanged' },
      { kind: 'reply_min_length', chars: 30 },
      { kind: 'reply_matches', pattern: '标题|留白|层级|主体|构图|对齐|字号|间距|色' },
      NO_PAID_GENERATION
    ]
  }
]
