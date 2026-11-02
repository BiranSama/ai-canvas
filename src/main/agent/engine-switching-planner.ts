import type { AgentEngine } from '../../shared/agent-engine'
import type { AgentItem } from '../../shared/agent-harness'
import { traceOf } from './multi-step/trace'
import type { AgentPlannerAttemptContext } from './planner'
import type { PlannerAdapter, PlannerInput, PlannerStepResult } from './planner-adapter'

/** The engine a started turn ran on, read from its items: only step-by-step plans keep a model trace. */
function startedOn(items: readonly AgentItem[]): AgentEngine | null {
  if (!items.some((item) => item.type === 'plan')) return null
  return items.some((item) => traceOf(item) !== null) ? 'multi-step' : 'plan-once'
}

/**
 * Lets a project change engines without reopening: new turns take the engine
 * preferred now, and a turn that has started keeps the one it started on,
 * also after the project is reopened, so a text model set up or removed
 * mid-project applies from the next turn.
 */
export class EngineSwitchingPlanner implements PlannerAdapter {
  readonly #engines: Readonly<Record<AgentEngine, PlannerAdapter>>
  #preferred: AgentEngine
  #current: AgentEngine
  /** The turn the current engine is serving; null between turns. */
  #turnId: string | null = null

  constructor(engines: Readonly<Record<AgentEngine, PlannerAdapter>>, initial: AgentEngine) {
    this.#engines = engines
    this.#preferred = initial
    this.#current = initial
  }

  /** The engine the next new turn takes. */
  prefer(engine: AgentEngine): void {
    this.#preferred = engine
  }

  /** The engine a new turn takes; a turn that has started is asked about with stepwiseFor. */
  get engine(): AgentEngine {
    return this.#preferred
  }

  get stepwise(): boolean {
    return this.#engines[this.engine].stepwise === true
  }

  stepwiseFor(turnId: string | null, items: readonly AgentItem[]): boolean {
    return this.#engines[this.#engineFor(turnId, items)].stepwise === true
  }

  async next(input: PlannerInput, signal: AbortSignal, context?: AgentPlannerAttemptContext): Promise<PlannerStepResult> {
    if (input.turn.id !== this.#turnId) {
      this.#current = this.#engineFor(input.turn.id, input.items)
      this.#turnId = input.turn.id
    }
    const result = await this.#engines[this.#current].next(input, signal, context)
    if (result.step.kind === 'complete') this.#turnId = null
    return result
  }

  /** The turn being served keeps its engine; another started turn, its own; a new one, the preferred. */
  #engineFor(turnId: string | null, items: readonly AgentItem[]): AgentEngine {
    if (turnId !== null && turnId === this.#turnId) return this.#current
    return startedOn(items) ?? this.#preferred
  }
}
