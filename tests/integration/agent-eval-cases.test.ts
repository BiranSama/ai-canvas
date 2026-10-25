import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, type Scene, type SceneCommand } from '../../src/domain'
import {
  AGENT_EVAL_CATEGORY_COUNTS,
  agentEvalCaseSchema,
  selectElements,
  type AgentEvalAssertion,
  type AgentEvalCase,
  type ElementSelection
} from '../../src/main/agent/eval'
import { AGENT_EVAL_CASES } from '../agent-eval/cases'
import { AGENT_EVAL_SCENES } from '../agent-eval/scenes'

async function startingScene(evalCase: AgentEvalCase): Promise<Scene> {
  const empty = createScene({ id: randomUUID(), projectId: randomUUID(), now: '2026-10-18T00:00:00.000Z' })
  const fixture = await AGENT_EVAL_SCENES[evalCase.scene]!({ importImage: async () => ({ id: randomUUID(), width: 512, height: 640 }) })
  if (fixture === null) return empty
  const commands: SceneCommand[] = [
    ...(fixture.canvas === undefined ? [] : [{ kind: 'scene.set-canvas' as const, canvas: fixture.canvas }]),
    ...(fixture.creativeContext === undefined ? [] : [{ kind: 'scene.set-creative-context' as const, creativeContext: fixture.creativeContext }]),
    ...fixture.elements.map((element) => ({ kind: 'element.add' as const, element })),
    ...(fixture.relations ?? []).map((relation) => ({ kind: 'relation.add' as const, relation }))
  ]
  const result = new CommandBus(empty).execute({ id: randomUUID(), origin: 'user', summary: 'eval scene', commands })
  if (!result.ok) throw new Error(`${evalCase.scene}: ${result.error.message}`)
  return result.scene
}

/** Selections an assertion resolves against the scene that exists before the evaluated turn. */
function baselineSelections(assertion: AgentEvalAssertion): readonly ElementSelection[] {
  switch (assertion.kind) {
    case 'unchanged_except': return assertion.allow
    case 'font_size_ratio':
    case 'transform_delta':
    case 'transform_preserved':
    case 'element_removed': return [assertion.select]
    case 'replaced_with_image': return [assertion.target]
    default: return []
  }
}

describe('Phase 1 agent eval set', () => {
  it('holds 27 schema-valid cases in the agreed category mix', () => {
    expect(AGENT_EVAL_CASES).toHaveLength(27)
    expect(new Set(AGENT_EVAL_CASES.map((entry) => entry.id)).size).toBe(27)
    const counts = Object.fromEntries(Object.keys(AGENT_EVAL_CATEGORY_COUNTS).map((category) => [
      category, AGENT_EVAL_CASES.filter((entry) => entry.category === category).length
    ]))
    expect(counts).toEqual(AGENT_EVAL_CATEGORY_COUNTS)
    for (const entry of AGENT_EVAL_CASES) expect(agentEvalCaseSchema.parse(entry)).toEqual(entry)
  })

  it('keeps paid generation to the cases that ask for it and makes every other case assert zero', () => {
    for (const entry of AGENT_EVAL_CASES) {
      const paid = entry.assertions.filter((assertion) => assertion.kind === 'paid_generation_requests')
      expect(paid.length, `${entry.id} states its paid-request expectation`).toBe(1)
      if (entry.expectsGeneration) {
        expect(entry.decisions.generation).toBe('approve')
        expect(entry.assertions.some((assertion) => assertion.kind === 'confirmation_before_generation'), entry.id).toBe(true)
      } else {
        expect(paid[0], entry.id).toMatchObject({ max: 0 })
      }
    }
    expect(AGENT_EVAL_CASES.filter((entry) => entry.expectsGeneration).map((entry) => entry.id)).toEqual(['generate-place-01'])
  })

  it('protects unmentioned objects in every edit of an existing scene', () => {
    for (const entry of AGENT_EVAL_CASES.filter((candidate) => ['local_edit', 'generate_place'].includes(candidate.category) || candidate.id === 'safety-02')) {
      expect(entry.assertions.some((assertion) => assertion.kind === 'unchanged_except'), entry.id).toBe(true)
    }
  })

  it('rejects a case that requires paid requests without approving generation', () => {
    const base = AGENT_EVAL_CASES.find((entry) => entry.id === 'safety-01')!
    expect(() => agentEvalCaseSchema.parse({ ...base, assertions: [{ kind: 'paid_generation_requests', min: 1 }] })).toThrow(/expects generation/)
    expect(() => agentEvalCaseSchema.parse({ ...base, expectsGeneration: true })).toThrow(/approve/)
    expect(() => agentEvalCaseSchema.parse({ ...base, assertions: [{ kind: 'scene_unchanged', baseline: { afterSetupTurn: 0 } }] })).toThrow(/setup turn/)
  })

  it('builds every starting scene from the shared fixtures and resolves each selector the case relies on', async () => {
    for (const entry of AGENT_EVAL_CASES) {
      expect(AGENT_EVAL_SCENES[entry.scene], `${entry.id} scene ${entry.scene}`).toBeTypeOf('function')
      const scene = await startingScene(entry)
      for (const selector of entry.request.select) {
        expect(selectElements(scene, selector).length, `${entry.id} request selection`).toBeGreaterThan(0)
      }
      if (entry.setup.turns.length > 0) continue
      for (const assertion of entry.assertions) {
        for (const selection of baselineSelections(assertion)) {
          const selections = Array.isArray(selection) ? selection : [selection]
          for (const selector of selections) {
            expect(selectElements(scene, selector).length, `${entry.id} ${assertion.kind} ${JSON.stringify(selector)}`).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('starts the overlap repair case with the title really covering the bottle', async () => {
    const scene = await startingScene(AGENT_EVAL_CASES.find((entry) => entry.id === 'local-edit-02')!)
    const title = selectElements(scene, { name: '准确主标题' })[0]!
    const bottle = selectElements(scene, { name: '香水瓶' })[0]!
    expect(title.transform.y + title.transform.height).toBeGreaterThan(bottle.transform.y)
    expect(title.transform.y).toBeLessThan(bottle.transform.y + bottle.transform.height)
  })
})
