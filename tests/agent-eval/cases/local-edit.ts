import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS, NO_PAID_GENERATION, SERIF_FONT_PATTERN } from './shared'

const PERFUME_SOURCE = 'tests/fixtures/completion-artwork.ts#completionTypography(product) + completionProduct'

export const LOCAL_EDIT_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'local-edit-01',
    category: 'local_edit',
    title: '标题缩小 20%',
    source: 'tests/helpers/semantic-fixtures.ts#coffee-campaign；缩放规则见 ark-agent-planner.ts 第 16 条',
    scene: 'semantic:coffee-campaign',
    request: { text: '把标题缩小 20%' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'font_size_ratio', select: { type: 'text', role: 'title' }, ratio: 0.8, tolerance: 0.03 },
      { kind: 'text_present', text: 'MORNING RITUAL' },
      { kind: 'unchanged_except', allow: [{ type: 'text', role: 'title' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'local-edit-02',
    category: 'local_edit',
    title: '标题和瓶子互相遮挡时调开',
    source: PERFUME_SOURCE,
    scene: 'perfume-poster-overlap',
    request: { text: '标题和瓶子挡住了，调一下' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'no_overlap', a: { name: '准确主标题' }, b: { name: '香水瓶' }, maxOverlap: 0.02 },
      { kind: 'text_present', text: '晨雾', exact: true },
      { kind: 'unchanged_except', allow: [{ name: '准确主标题' }, { name: '香水瓶' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'local-edit-03',
    category: 'local_edit',
    title: '只把副标题改成白色',
    source: PERFUME_SOURCE,
    scene: 'perfume-poster',
    request: { text: '把副标题的颜色改成白色' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'property_matches', select: { name: '英文副题' }, property: 'fill', pattern: '^(?:#?(?:fff|ffffff)(?:ff)?|white|rgba?\\(\\s*255\\s*,\\s*255\\s*,\\s*255.*)$' },
      { kind: 'unchanged_except', allow: [{ name: '英文副题' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'local-edit-04',
    category: 'local_edit',
    title: '主标题换成衬线体，其他文字不动',
    source: PERFUME_SOURCE,
    scene: 'perfume-poster',
    request: { text: '主标题换成衬线体，其他文字别动' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'property_matches', select: { name: '准确主标题' }, property: 'fontFamily', pattern: SERIF_FONT_PATTERN },
      { kind: 'text_present', text: '晨雾', exact: true },
      { kind: 'unchanged_except', allow: [{ name: '准确主标题' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'local-edit-05',
    category: 'local_edit',
    title: '删除页脚文字',
    source: PERFUME_SOURCE,
    scene: 'perfume-poster',
    request: { text: '删掉页脚那行字' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'element_removed', select: { name: '准确页脚' } },
      { kind: 'text_absent', text: '50 mL' },
      { kind: 'unchanged_except', allow: [{ name: '准确页脚' }] },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'local-edit-06',
    category: 'local_edit',
    title: '香水瓶右移，文字不动',
    source: PERFUME_SOURCE,
    scene: 'perfume-poster',
    request: { text: '把香水瓶往右挪一点，文字都别动' },
    limits: LIMITS.edit,
    assertions: [
      { kind: 'transform_delta', select: { name: '香水瓶' }, dx: { min: 0.005, max: 0.3 }, dy: { min: -0.03, max: 0.03 } },
      { kind: 'unchanged_except', allow: [{ name: '香水瓶' }] },
      NO_PAID_GENERATION
    ]
  }
]
