export type ProductEvalId =
  | 'EVAL-01'
  | 'EVAL-02'
  | 'EVAL-03'
  | 'EVAL-04'
  | 'EVAL-05'
  | 'EVAL-06'
  | 'EVAL-07'
  | 'EVAL-08'
  | 'EVAL-09'
  | 'EVAL-10'
  | 'EVAL-11'
  | 'EVAL-12'

export interface ProductEvalEvidence {
  readonly file: string
  readonly testName: string
  readonly layer: 'unit' | 'integration' | 'source-e2e'
}

export interface ProductEvalScenario {
  readonly id: ProductEvalId
  readonly title: string
  readonly evidence: readonly ProductEvalEvidence[]
  readonly manualBoundary: string
}

export const PRODUCT_1_VITEST_FILES = [
  'tests/integration/product-1-eval-catalog.test.ts',
  'tests/integration/creative-brief-v3-lifecycle.test.ts',
  'tests/integration/task-semantics-lifecycle.test.ts',
  'tests/integration/semantic-draft-lifecycle.test.ts',
  'tests/integration/product-1-reference-and-typography-eval.test.ts',
  'tests/integration/generation-profiles-runtime.test.ts',
  'tests/integration/local-edit-runtime.test.ts',
  'tests/integration/generation-result-placement.test.ts',
  'tests/integration/product-1-eval-recovery.test.ts',
  'tests/integration/product-provider-runtime.test.ts',
  'tests/unit/provider-free-config.test.ts'
] as const

export const PRODUCT_1_E2E_FILES = [
  'tests/e2e/creative-brief-inspection.spec.ts',
  'tests/e2e/structured-composition.spec.ts',
  'tests/e2e/creative-continuity.spec.ts',
  'tests/e2e/temporary-annotation.spec.ts',
  'tests/e2e/task-semantics.spec.ts',
  'tests/e2e/direct-canvas-interactions.spec.ts',
  'tests/e2e/product-1-eval-recovery.spec.ts',
  'tests/e2e/provider-protocol-settings.spec.ts'
] as const

export const PRODUCT_1_EVAL_SCENARIOS: readonly ProductEvalScenario[] = [
  {
    id: 'EVAL-01',
    title: '从一句需求创建商品主视觉',
    evidence: [
      {
        file: 'tests/integration/creative-brief-v3-lifecycle.test.ts',
        testName: 'upgrades a persisted v2 Brief only in an explicit atomic Scene batch and undo restores it exactly',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/creative-brief-inspection.spec.ts',
        testName: 'the current Creative Brief is inspectable and can be corrected through the same conversation',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '真实构图与设计质量仍需用户评分。'
  },
  {
    id: 'EVAL-02',
    title: '需求修正而非重新开始',
    evidence: [
      {
        file: 'tests/integration/task-semantics-lifecycle.test.ts',
        testName: 'keeps the current Brief for continuation but removes it from a new task planner context',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/task-semantics.spec.ts',
        testName: 'explicit task relation and temporary try remain inspectable and isolated',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '模糊自然语言下的任务关系推荐仍需用户确认直觉。'
  },
  {
    id: 'EVAL-03',
    title: '从简单草图建立定性构图',
    evidence: [
      {
        file: 'tests/integration/semantic-draft-lifecycle.test.ts',
        testName: '$key creates, edits, undoes, saves, reopens and compiles references',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/structured-composition.spec.ts',
        testName: 'SD1 creates a shallow semantic Group and supports precise in-group editing',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: 'Mock 草图只证明结构与可编辑性，不证明艺术定性。'
  },
  {
    id: 'EVAL-04',
    title: '同时使用视觉参考与结构参考',
    evidence: [
      {
        file: 'tests/integration/product-1-reference-and-typography-eval.test.ts',
        testName: 'EVAL-04 keeps visual and structural references distinct and degrades hybrid mode honestly',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/creative-continuity.spec.ts',
        testName: 'a continued result records its parent, requested change, preserved facts and image-only reference mode',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '真实模型的参考遵循度需要受限手动验证。'
  },
  {
    id: 'EVAL-05',
    title: '文字作为排版与字效参考',
    evidence: [
      {
        file: 'tests/integration/product-1-reference-and-typography-eval.test.ts',
        testName: 'EVAL-05 treats typography as a restrained reference while preserving the editable Scene text',
        layer: 'integration'
      }
    ],
    manualBoundary: '真实模型是否形成飘逸字效仍需用户审美评分。'
  },
  {
    id: 'EVAL-06',
    title: '草图探索到定稿',
    evidence: [
      {
        file: 'tests/integration/generation-profiles-runtime.test.ts',
        testName: 'persists draft/final profile provenance, simulated estimates, exact results and zero actual cost',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/creative-continuity.spec.ts',
        testName: 'a continued result records its parent, requested change, preserved facts and image-only reference mode',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '真实低成本与定稿档的质量、时延和费用尚未验证。'
  },
  {
    id: 'EVAL-07',
    title: '局部修改且保护其他区域',
    evidence: [
      {
        file: 'tests/integration/local-edit-runtime.test.ts',
        testName: 'retains source, mask, requirement and lineage across failure, retry and cancellation',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/temporary-annotation.spec.ts',
        testName: 'AC-R2-06 retains a failed edit annotation and retries the exact request safely',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '真实图片编辑 Provider 的局部一致性仍需手动验证。'
  },
  {
    id: 'EVAL-08',
    title: '多轮长对话连续性',
    evidence: [
      {
        file: 'tests/integration/task-semantics-lifecycle.test.ts',
        testName: 'runs a 20-turn mixed relation script without leaking old task instructions into a new task',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/task-semantics.spec.ts',
        testName: 'explicit task relation and temporary try remain inspectable and isolated',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '任务语义是否自然仍需用户实体走查。'
  },
  {
    id: 'EVAL-09',
    title: '结果回到画布继续编辑',
    evidence: [
      {
        file: 'tests/integration/generation-result-placement.test.ts',
        testName: 'places a result through Main once, replays by placement id, favorites it, and undoes the exact batch',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/direct-canvas-interactions.spec.ts',
        testName: 'Direct Canvas supports inline editing, viewport conventions, clipboard and focus mode offline',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '实体画布手感和持续精修效率由用户复查。'
  },
  {
    id: 'EVAL-10',
    title: '隔天重开项目继续',
    evidence: [
      {
        file: 'tests/integration/product-1-eval-recovery.test.ts',
        testName: 'reopens one project with Scene, undo, result lineage, project knowledge and the same waiting Agent decision',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/product-1-eval-recovery.spec.ts',
        testName: 'Product 1.0 EVAL-10 restores one complete project through the Renderer IPC bridge after app restart',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '自动化以完整进程重启替代真实隔天等待。'
  },
  {
    id: 'EVAL-11',
    title: '更换 LLM Provider',
    evidence: [
      {
        file: 'tests/unit/provider-free-config.test.ts',
        testName: 'accepts arbitrary labels and models while preserving the two stable credential slot ids',
        layer: 'unit'
      },
      {
        file: 'tests/e2e/provider-protocol-settings.spec.ts',
        testName: 'Provider settings make protocol routing and the real connection confirmation explicit',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '实际供应商兼容性仍需一次受限手动连接验证。'
  },
  {
    id: 'EVAL-12',
    title: '更换图片 Provider',
    evidence: [
      {
        file: 'tests/integration/product-provider-runtime.test.ts',
        testName: 'reconfigures the Main-only image provider and task policy without performing HTTP',
        layer: 'integration'
      },
      {
        file: 'tests/e2e/provider-protocol-settings.spec.ts',
        testName: 'the image module freely configures an explicit protocol and opens directly from Generate',
        layer: 'source-e2e'
      }
    ],
    manualBoundary: '真实图片生成质量、费用和供应商返回差异尚未验证。'
  }
]
