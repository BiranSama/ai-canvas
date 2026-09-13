import {
  authorCreativeBriefV3,
  newCreativeBriefV3Schema,
  projectLegacyBriefToV2,
  type CreativeBrief,
  type CreativeBriefAcceptanceCriterion,
  type CreativeBriefV3,
  type CreativeContext
} from '../../domain'
import { agentPlanSchema, type AgentPlan, type AgentRequest } from '../../shared/agent'

function inferredCriteria(
  brief: Exclude<CreativeBrief, CreativeBriefV3>,
  idFactory: () => string
): CreativeBriefAcceptanceCriterion[] {
  const projected = projectLegacyBriefToV2(brief)
  return [
    ...(projected.aspectPreference === null ? [] : [{
      id: idFactory(),
      criterion: `画布比例保持 ${projected.aspectPreference.width}:${projected.aspectPreference.height}`,
      priority: 'must' as const
    }]),
    ...projected.subjects.map((subject) => ({
      id: idFactory(),
      criterion: `主体“${subject.name}”保留独立可编辑元素`,
      priority: 'must' as const
    })),
    ...projected.text.map((text) => ({
      id: idFactory(),
      criterion: `“${text.content}”按 ${text.mode} 语义保留`,
      priority: text.accuracy === 'strict' ? 'must' as const : 'prefer' as const
    })),
    ...projected.prohibitions.map((item) => ({ id: idFactory(), criterion: `避免${item}`, priority: 'must' as const }))
  ].slice(0, 100)
}

/**
 * Main-authoritative normalization for newly returned model plans. It accepts
 * old model-output contracts for compatibility, but no old or model-authored
 * timestamp is persisted as the current Creative Brief v3 timestamp.
 */
export function normalizeAgentPlanCreativeBriefs(
  plan: AgentPlan,
  request: AgentRequest,
  options: { readonly idFactory: () => string; readonly createdAt: string }
): AgentPlan {
  const explicitRevision = /^\s*(?:修正|修改|更新)当前创作简报[：:]/u.test(request.text)
  const currentBrief = request.sceneSummary.creativeBrief ?? request.sceneSummary.creativeContext?.brief ?? null
  const normalizedByOriginalId = new Map<string, CreativeBriefV3>()

  const normalizeBrief = (brief: CreativeBrief): CreativeBriefV3 => {
    const cached = normalizedByOriginalId.get(brief.id)
    if (cached !== undefined) return cached
    const supersedesId = explicitRevision ? currentBrief?.id ?? null : null
    const id = supersedesId === brief.id ? options.idFactory() : brief.id
    const normalized = brief.version === 3
      ? newCreativeBriefV3Schema.parse({
          ...brief,
          id,
          supersedesId,
          createdAt: options.createdAt
        })
      : authorCreativeBriefV3({
          brief: projectLegacyBriefToV2(brief),
          id,
          supersedesId,
          createdAt: options.createdAt,
          acceptanceCriteria: inferredCriteria(brief, options.idFactory),
          defaultEvidence: request.text,
          fieldSources: [{
            path: '/originalRequirement',
            source: 'user',
            sourceId: null,
            evidence: request.text.slice(0, 1_000)
          }]
        })
    normalizedByOriginalId.set(brief.id, normalized)
    return normalized
  }

  const normalizeContext = (context: CreativeContext): CreativeContext => {
    const brief = normalizeBrief(context.brief)
    return {
      ...context,
      brief,
      directions: context.directions?.map((direction) => ({ ...direction, briefId: brief.id })),
      plan: { ...context.plan, briefId: brief.id }
    }
  }

  const tools = plan.tools.map((tool) => tool.kind !== 'scene_batch'
    ? tool
    : {
        ...tool,
        commands: tool.commands.map((command) => command.kind !== 'scene.set-creative-context' || command.creativeContext === null
          ? command
          : { ...command, creativeContext: normalizeContext(command.creativeContext) })
      })

  const designContract = plan.designContract === undefined
    ? undefined
    : (() => {
        const brief = normalizeBrief(plan.designContract.brief)
        return {
          ...plan.designContract,
          version: 2 as const,
          brief,
          directions: plan.designContract.directions.map((direction) => ({ ...direction, briefId: brief.id }))
        }
      })()

  return agentPlanSchema.parse({ ...plan, tools, designContract })
}
