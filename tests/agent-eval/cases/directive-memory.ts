import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS, NO_PAID_GENERATION, SERIF_FONT_PATTERN } from './shared'

export const DIRECTIVE_MEMORY_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'directive-memory-01',
    category: 'directive_memory',
    title: '“以后标题都用衬线体”作用于新作品',
    source: 'tests/unit/provider-agent-p0.test.ts（规则随请求发送）；tests/integration/generation-agent-workflow-runtime.test.ts（记住→项目规则）',
    scene: 'empty',
    setup: { turns: [{ text: '记住，以后标题都用衬线体' }] },
    request: { text: '做一张 4:5 新品海报，标题『晨雾』，先不要生成图片' },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'directive_present', pattern: '衬线' },
      { kind: 'text_present', text: '晨雾' },
      { kind: 'property_matches', select: { textIncludes: '晨雾' }, property: 'fontFamily', pattern: SERIF_FONT_PATTERN },
      NO_PAID_GENERATION
    ]
  },
  {
    id: 'directive-memory-02',
    category: 'directive_memory',
    title: '“每张海报底部放品牌名”作用于新作品',
    source: 'tests/fixtures/completion-artwork.ts（AUREL 品牌）',
    scene: 'empty',
    setup: { turns: [{ text: '记住：以后每张海报底部都要放品牌名 AUREL' }] },
    request: { text: '做一张 3:4 秋季新品海报，标题『秋日微光』，先不要生成图片' },
    limits: LIMITS.layout,
    assertions: [
      { kind: 'directive_present', pattern: 'AUREL' },
      { kind: 'canvas_aspect', width: 3, height: 4 },
      { kind: 'text_present', text: '秋日微光' },
      { kind: 'text_present', text: 'AUREL' },
      NO_PAID_GENERATION
    ]
  }
]
