import type { AgentEngine } from '../../shared/agent-engine'
import type { AgentPlannerAttemptContext } from './planner'
import type { PlannerAdapter, PlannerInput, PlannerStepResult } from './planner-adapter'

/**
 * Lets a project change engines without reopening: new turns take the engine
 * preferred now, and a turn under way keeps the one it started with, so a
 * text model set up or removed mid-project applies from the next turn.
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

  /** The engine of the turn under way, or the one a new turn would take. */
  get engine(): AgentEngine {
    return this.#turnId === null ? this.#preferred : this.#current
  }

  get stepwise(): boolean {
    return this.#engines[this.engine].stepwise === true
  }

  async next(input: PlannerInput, signal: AbortSignal, context?: AgentPlannerAttemptContext): Promise<PlannerStepResult> {
    if (input.turn.id !== this.#turnId) {
      // A turn's first step takes the preferred engine; a turn resumed part way keeps the current one.
      if (input.stepIndex === 0) this.#current = this.#preferred
      this.#turnId = input.turn.id
    }
    const result = await this.#engines[this.#current].next(input, signal, context)
    if (result.step.kind === 'complete') this.#turnId = null
    return result
  }
}
