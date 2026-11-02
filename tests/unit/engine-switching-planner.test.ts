import { expect, it } from 'vitest'
import { EngineSwitchingPlanner } from '../../src/main/agent/engine-switching-planner'
import type { PlannerAdapter, PlannerInput, PlannerStepResult } from '../../src/main/agent/planner-adapter'

function engine(name: string, stepwise: boolean, calls: string[], kind: 'tool' | 'complete' = 'complete'): PlannerAdapter {
  return {
    stepwise,
    next: async (input) => {
      calls.push(`${name}:${input.turn.id}:${input.stepIndex}`)
      return { step: kind === 'complete' ? { kind: 'complete', assessment: { status: 'completed', summary: name, notes: [], nextAction: null } } : { kind: 'progress' }, modelTurns: 0 } as unknown as PlannerStepResult
    }
  }
}

const step = (turn: string, stepIndex: number): PlannerInput => ({ turn: { id: turn }, stepIndex } as unknown as PlannerInput)

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

it('keeps the current engine for a turn resumed part way, as after a restart', async () => {
  const calls: string[] = []
  const switcher = new EngineSwitchingPlanner({ 'multi-step': engine('multi', true, calls), 'plan-once': engine('local', false, calls) }, 'multi-step')
  switcher.prefer('plan-once')
  await switcher.next(step('t9', 3), new AbortController().signal)
  expect(calls).toEqual(['multi:t9:3'])
})
