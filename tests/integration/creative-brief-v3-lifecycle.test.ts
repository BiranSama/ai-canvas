import { describe, expect, it } from 'vitest'
import { CommandBus, creativeBriefV2Schema, creativeContextSchema, createScene } from '../../src/domain'
import { buildCreativePlan, DeterministicMockPlanner } from '../../src/main/agent'
import { deterministicFixtureIds, fixtureAgentRequest } from '../helpers/semantic-fixtures'

function blankScene() {
  return createScene({
    id: '63000000-0000-4000-8000-000000000001',
    projectId: '63000000-0000-4000-8000-000000000002',
    now: '2026-08-30T10:00:00.000+08:00'
  })
}

describe('Creative Brief v3 explicit lifecycle', () => {
  it('upgrades a persisted v2 Brief only in an explicit atomic Scene batch and undo restores it exactly', async () => {
    const source = buildCreativePlan(
      fixtureAgentRequest(blankScene(), '创建一张 4:5 山海封面，主体是远山，标题是 山海之间，先不要生成图片。'),
      deterministicFixtureIds('63'),
      '2026-08-30T10:00:00.000+08:00'
    )
    const v2Fields = Object.fromEntries(Object.entries(source.brief).filter(([key]) => ![
      'audience', 'acceptanceCriteria', 'fieldSources', 'supersedesId', 'createdAt'
    ].includes(key)))
    const v2 = creativeBriefV2Schema.parse({ ...v2Fields, version: 2 })
    const legacyContext = creativeContextSchema.parse({
      ...source,
      brief: v2,
      directions: source.directions?.map((direction) => ({ ...direction, briefId: v2.id })),
      plan: { ...source.plan, briefId: v2.id }
    })
    const base = { ...blankScene(), creativeContext: legacyContext }
    const before = JSON.stringify(base.creativeContext)
    const planner = new DeterministicMockPlanner({
      delayMs: 0,
      idFactory: deterministicFixtureIds('64'),
      now: () => '2026-08-30T10:05:00.000+08:00'
    })
    const plan = await planner.plan(
      fixtureAgentRequest(base, '修正当前创作简报：面向独立出版读者，标题更轻盈，必须保留大面积留白。'),
      new AbortController().signal
    )
    const tool = plan.tools.find((candidate) => candidate.kind === 'scene_batch')
    if (tool?.kind !== 'scene_batch') throw new Error('Expected one explicit Brief revision Scene batch.')
    expect(tool.commands).toHaveLength(1)
    expect(tool.commands[0]).toMatchObject({ kind: 'scene.set-creative-context' })
    if (tool.commands[0]?.kind !== 'scene.set-creative-context' || tool.commands[0].creativeContext === null) throw new Error('Expected revised Creative Context.')
    const revised = tool.commands[0].creativeContext.brief
    expect(revised).toMatchObject({
      version: 3,
      supersedesId: v2.id,
      createdAt: '2026-08-30T10:05:00.000+08:00',
      audience: ['独立出版读者']
    })
    if (revised.version !== 3) throw new Error('Expected Creative Brief v3.')
    expect(revised.fieldSources.find((sourceEntry) => sourceEntry.path === '/purpose')).toMatchObject({ source: 'legacy_unattributed' })
    expect(revised.fieldSources.find((sourceEntry) => sourceEntry.path === '/audience')).toMatchObject({ source: 'user' })
    expect(revised.acceptanceCriteria.at(-1)).toMatchObject({ priority: 'must' })

    const bus = new CommandBus(base, { now: () => '2026-08-30T10:05:00.000+08:00' })
    const committed = bus.execute({
      id: '64000000-0000-4000-8000-000000000999',
      origin: 'agent',
      summary: tool.summary,
      commands: tool.commands
    })
    if (!committed.ok) throw new Error(committed.error.message)
    expect(committed.scene.creativeContext?.brief.version).toBe(3)
    expect(bus.undo()).toBe(committed.batch)
    expect(JSON.stringify(bus.getScene().creativeContext)).toBe(before)
  })
})
