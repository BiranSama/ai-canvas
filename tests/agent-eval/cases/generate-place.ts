import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'
import { LIMITS } from './shared'

export const GENERATE_PLACE_CASES: readonly AgentEvalCaseInput[] = [
  {
    id: 'generate-place-01',
    category: 'generate_place',
    title: '按现有版式生成前先确认',
    source: 'tests/integration/persistent-agent-generation.test.ts；tests/integration/completion-aggregate-works.test.ts',
    scene: 'perfume-poster-placeholder',
    request: { text: '按现在的版式生成一张晨雾香水的主视觉图' },
    expectsGeneration: true,
    decisions: { generation: 'approve' },
    limits: LIMITS.generate,
    assertions: [
      { kind: 'confirmation_before_generation' },
      { kind: 'paid_generation_requests', min: 1, max: 1 },
      { kind: 'generation_jobs', min: 1, max: 1 },
      { kind: 'unchanged_except', allow: [{ name: '商品占位' }], note: '文字与背景不被改动' }
    ]
  },
  {
    id: 'generate-place-02',
    category: 'generate_place',
    title: '把已有结果放回并替换商品占位',
    source: 'tests/integration/generation-agent-workflow-runtime.test.ts；tests/integration/generation-result-placement.test.ts',
    scene: 'perfume-poster-placeholder',
    setup: { generationResults: [{ prompt: '晨雾香水瓶主视觉，柔和晨光，植物气息' }] },
    request: { text: '把刚生成的那张图放进商品占位里，替换掉占位' },
    limits: LIMITS.generate,
    assertions: [
      { kind: 'replaced_with_image', target: { name: '商品占位' } },
      { kind: 'paid_generation_requests', max: 0 },
      { kind: 'generation_jobs', max: 0, note: '放回已有结果不需要再生成' },
      { kind: 'unchanged_except', allow: [{ name: '商品占位' }] }
    ]
  }
]
