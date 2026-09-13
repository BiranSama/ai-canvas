import { describe, expect, it } from 'vitest'
import { creativeBriefV2Schema, creativeContextSchema, createScene } from '../../src/domain'
import { buildCreativePlan, normalizeAgentPlanCreativeBriefs } from '../../src/main/agent'
import { agentPlanSchema } from '../../src/shared/agent'
import { deterministicFixtureIds, fixtureAgentRequest } from '../helpers/semantic-fixtures'

function blankScene() {
  return createScene({
    id: '65000000-0000-4000-8000-000000000001',
    projectId: '65000000-0000-4000-8000-000000000002',
    now: '2026-08-30T11:00:00.000+08:00'
  })
}

describe('Main Creative Brief plan normalization', () => {
  it('normalizes an old model-output contract to v3/v2 before persistence', () => {
    const request = fixtureAgentRequest(blankScene(), '创建一张 4:5 山海封面，主体是远山，先不要生成图片。')
    const built = buildCreativePlan(request, deterministicFixtureIds('65'), '2026-08-30T11:00:00.000+08:00')
    const v2Fields = Object.fromEntries(Object.entries(built.brief).filter(([key]) => ![
      'audience', 'acceptanceCriteria', 'fieldSources', 'supersedesId', 'createdAt'
    ].includes(key)))
    const legacyBrief = creativeBriefV2Schema.parse({ ...v2Fields, version: 2 })
    const legacyContext = creativeContextSchema.parse({
      ...built,
      brief: legacyBrief,
      directions: built.directions?.map((direction) => ({ ...direction, briefId: legacyBrief.id })),
      plan: { ...built.plan, briefId: legacyBrief.id }
    })
    const raw = agentPlanSchema.parse({
      summary: '创建结构化方向',
      response: '已创建结构化方向。',
      nextAction: null,
      tools: [{ kind: 'scene_batch', summary: '创建布局', commands: [{ kind: 'scene.set-creative-context', creativeContext: legacyContext }] }],
      designContract: {
        version: 1,
        brief: legacyBrief,
        directions: legacyContext.directions,
        selectedDirectionId: legacyContext.selectedDirectionId,
        capabilityPackIds: legacyContext.plan.capabilityPackIds
      }
    })
    const normalized = normalizeAgentPlanCreativeBriefs(raw, request, {
      idFactory: deterministicFixtureIds('66'),
      createdAt: '2026-08-30T11:05:00.000+08:00'
    })

    expect(normalized.designContract).toMatchObject({ version: 2, brief: { version: 3, createdAt: '2026-08-30T11:05:00.000+08:00', supersedesId: null } })
    const command = normalized.tools[0]?.kind === 'scene_batch' ? normalized.tools[0].commands[0] : null
    if (command?.kind !== 'scene.set-creative-context' || command.creativeContext === null) throw new Error('Expected normalized Creative Context.')
    expect(command.creativeContext.brief.id).toBe(normalized.designContract?.brief.id)
    expect(command.creativeContext.brief.version).toBe(3)
    if (command.creativeContext.brief.version !== 3) throw new Error('Expected v3.')
    expect(command.creativeContext.brief.fieldSources.some((source) => source.source === 'legacy_unattributed')).toBe(false)
  })
})
