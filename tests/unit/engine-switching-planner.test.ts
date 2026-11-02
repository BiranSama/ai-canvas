import { expect, it } from 'vitest'
import { EngineSwitchingPlanner } from '../../src/main/agent/engine-switching-planner'
import type { PlannerAdapter, PlannerInput, PlannerStepResult } from '../../src/main/agent/planner-adapter'
import type { AgentItem } from '../../src/shared/agent-harness'

function engine(name: string, stepwise: boolean, calls: string[], kind: 'tool' | 'complete' = 'complete'): PlannerAdapter {
  return {
    stepwise,
    next: async (input) => {
      calls.push(`${name}:${input.turn.id}:${input.stepIndex}`)
      return { step: kind === 'complete' ? { kind: 'complete', assessment: { status: 'completed', summary: name, notes: [], nextAction: null } } : { kind: 'progress' }, modelTurns: 0 } as unknown as PlannerStepResult
    }
  }
}

const plan = (turn: string, trace: boolean): AgentItem => ({
  id: `${turn}-plan`, turnId: turn, type: 'plan',
  payload: { step: trace ? { kind: 'tool', trace: { version: 1, promptVersion: 'test', refs: {}, assistants: [], results: [], emitted: null, usage: [], brief: null, checkpoint: null } } : { kind: 'tool' } }
} as unknown as AgentItem)
const step = (turn: string, stepIndex: number, items: AgentItem[] = []): PlannerInput => ({ turn: { id: turn }, stepIndex, items } as unknown as PlannerInput)

it('gives each new turn the engine preferred now, and lets a turn under way finish on its own', async () => {
  const calls: string[] = []
  let multiStepDone = false
  const multi: PlannerAdapter = {
    stepwise: true,
    next: async (input) => {
      calls.push(`multi:${input.turn.id}:${input.stepIndex}`)
      return { step: multiStepDone ? { kind: 'complete', assessment: { status: 'completed', summary: 'm', notes: [], nextAction: null } } : { kind: 'progress' }, modelTurns: 1 } as unknown as PlannerStepResult
    }
  }
  const switcher = new EngineSwitchingPlanner({ 'multi-step': multi, 'plan-once': engine('local', false, calls) }, 'plan-once')
  expect(switcher.engine).toBe('plan-once')
  expect(switcher.stepwise).toBe(false)

  await switcher.next(step('t1', 0), new AbortController().signal)
  // A text model was set up: the next turn, and only it, works step by step.
  switcher.prefer('multi-step')
  expect(switcher.engine).toBe('multi-step')
  expect(switcher.stepwise).toBe(true)
  await switcher.next(step('t2', 0), new AbortController().signal)
  // The key is removed mid-turn: that turn keeps going step by step until it completes.
  switcher.prefer('plan-once')
  expect(switcher.engine).toBe('multi-step')
  multiStepDone = true
  await switcher.next(step('t2', 1), new AbortController().signal)
  expect(switcher.engine).toBe('plan-once')
  await switcher.next(step('t3', 0), new AbortController().signal)
  expect(calls).toEqual(['local:t1:0', 'multi:t2:0', 'multi:t2:1', 'local:t3:0'])
})

it('resumes a started turn on the engine it started on, also after reopening', async () => {
  const calls: string[] = []
  // Reopened after the text model was set up: new turns go step by step.
  const reopened = new EngineSwitchingPlanner({ 'multi-step': engine('multi', true, calls), 'plan-once': engine('local', false, calls) }, 'multi-step')
  const localTurn = [plan('t7', false)]
  expect(reopened.stepwiseFor(localTurn)).toBe(false)
  await reopened.next(step('t7', 1, localTurn), new AbortController().signal)
  // Reopened after the key was removed: a step-by-step turn still finishes step by step.
  const removed = new EngineSwitchingPlanner({ 'multi-step': engine('multi', true, calls), 'plan-once': engine('local', false, calls) }, 'plan-once')
  const stepwiseTurn = [plan('t8', true)]
  expect(removed.stepwiseFor(stepwiseTurn)).toBe(true)
  expect(removed.stepwiseFor([])).toBe(false)
  await removed.next(step('t8', 0, stepwiseTurn), new AbortController().signal)
  await removed.next(step('t9', 0), new AbortController().signal)
  expect(calls).toEqual(['local:t7:1', 'multi:t8:0', 'local:t9:0'])
})
