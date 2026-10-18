import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS, NO_PAID_GENERATION } from './shared'

const COMPOSITION = [{ type: 'text' }, { type: 'placeholder' }, { type: 'image' }] as const

export const MULTI_TURN_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'multi-turn-01',
    category: 'multi_turn',
    title: '沿用刚才的构图换一版清晨的光',
    source: 'WP1 任务书示例；指代规则见 ark-agent-planner.ts 第 17 条',
    scene: 'empty',
    setup: { turns: [{ text: '做一张 4:5 香水海报，标题『晨雾』，主体是玻璃香水瓶，先不要生成图片' }] },
    request: { text: '沿用刚才的构图，再试一版清晨的光' },
    limits: LIMITS.multiTurn,
    assertions: [
      { kind: 'canvas_aspect', width: 4, height: 5 },
      { kind: 'text_present', text: '晨雾' },
      { kind: 'scene_changed', note: '光线有可见变化' },
      { kind: 'transform_preserved', select: [...COMPOSITION], tolerance: 0.03, note: '构图沿用' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'multi-turn-02',
    category: 'multi_turn',
    title: '“它的标题”指向上一轮作品',
    source: 'tests/helpers/semantic-fixtures.ts#album-vinyl',
    scene: 'empty',
    setup: { turns: [{ text: '做一张 1:1 唱片封面，标题『ECHO FIELD』，先不要生成图片' }] },
    request: { text: '把它的标题改成『回声田野』，其他保持不变' },
    limits: LIMITS.multiTurn,
    assertions: [
      { kind: 'text_present', text: '回声田野' },
      { kind: 'text_absent', text: 'ECHO FIELD' },
      { kind: 'unchanged_except', allow: [{ textIncludes: 'ECHO FIELD' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'multi-turn-03',
    category: 'multi_turn',
    title: '撤回刚才那一步',
    source: 'tests/integration/generation-result-placement.test.ts（撤销批次）',
    scene: 'empty',
    setup: {
      turns: [
        { text: '做一张 4:5 咖啡海报，标题『晨光拿铁』，先不要生成图片' },
        { text: '把标题放大一点' }
      ]
    },
    request: { text: '撤回刚才那一步' },
    limits: LIMITS.multiTurn,
    assertions: [
      { kind: 'scene_changed', note: '确有撤回动作' },
      { kind: 'scene_unchanged', baseline: { afterSetupTurn: 0 }, note: '回到放大标题之前' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'multi-turn-04',
    category: 'multi_turn',
    title: '“刚才改的那个标题”再上移',
    source: 'tests/helpers/semantic-fixtures.ts#landscape-cover',
    scene: 'semantic:landscape-cover',
    setup: { turns: [{ text: '把标题改成『山与海之间』' }] },
    request: { text: '再把刚才改的那个标题往上挪一点' },
    limits: LIMITS.multiTurn,
    assertions: [
      { kind: 'transform_delta', select: { textIncludes: '山与海之间' }, dy: { min: -0.07, max: -0.003 }, dx: { min: -0.02, max: 0.02 } },
      { kind: 'text_present', text: '山与海之间' },
      { kind: 'unchanged_except', allow: [{ textIncludes: '山与海之间' }] },
      NO_PAID_GENERATION
    ]
  }
]
