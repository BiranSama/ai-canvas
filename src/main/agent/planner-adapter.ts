import { agentPlanSchema, agentRequestSchema, agentToolPlanSchema, type AgentPlan, type AgentRequest, type AgentToolPlan } from '../../shared/agent'
import { agentFailureEnvelopeSchema, type AgentFailureEnvelope } from '../../shared/agent-recovery'
import { plannerStepSchema, type AgentItem, type AgentTurn, type PlannerStep } from '../../shared/agent-harness'
import type { ContextManifest } from '../../shared/agent-context'
import type { AgentPlanner, AgentPlannerAttemptContext } from './planner'
import { buildLocalRefineTool, CompletionAssessor, designAssessmentNotes } from './design-capability'

function itemPayload(item: AgentItem | undefined): Record<string, unknown> | null {
  return item !== undefined && typeof item.payload === 'object' && item.payload !== null ? item.payload as Record<string, unknown> : null
}

function failRecoveryPlan(message: string): never {
  throw Object.assign(new Error(message), { code: 'MODEL_ACTION_PLAN_EMPTY' })
}

/**
 * A repaired response is never allowed to turn already committed tools back
 * into pending work. The replacement plan therefore contains only the failed
 * and unstarted remainder; committed results stay linked to the prior plan.
 */
function remainingRecoveryPlan(
  candidate: AgentPlan,
  failure: AgentFailureEnvelope | null,
  items: readonly AgentItem[]
): AgentPlan {
  if (failure === null || failure.schemaVersion !== 2 || failure.replacementScope === 'none') return candidate
  const latestRecovery = [...items].reverse().find((item) => item.type === 'recovery' && item.status === 'completed')
  const priorPlan = latestRecovery === undefined
    ? undefined
    : [...items].reverse().flatMap((item): AgentPlan[] => {
        if (item.type !== 'plan' || item.status !== 'completed' || item.ordinal >= latestRecovery.ordinal) return []
        const parsed = agentPlanSchema.safeParse(itemPayload(item)?.plan)
        return parsed.success ? [parsed.data] : []
      })[0]
  if (priorPlan === undefined) return candidate

  const completed = new Set(failure.completedToolIndexes)
  const completedFingerprints = new Set(
    priorPlan.tools.filter((_tool, index) => completed.has(index)).map((tool) => JSON.stringify(tool))
  )
  const candidateLooksFull = candidate.tools.length === priorPlan.tools.length
  const safeCandidate = candidate.tools.filter((tool, index) => {
    if (candidateLooksFull && completed.has(index)) return false
    return !completedFingerprints.has(JSON.stringify(tool))
  })

  if (failure.replacementScope === 'arguments_only' || failure.replacementScope === 'single_tool') {
    const pendingPrior = priorPlan.tools.filter((_tool, index) => !completed.has(index))
    const failedIndex = failure.failedToolIndex ?? failure.unstartedToolIndexes[0] ?? completed.size
    const replacement = candidateLooksFull ? candidate.tools[failedIndex] : safeCandidate[0]
    if (replacement === undefined) failRecoveryPlan('修复响应没有返回失败工具的安全替代项。')
    const pendingIndexes = priorPlan.tools.flatMap((_tool, index) => completed.has(index) ? [] : [index])
    const failedOffset = pendingIndexes.indexOf(failedIndex)
    const tools = failedOffset < 0
      ? [replacement, ...pendingPrior]
      : pendingPrior.map((tool, index) => index === failedOffset ? replacement : tool)
    return agentPlanSchema.parse({ ...candidate, tools })
  }

  if (safeCandidate.length === 0 && (failure.failedToolIndex !== null || failure.unstartedToolIndexes.length > 0)) {
    failRecoveryPlan('修复响应只重复了已经完成的工具，没有可执行的剩余步骤。')
  }
  return agentPlanSchema.parse({ ...candidate, tools: safeCandidate })
}

export interface PlannerInput {
  readonly turn: AgentTurn
  readonly request: AgentRequest
  readonly contextManifest: ContextManifest | null
  readonly items: readonly AgentItem[]
  readonly stepIndex: number
  readonly activePlan: AgentPlan | null
  readonly nextToolIndex: number
}

export interface PlannerStepResult {
  readonly step: PlannerStep
  readonly modelTurns: number
}

export interface PlannerAdapter {
  next(input: PlannerInput, signal: AbortSignal, context?: AgentPlannerAttemptContext): Promise<PlannerStepResult>
}

export function resolvePlannedResult(tool: AgentToolPlan, input: PlannerInput): AgentToolPlan {
  if ((tool.kind !== 'place_generation_result' && tool.kind !== 'result.place_on_canvas') || !tool.resultId.startsWith('generated:')) return tool
  const sourceIndex = Number(tool.resultId.slice('generated:'.length))
  const source = input.activePlan?.tools[sourceIndex]
  if (sourceIndex >= input.nextToolIndex || source === undefined || !['generation', 'canvas_generation', 'canvas_edit'].includes(source.kind)) {
    throw Object.assign(new Error('生成结果引用没有对应的前置图片任务，未修改画布。'), { code: 'GENERATION_RESULT_UNAVAILABLE' })
  }
  const planItem = [...input.items].reverse().find((item) => item.type === 'plan' && item.status === 'completed'
    && JSON.stringify(itemPayload(item)?.plan) === JSON.stringify(input.activePlan))
  const completed = [...input.items].reverse().find((item) => {
    if (item.type !== 'tool_result' || item.status !== 'completed') return false
    const data = itemPayload(item)
    const outcome = data?.outcome as { toolIndex?: number; ok?: boolean; jobId?: string } | undefined
    return planItem !== undefined && data?.planItemId === planItem.id && outcome?.ok === true && outcome.toolIndex === sourceIndex
  })
  const jobId = (itemPayload(completed)?.outcome as { jobId?: string } | undefined)?.jobId
  const results = (input.request.generationResults ?? []).filter((result) => jobId !== undefined && result.jobId === jobId)
  if (results.length !== 1) {
    throw Object.assign(new Error('前置任务尚未提供唯一可用图片结果，未修改画布，也不会重复生图。'), { code: 'GENERATION_RESULT_UNAVAILABLE' })
  }
  return { ...tool, resultId: results[0]!.resultId }
}

export class ScriptedPlannerAdapter implements PlannerAdapter {
  readonly #steps: readonly PlannerStep[]

  constructor(steps: readonly PlannerStep[]) {
    this.#steps = steps.map((step) => plannerStepSchema.parse(step))
  }

  async next(input: PlannerInput, signal: AbortSignal): Promise<PlannerStepResult> {
    if (signal.aborted) throw signal.reason
    const step = this.#steps[input.stepIndex]
    if (step === undefined) {
      return {
        step: plannerStepSchema.parse({
          kind: 'complete',
          assessment: {
            status: 'completed_with_notes',
            summary: 'Scripted planner reached the end of its recorded steps.',
            notes: ['No additional scripted action was available.'],
            nextAction: null
          }
        }),
        modelTurns: 0
      }
    }
    return { step: plannerStepSchema.parse(step), modelTurns: 0 }
  }
}

/**
 * Adapts the deterministic offline creative planner to the persistent step protocol.
 * The complete plan is persisted on the first Tool Item, but only one Tool Step
 * is released to the loop at a time. Renderer code never receives the array.
 */
export class DeterministicCreativePlannerAdapter implements PlannerAdapter {
  readonly #planner: AgentPlanner
  readonly #completionAssessor: CompletionAssessor
  readonly #validatedDrafts = new Map<string, readonly (AgentToolPlan | null)[]>()

  constructor(planner: AgentPlanner, completionAssessor: CompletionAssessor = new CompletionAssessor()) {
    this.#planner = planner
    this.#completionAssessor = completionAssessor
  }

  async next(input: PlannerInput, signal: AbortSignal, context?: AgentPlannerAttemptContext): Promise<PlannerStepResult> {
    const request = agentRequestSchema.parse(input.request)
    const recovery = [...input.items].reverse().flatMap((item): AgentFailureEnvelope[] => {
      if (item.type !== 'recovery' || item.status !== 'completed') return []
      const parsed = agentFailureEnvelopeSchema.safeParse((item.payload as { readonly failure?: unknown }).failure)
      return parsed.success ? [parsed.data] : []
    })[0] ?? null
    let candidate = input.activePlan
    if (candidate === null) {
      if (recovery === null) this.#validatedDrafts.delete(input.turn.id)
      try {
        candidate = agentPlanSchema.parse(await this.#planner.plan(request, signal, recovery, context))
        const validated = this.#validatedDrafts.get(input.turn.id)
        if (validated !== undefined && recovery !== null) {
          const missing = validated.flatMap((tool, index) => tool === null ? [index] : [])
          const isFullReplacement = candidate.tools.length === validated.length
          if (!isFullReplacement && candidate.tools.length !== missing.length) {
            failRecoveryPlan('局部修正的工具数量与失败位置不符；已验证步骤保持不变。')
          }
          candidate = agentPlanSchema.parse({ ...candidate, tools: validated.map((tool, index) =>
            tool ?? candidate!.tools[isFullReplacement ? index : missing.indexOf(index)]
          ) })
        }
        this.#validatedDrafts.delete(input.turn.id)
      } catch (error) {
        if (!this.#validatedDrafts.has(input.turn.id) && typeof error === 'object' && error !== null && 'validatedTools' in error && Array.isArray(error.validatedTools)) {
          const tools = error.validatedTools.slice(0, 12).map((tool) => {
            const parsed = agentToolPlanSchema.safeParse(tool)
            return parsed.success ? parsed.data : null
          })
          if (tools.some((tool) => tool !== null) && tools.some((tool) => tool === null)) {
            // Bound abandoned turn caches; nothing is persisted across restart.
            if (this.#validatedDrafts.size >= 8) this.#validatedDrafts.delete(this.#validatedDrafts.keys().next().value!)
            this.#validatedDrafts.set(input.turn.id, tools)
          }
        }
        throw error
      }
    }
    const plan = input.activePlan ?? remainingRecoveryPlan(candidate, recovery, input.items)
    const tool = plan.tools[input.nextToolIndex]
    if (tool !== undefined) {
      return {
        step: plannerStepSchema.parse({
          kind: 'tool',
          call: resolvePlannedResult(tool, input),
          toolIndex: input.nextToolIndex,
          plan: input.activePlan === null ? plan : null
        }),
        modelTurns: input.activePlan === null ? 1 : 0
      }
    }
    const localRefineCount = input.items.filter((item) => {
      if (item.type !== 'tool_result' || item.status !== 'completed') return false
      const payload = item.payload as { readonly tool?: { readonly kind?: string; readonly summary?: string } }
      return payload.tool?.kind === 'scene_batch' && payload.tool.summary?.startsWith('本地设计精修') === true
    }).length
    const design = this.#completionAssessor.assess({
      request,
      plan,
      localRefineCount: Math.min(1, localRefineCount)
    })
    if (design?.recommendation === 'refine_once') {
      const refine = buildLocalRefineTool(request, plan, design)
      if (refine !== null) {
        return {
          step: plannerStepSchema.parse({
            kind: 'tool',
            call: refine,
            toolIndex: input.nextToolIndex,
            plan: null
          }),
          modelTurns: 0
        }
      }
    }
    if (design !== null && design.recommendation !== 'complete') {
      return {
        step: plannerStepSchema.parse({
          kind: 'complete',
          assessment: {
            status: 'needs_user_review',
            summary: (design.unverifiedMust?.length ?? 0) > 0
              ? `已完成本轮操作；${design.unverifiedMust!.length} 项必需要求尚待复核：${design.unverifiedMust!.map((item) => item.label.replace(/^必须：/u, '')).join('；')}`.slice(0, 4000)
              : '本轮操作已结束；结构检查仍有待处理项，请检查当前作品。',
            notes: designAssessmentNotes(design),
            nextAction: '请查看画布与方向说明，选择继续调整、接受当前草图或改变设计方向。',
            design
          }
        }),
        modelTurns: 0
      }
    }
    return {
      step: plannerStepSchema.parse({
        kind: 'complete',
        assessment: {
          status: design !== null && design.design.total < 32 ? 'completed_with_notes' : 'completed',
          summary: plan.response,
          notes: design === null ? [] : ['可验证的结构检查通过；视觉效果仍需复核，尚未记录用户接受。'],
          nextAction: plan.nextAction,
          ...(design === null ? {} : { design })
        }
      }),
      modelTurns: input.activePlan === null ? 1 : 0
    }
  }
}

export class AiSdkLockedPlannerAdapter implements PlannerAdapter {
  async next(): Promise<PlannerStepResult> {
    throw new Error('AI_SDK_PLANNER_NOT_CONFIGURED: use the configured Main-process Provider planner for live turns.')
  }
}
