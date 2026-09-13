import { describe, expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import {
  builtInCapabilityPacks,
  buildCreativePlan,
  buildLocalRefineTool,
  CompletionAssessor,
  DeterministicMockPlanner
} from '../../src/main/agent'
import { createSemanticFixtureScene, deterministicFixtureIds, fixtureAgentRequest, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'

function blankScene() {
  return createScene({
    id: '39000000-0000-4000-8000-000000000001',
    projectId: '39000000-0000-4000-8000-000000000002',
    now: '2026-08-22T00:00:00.000Z'
  })
}

describe('AH1 S6 design capability', () => {
  it('registers bounded built-in packs for the eight design themes and review', () => {
    expect(new Set(builtInCapabilityPacks.map((pack) => pack.theme))).toEqual(new Set([
      'product', 'portrait', 'architecture', 'botanical', 'abstract', 'album', 'coffee', 'landscape', 'general'
    ]))
    expect(builtInCapabilityPacks.find((pack) => pack.id === 'design-review')).toBeDefined()
    expect(builtInCapabilityPacks.every((pack) => pack.rules.length > 0 && pack.capabilities.length > 0)).toBe(true)
  })

  it.each(SEMANTIC_FIXTURES)('creates a theme-specific editable local sketch for $key', async (fixture) => {
    const built = await createSemanticFixtureScene(blankScene(), fixture)
    const context = built.scene.creativeContext
    expect(context?.brief).toMatchObject({ version: 3, theme: fixture.theme, precision: 'precise' })
    expect(context?.directions).toHaveLength(1)
    expect(context?.plan.capabilityPackIds).toContain('design-review')
    const subject = built.scene.elements.find((element) => element.semanticRole === 'subject')
    expect(subject).toMatchObject({
      type: 'placeholder',
      visualKind: fixture.theme,
      provenance: { origin: 'agent-local' },
      controlIntent: { kind: 'subject', priority: 'must' }
    })
    expect(built.scene.elements.every((element) => element.controlIntent !== undefined && element.provenance?.origin === 'agent-local')).toBe(true)
    expect(built.scene.elements.map((element) => `${element.name} ${element.description}`).join(' ')).not.toContain('香水瓶')
    expect(new Set(built.scene.elements.map((element) => element.semanticRole)).size).toBeGreaterThanOrEqual(5)
    const group = built.scene.elements.find((element) => element.type === 'group')
    expect(group).toMatchObject({ type: 'group', semanticRole: 'subject-assembly', groupId: null })
    if (group?.type !== 'group') throw new Error(`Fixture ${fixture.key} did not create a semantic group.`)
    expect(group.childIds.length).toBeGreaterThanOrEqual(2)
    expect(group.childIds.map((id) => built.scene.elements.find((element) => element.id === id)?.groupId)).toEqual(
      group.childIds.map(() => group.id)
    )
    expect(built.scene.elements.find((element) => element.semanticRole === 'background')?.groupId).toBeNull()
    expect(built.scene.elements.find((element) => element.semanticRole === 'title')?.groupId).toBeNull()
    expect(built.scene.elements.find((element) => element.semanticRole === 'lighting')?.groupId).toBeNull()
  })

  it('models the coffee subject as individually named parts inside one shallow semantic group', async () => {
    const fixture = SEMANTIC_FIXTURES.find((item) => item.key === 'coffee-campaign')!
    const built = await createSemanticFixtureScene(blankScene(), fixture)
    const group = built.scene.elements.find((element) => element.type === 'group')
    if (group?.type !== 'group') throw new Error('Expected a coffee subject group.')
    const childNames = group.childIds.map((id) => built.scene.elements.find((element) => element.id === id)?.name)
    expect(childNames).toEqual(expect.arrayContaining(['陶瓷咖啡杯', '杯柄', '杯碟']))
    expect(built.scene.elements.find((element) => element.name === '主标题')?.groupId).toBeNull()
    expect(built.scene.elements.find((element) => element.name === '晨间侧光')?.groupId).toBeNull()
  })

  it('adds every semantic child before the atomic Group command', async () => {
    const fixture = SEMANTIC_FIXTURES.find((item) => item.key === 'coffee-campaign')!
    const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('44') })
    const plan = await planner.plan(fixtureAgentRequest(blankScene(), fixture.request), new AbortController().signal)
    const tool = plan.tools.find((candidate) => candidate.kind === 'scene_batch')
    if (tool?.kind !== 'scene_batch') throw new Error('Expected a Scene batch.')
    const groupIndex = tool.commands.findIndex((command) => command.kind === 'element.group')
    const group = tool.commands[groupIndex]
    if (group?.kind !== 'element.group') throw new Error('Expected an element.group command.')
    for (const childId of group.elementIds) {
      const addIndex = tool.commands.findIndex((command) => command.kind === 'element.add' && command.element.id === childId)
      expect(addIndex).toBeGreaterThanOrEqual(0)
      expect(addIndex).toBeLessThan(groupIndex)
    }
  })

  it('offers three materially described directions only when the high-value brief is ambiguous', () => {
    const context = buildCreativePlan(
      fixtureAgentRequest(blankScene(), '创建一个视觉封面，主体保持中性，先不要生成图片。'),
      deterministicFixtureIds('39')
    )
    expect(context.brief).toMatchObject({ version: 3, precision: 'ambiguous' })
    expect(context.directions).toHaveLength(3)
    expect(new Set(context.directions?.map((direction) => direction.composition)).size).toBe(3)
    expect(context.directions?.filter((direction) => direction.recommended)).toHaveLength(1)
  })

  it('keeps visual preservation requirements pending independently of structure and text scores', async () => {
    const fixture = SEMANTIC_FIXTURES.find((item) => item.key === 'coffee-campaign')!
    const built = await createSemanticFixtureScene(blankScene(), fixture)
    const request = fixtureAgentRequest(built.scene, fixture.request)
    const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('40') })
    const plan = await planner.plan(fixtureAgentRequest(blankScene(), fixture.request), new AbortController().signal)
    const assessment = new CompletionAssessor().assess({ request, plan, localRefineCount: 0 })
    expect(assessment).toMatchObject({ recommendation: 'needs_user_review', localRefineCount: 0 })
    expect(assessment?.unverifiedMust).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining('保留') })]))
    expect(assessment?.design.total).toBeGreaterThanOrEqual(28)
    expect(assessment?.design.entries.find((entry) => entry.dimension === 'text')).toMatchObject({ score: 4 })
    expect(built.scene.elements.find((element) => element.type === 'text')).toMatchObject({
      content: fixture.title,
      accuracy: 'balanced',
      visualWeight: 'secondary',
      renderStrategy: 'standard',
      resultAssetId: null,
      controlIntent: { kind: 'style', priority: 'guide' }
    })
  })

  it('allows at most one no-cost local refine and then asks for user review', async () => {
    const fixture = SEMANTIC_FIXTURES[0]
    const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('41') })
    const plan = await planner.plan(fixtureAgentRequest(blankScene(), fixture.request), new AbortController().signal)
    const broken = fixtureAgentRequest(blankScene(), fixture.request)
    const assessor = new CompletionAssessor()
    const first = assessor.assess({ request: broken, plan, localRefineCount: 0 })
    expect(first).toMatchObject({ recommendation: 'refine_once', localRefineCount: 0 })
    if (first === null) throw new Error('Expected a design assessment.')
    expect(buildLocalRefineTool(broken, plan, first, deterministicFixtureIds('42'))).toBeNull()
    if (plan.designContract?.version !== 2) throw new Error('Expected a Creative Design Contract v2.')
    const contract = plan.designContract
    const exactPlan: typeof plan = {
      ...plan,
      designContract: {
        ...contract,
        brief: {
          ...contract.brief,
          text: contract.brief.text.map((text) => ({ ...text, accuracy: 'strict' as const, mode: 'exact-overlay' as const }))
        }
      }
    }
    const refine = buildLocalRefineTool(broken, exactPlan, first, deterministicFixtureIds('42'))
    expect(refine).toMatchObject({ kind: 'scene_batch', summary: '本地设计精修（仅此一次）' })
    if (refine?.kind !== 'scene_batch') throw new Error('Expected one explicit exact-overlay refinement.')
    expect(refine.commands.filter((command) => command.kind === 'element.add')).toHaveLength(1)
    const afterBudget = assessor.assess({ request: broken, plan, localRefineCount: 1 })
    expect(afterBudget).toMatchObject({ recommendation: 'needs_user_review', localRefineCount: 1 })
    expect(buildLocalRefineTool(broken, exactPlan, afterBudget!, deterministicFixtureIds('43'))).toBeNull()
  })

  it('does not claim clean completion when a verifiable must acceptance criterion fails', async () => {
    const fixture = SEMANTIC_FIXTURES.find((item) => item.key === 'coffee-campaign')!
    const built = await createSemanticFixtureScene(blankScene(), fixture)
    const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('45') })
    const plan = await planner.plan(fixtureAgentRequest(blankScene(), fixture.request), new AbortController().signal)
    if (plan.designContract?.version !== 2) throw new Error('Expected a Creative Design Contract v2.')
    const strictPlan: typeof plan = {
      ...plan,
      designContract: {
        ...plan.designContract,
        brief: {
          ...plan.designContract.brief,
          acceptanceCriteria: [{
            id: '45000000-0000-4000-8000-000000000999',
            criterion: '画布比例保持 1:1',
            priority: 'must'
          }]
        }
      }
    }
    const assessment = new CompletionAssessor().assess({
      request: fixtureAgentRequest(built.scene, fixture.request),
      plan: strictPlan,
      localRefineCount: 1
    })
    expect(assessment?.requirements.find((item) => item.id.startsWith('acceptance:'))).toMatchObject({ status: 'fail' })
    expect(assessment?.recommendation).toBe('needs_user_review')
  })
})
