import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { SEMANTIC_FIXTURES } from '../../helpers/semantic-fixtures'
import { LIMITS, NO_PAID_GENERATION, SUBJECT_SELECTION } from './shared'

function semanticRequest(key: (typeof SEMANTIC_FIXTURES)[number]['key']): string {
  const fixture = SEMANTIC_FIXTURES.find((candidate) => candidate.key === key)
  if (fixture === undefined) throw new Error(`Unknown semantic fixture ${key}.`)
  return fixture.request
}

export const NEW_LAYOUT_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'new-layout-01',
    category: 'new_layout',
    title: '一句话新建 4:5 新品海报',
    source: 'WP1 任务书示例；晨雾商品海报见 tests/fixtures/completion-artwork.ts',
    scene: 'empty',
    request: { text: '做一张 4:5 新品海报，标题『晨雾』' },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 4, height: 5 },
      { kind: 'text_present', text: '晨雾' },
      { kind: 'no_overlap', a: { textIncludes: '晨雾' }, b: [...SUBJECT_SELECTION], maxOverlap: 0.05, ifPresent: true, note: '标题不压主体' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'new-layout-02',
    category: 'new_layout',
    title: '3:2 建筑海报',
    source: 'tests/helpers/semantic-fixtures.ts#architecture-poster',
    scene: 'empty',
    request: { text: semanticRequest('architecture-poster') },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 3, height: 2 },
      { kind: 'text_present', text: 'OPEN SPACE' },
      { kind: 'element_exists', select: [...SUBJECT_SELECTION, { nameIncludes: '美术馆' }], min: 1, note: '有可独立调整的主体' },
      { kind: 'no_overlap', a: { textIncludes: 'OPEN SPACE' }, b: [...SUBJECT_SELECTION], maxOverlap: 0.05, ifPresent: true },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'new-layout-03',
    category: 'new_layout',
    title: '1:1 黑胶唱片封面',
    source: 'tests/helpers/semantic-fixtures.ts#album-vinyl',
    scene: 'empty',
    request: { text: semanticRequest('album-vinyl') },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 1, height: 1 },
      { kind: 'text_present', text: 'ECHO FIELD' },
      { kind: 'element_exists', select: [{ type: 'shape' }, { type: 'placeholder' }, { type: 'image' }, { type: 'sketch' }], min: 2, note: '唱片与声波是独立视觉层' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'new-layout-04',
    category: 'new_layout',
    title: '4:5 人物编辑海报保留右侧留白',
    source: 'tests/helpers/semantic-fixtures.ts#portrait-editorial',
    scene: 'empty',
    request: { text: semanticRequest('portrait-editorial') },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 4, height: 5 },
      { kind: 'text_present', text: 'QUIET FORM' },
      { kind: 'element_exists', select: [...SUBJECT_SELECTION, { nameIncludes: '人物' }], min: 1 },
      { kind: 'no_overlap', a: { textIncludes: 'QUIET FORM' }, b: [...SUBJECT_SELECTION], maxOverlap: 0.05, ifPresent: true },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'new-layout-05',
    category: 'new_layout',
    title: '9:16 竖版活动海报含主副标题',
    source: '活动海报常见版式；文字层级规则见 src/main/agent/ark-agent-planner.ts 第 11 条',
    scene: 'empty',
    request: { text: '做一张 9:16 手机竖版活动海报，标题『周末市集』，副标题『5月18日 · 河畔草坪』，先不要生成图片' },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 9, height: 16 },
      { kind: 'text_present', text: '周末市集' },
      { kind: 'text_present', text: '河畔草坪' },
      { kind: 'no_overlap', a: { textIncludes: '周末市集' }, b: { textIncludes: '河畔草坪' }, maxOverlap: 0.02, note: '主副标题互不遮挡' },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'new-layout-06',
    category: 'new_layout',
    title: '4:5 山海封面的近中远景',
    source: 'tests/helpers/semantic-fixtures.ts#landscape-cover；tests/integration/completion-aggregate-works.test.ts',
    scene: 'empty',
    request: { text: semanticRequest('landscape-cover') },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'canvas_aspect', width: 4, height: 5 },
      { kind: 'text_present', text: '山海之间' },
      { kind: 'element_exists', select: [{ type: 'shape' }, { type: 'placeholder' }, { type: 'image' }, { type: 'sketch' }], min: 2, note: '景深分层' },
      NO_PAID_GENERATION
    ]
  }
]
