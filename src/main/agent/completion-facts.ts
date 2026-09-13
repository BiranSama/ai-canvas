import type { AgentPlan, AgentRequest, AgentToolOutcome, AgentToolPlan } from '../../shared/agent'
import { agentCompletionAssessmentSchema, type AgentCompletionAssessment } from '../../shared/agent-harness'
import { completionFactsSchema } from '../../shared/design-capability'
import { creativeDesignContractSchema } from '../../domain'
import { atomicAspectCriterion, CompletionAssessor, designAssessmentNotes } from './design-capability'

const readKinds = new Set(['scene.get_summary', 'scene.get_elements'])
const requestedWork = /(?:^|[。！？\n])\s*(?:(?:请|请帮我|帮我|麻烦|现在|我想|希望)\s*)?(?:创建|生成|制作|画一|添加|删除|修改|调整|移动|替换|导出|撤销|重做|把[^。！？\n]{1,100}(?:改成|改为|删掉|移到|替换))/u
const claimedWork = /(?:已经|已|成功)(?:为你|帮你|完成)?\s*(?:修改|生成|导出|添加|删除|创建|替换|移动|撤销|重做)|(?:图片|画布|导出|修改)(?:已经|已)?完成/u

export function explicitAspectRevision(text: string): { width: number; height: number } | null {
  // Interpret the whole message, never an isolated sentence from a quotation,
  // question, negation, or subsequently withdrawn instruction.
  const match = text.trim().match(/^(?:请)?(?:将|把)?(?:画布)?比例(?:从\s*\d{1,3}\s*[:：]\s*\d{1,3})?\s*(?:改为|改成|调整为|换成)\s*(\d{1,3})\s*[:：]\s*(\d{1,3})(?:[。.]\s*(?:其他要求保留|其他保持不变|其余保持不变))?[。.]?$/u)
  if (match === null) return null
  const width = Number(match[1]); const height = Number(match[2])
  return width >= 1 && width <= 100 && height >= 1 && height <= 100 ? { width, height } : null
}

/** Rebuilt in Main from observed outcomes and the current authoritative Scene. */
export function assessHonestCompletion(input: {
  readonly request: AgentRequest
  readonly plan: AgentPlan | null
  readonly priorPlans?: readonly AgentPlan[]
  readonly remainingWorkDeclined?: boolean
  readonly aspectRevision?: { readonly width: number; readonly height: number; readonly userItemId: string; readonly text: string }
  readonly outcomes: readonly AgentToolOutcome[]
  readonly observedTools?: readonly { readonly tool: AgentToolPlan; readonly outcome: AgentToolOutcome }[]
  readonly resultIds: readonly string[]
  readonly generationJobsCreated: number
  readonly proposed: AgentCompletionAssessment
}): AgentCompletionAssessment {
  const { request, plan, outcomes, proposed } = input
  const revision = input.aspectRevision
  const assess = (candidate: AgentPlan) => {
    const contract = candidate.designContract
    const projected = revision === undefined || contract === undefined ? candidate : { ...candidate, designContract: creativeDesignContractSchema.parse({
      ...contract, brief: { ...contract.brief, aspectPreference: { width: revision.width, height: revision.height },
        ...(contract.brief.version === 3 ? { acceptanceCriteria: contract.brief.acceptanceCriteria.filter(criterion => atomicAspectCriterion(criterion.criterion) === null) } : {}) }
    }) }
    return new CompletionAssessor().assess({ request, plan: projected, localRefineCount: proposed.design?.localRefineCount ?? 0, generationJobsCreated: input.generationJobsCreated })
  }
  let design = plan === null ? null : assess(plan)
  // Recovery is not a user decision to waive earlier must criteria. Recheck
  // every persisted contract against today's Scene, retaining unknowns/failures.
  const previous = (input.priorPlans ?? []).map(assess).filter(candidate => candidate !== null)
  const priorMust = previous.flatMap(candidate => candidate.requirements.filter(check => check.label.startsWith('必须：')))
  const allUnknown = [...new Map([...(design?.unverifiedMust ?? []), ...previous.flatMap(candidate => candidate.unverifiedMust ?? [])]
    .map(check => [`${check.label}:${check.reason}`, check])).values()]
  const revisionCheck = revision === undefined ? [] : [{ id: `user-aspect:${revision.userItemId}`, label: `必须：画布比例保持${revision.width}:${revision.height}`,
    status: request.sceneSummary.canvas.aspectWidth === revision.width && request.sceneSummary.canvas.aspectHeight === revision.height ? 'pass' as const : 'fail' as const,
    evidence: [`用户明确修订：${revision.text}`.slice(0, 500)] }]
  const allRequirements = [...new Map([...revisionCheck, ...(design?.requirements ?? []), ...priorMust].map(check => [`${check.label}:${check.status}:${check.evidence.join('\n')}`, check])).values()]
  const overflow = allUnknown.length > 100 || allRequirements.length > 100
  const overflowNotice = { id: 'retained-requirements-overflow', label: '必须：其余历史要求逐项复核', reason: `本轮累计 ${allRequirements.length} 项检查，超过单份回执容量；全部计划仍保留，尚未接受。` }
  const unverifiedMust = overflow ? [...allUnknown.slice(0, 99), overflowNotice] : allUnknown
  if (design !== null) design = { ...design, unverifiedMust,
    requirements: overflow ? [...allRequirements.slice(0, 99), { id: overflowNotice.id, label: overflowNotice.label, status: 'warning', evidence: [overflowNotice.reason] }] : allRequirements,
    ...(unverifiedMust.length > 0 || priorMust.some(check => check.status === 'fail') ? { recommendation: 'needs_user_review' as const } : {}) }
  const observed = input.observedTools ?? outcomes.map(outcome => ({ tool: plan?.tools[outcome.toolIndex], outcome }))
  const hasObservedWork = observed.some(({ tool, outcome }) => {
    if (!outcome.ok || (tool !== undefined && readKinds.has(tool.kind))) return false
    return outcome.batchId !== null || outcome.jobId !== null || outcome.affectedElementIds.length > 0 || (tool !== undefined && !readKinds.has(tool.kind))
  })
  const expectsWork = requestedWork.test(request.text) || claimedWork.test(proposed.summary) || plan?.tools.some((tool) => !readKinds.has(tool.kind)) === true
  const missing = expectsWork && !hasObservedWork && input.remainingWorkDeclined !== true
  const hasStructureFailure = revisionCheck.some(check => check.status === 'fail') || priorMust.some(check => check.status === 'fail') || (design !== null && [...design.requirements, ...design.structure].some((entry) => entry.status === 'fail'))
  const hasVisualScope = revision !== undefined || design !== null || observed.some(({ outcome }) => outcome.ok && (outcome.batchId !== null || outcome.jobId !== null))
  const facts = completionFactsSchema.parse({ version: 1,
    operationStatus: missing ? 'missing' : hasObservedWork ? 'completed' : 'not_requested',
    structureStatus: design === null && revision === undefined ? 'not_checked' : hasStructureFailure ? 'failed' : 'passed',
    visualStatus: hasVisualScope ? 'needs_user_review' : 'not_checked',
    unverifiedMust, scope: hasVisualScope ? { sceneRevision: request.sceneSummary.revision, resultIds: [...new Set(input.resultIds)] } : null,
    userAcceptance: null
  })
  if (missing) return agentCompletionAssessmentSchema.parse({
    status: 'needs_user_review', summary: '本轮没有可核对的作品修改、生成或导出记录；请求尚未执行。',
    notes: ['请继续执行或明确只需解释；现有作品保持可验证状态。'], nextAction: '继续完成原要求', facts,
    ...(design === null ? {} : { design })
  })
  const needsReview = unverifiedMust.length > 0 || hasStructureFailure || design?.recommendation === 'needs_user_review' || outcomes.some((outcome) => !outcome.ok)
  const priorLabels = proposed.design === undefined ? [] : [...proposed.design.requirements, ...proposed.design.structure].map((entry) => `${entry.label}：`)
  const currentNotes = design === null ? [] : designAssessmentNotes(design)
  return agentCompletionAssessmentSchema.parse({ status: design === null ? proposed.status : design.design.total < 32 ? 'completed_with_notes' : 'completed',
    summary: design === null || input.remainingWorkDeclined === true ? proposed.summary : '本轮操作已执行，结构检查通过；视觉效果仍待你复核。', nextAction: proposed.nextAction,
    ...(needsReview ? { status: 'needs_user_review', summary: unverifiedMust.length
      ? `本轮操作已结束；${unverifiedMust.length} 项必需要求等待复核：${unverifiedMust.map((item) => item.label.replace(/^必须：/u, '')).join('；')}`.slice(0, 4000)
      : '本轮操作已结束；仍有检查未通过，请核对当前作品。' } : {}),
    notes: [...new Set([...proposed.notes.filter((note) => !priorLabels.some((label) => note.startsWith(label))), ...currentNotes])].slice(0, 100),
    ...(design === null ? {} : { design }), facts
  })
}
