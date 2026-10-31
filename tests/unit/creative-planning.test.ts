import { describe, expect, it } from 'vitest'
import { CommandBus, creativeContextSchema, createScene, scenePlanSchema } from '../../src/domain'
import { briefProhibitions, buildCreativePlan, DeterministicMockPlanner } from '../../src/main/agent'
import { deterministicFixtureIds, fixtureAgentRequest, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'

const portrait = SEMANTIC_FIXTURES[0]

function blankScene() {
  return createScene({
    id: '30000000-0000-4000-8000-000000000001',
    projectId: '30000000-0000-4000-8000-000000000002',
    now: '2026-08-14T00:00:00.000Z'
  })
}

describe('CreativeBrief and ScenePlan validation', () => {
  it('normalizes a natural-language request into a complete validated planning context', () => {
    const context = buildCreativePlan(fixtureAgentRequest(blankScene(), portrait.request), deterministicFixtureIds('35'))
    expect(creativeContextSchema.parse(context)).toEqual(context)
    expect(context.brief).toMatchObject({
      theme: 'portrait',
      aspectPreference: { width: 4, height: 5 },
      generationIntent: 'none'
    })
    expect(context.brief.text[0]).toMatchObject({ content: portrait.title, accuracy: 'balanced', mode: 'reference', visualWeight: 'secondary' })
    expect(context.brief.composition).toEqual([expect.objectContaining({ kind: 'above' })])
    expect(context.plan.elements).toHaveLength(7)
    expect(context.plan.elements.every((element) => element.semanticDescription.length > 0)).toBe(true)
    expect(new Set(context.plan.elements.map((element) => element.zIntent)).size).toBe(context.plan.elements.length)
    expect(context.plan.elements.find((element) => element.semanticRole === 'subject')).toMatchObject({
      type: 'placeholder',
      locked: false,
      visualTreatment: { frameShape: 'portrait' }
    })
  })

  it.each([
    ['out-of-bounds geometry', (plan: ReturnType<typeof buildCreativePlan>['plan']) => ({
      ...plan,
      elements: plan.elements.map((element, index) => index === 0 ? { ...element, normalizedBounds: { x: .8, y: 0, width: .4, height: 1 } } : element)
    })],
    ['duplicate layer intent', (plan: ReturnType<typeof buildCreativePlan>['plan']) => ({
      ...plan,
      elements: plan.elements.map((element, index) => index === 1 ? { ...element, zIntent: 0 } : element)
    })],
    ['dangling relation', (plan: ReturnType<typeof buildCreativePlan>['plan']) => ({
      ...plan,
      elements: plan.elements.map((element, index) => index === 1 ? { ...element, relations: [{ id: '35000000-0000-4000-8000-000000000999', kind: 'above' as const, targetElementId: '35000000-0000-4000-8000-000000000998', description: '' }] } : element)
    })],
    ['ordering cycle', (plan: ReturnType<typeof buildCreativePlan>['plan']) => {
      const first = plan.elements[0]!
      const second = plan.elements[1]!
      return {
        ...plan,
        elements: plan.elements.map((element, index) => index === 0
          ? { ...element, relations: [{ id: '35000000-0000-4000-8000-000000000997', kind: 'above' as const, targetElementId: second.id, description: '' }] }
          : index === 1
            ? { ...element, relations: [{ id: '35000000-0000-4000-8000-000000000996', kind: 'above' as const, targetElementId: first.id, description: '' }] }
            : element)
      }
    }]
  ])('rejects %s', (_label, corrupt) => {
    const context = buildCreativePlan(fixtureAgentRequest(blankScene(), portrait.request), deterministicFixtureIds('36'))
    expect(scenePlanSchema.safeParse(corrupt(context.plan)).success).toBe(false)
  })

  it('commits no partial canvas or context state when a plan is invalid', () => {
    const scene = blankScene()
    const context = buildCreativePlan(fixtureAgentRequest(scene, portrait.request), deterministicFixtureIds('37'))
    const invalid = {
      ...context,
      plan: {
        ...context.plan,
        elements: context.plan.elements.map((element, index) => index === 0
          ? { ...element, normalizedBounds: { x: .9, y: 0, width: .2, height: 1 } }
          : element)
      }
    }
    expect(creativeContextSchema.safeParse(invalid).success).toBe(false)
    const bus = new CommandBus(scene)
    const result = bus.execute({
      id: '37000000-0000-4000-8000-000000000999',
      origin: 'agent',
      summary: 'invalid plan must be atomic',
      commands: [
        { kind: 'scene.set-canvas', canvas: context.plan.canvas },
        { kind: 'scene.set-creative-context', creativeContext: invalid }
      ]
    })
    expect(result.ok).toBe(false)
    expect(bus.getScene()).toEqual(scene)
    expect(bus.undoDepth).toBe(0)
  })

  it('keeps prohibitions about the picture and drops the ones that only say when to generate', () => {
    expect(briefProhibitions('先不要生成图片，避免渲染成卡通风格，不要出图了，禁止生成任何图片。')).toEqual(['渲染成卡通风格'])
    expect(briefProhibitions('不要生成人物脸部特写，避免生成文字水印')).toEqual(['生成人物脸部特写', '生成文字水印'])
    const context = buildCreativePlan(
      fixtureAgentRequest(blankScene(), '创建一张 4:5 产品海报，主体是便携音箱，避免渲染成卡通风格。先不要生成图片。'),
      deterministicFixtureIds('38')
    )
    expect(context.brief.version === 3 ? context.brief.prohibitions : []).toEqual(['渲染成卡通风格'])
  })

  it('says a layout will be generated when the plan generates it', async () => {
    const request = '创建一张 4:5 产品海报，主体是便携音箱，标题是 SOFT SIGNAL。'
    const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('39') })
    const plan = await planner.plan(fixtureAgentRequest(blankScene(), request), new AbortController().signal)
    expect(plan.tools.some((tool) => tool.kind === 'canvas_generation')).toBe(true)
    expect(plan.response).toContain('会按这个版式生成图片。')
    expect(plan.response).not.toContain('还没有生成图片')
    expect(plan.response).not.toMatch(/下一步：.*生成图片/u)

    const held = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('3a') })
    const layoutOnly = await held.plan(fixtureAgentRequest(blankScene(), `${request}先不要生成图片。`), new AbortController().signal)
    expect(layoutOnly.tools.some((tool) => tool.kind === 'canvas_generation' || tool.kind === 'generation')).toBe(false)
    expect(layoutOnly.response).toContain('还没有生成图片。')
    expect(layoutOnly.response).toMatch(/下一步：生成图片｜/u)
  })
})
