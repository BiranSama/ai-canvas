import type { EvalAgentEngine, EvalCaseContext, EvalEngineDescriptor, EvalObservation } from './engine'
import { runRuntimeCase } from './runtime-driver'

/** Today's engine: one text-model call per turn returns the whole plan. */
export const PLAN_ONCE_ENGINE: EvalEngineDescriptor = {
  id: 'plan-once',
  version: 1,
  label: '整轮一次规划（单次模型调用返回完整计划）'
}

export class PlanOnceEvalEngine implements EvalAgentEngine {
  readonly descriptor = PLAN_ONCE_ENGINE

  runCase(context: EvalCaseContext): Promise<EvalObservation> {
    return runRuntimeCase(context, this.descriptor)
  }
}
