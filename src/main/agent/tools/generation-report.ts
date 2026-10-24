import type { AgentToolContext, AgentToolStep } from './types'
import type { AgentToolPlan } from '../../../shared/agent'

/** Paid or job-related calls report the executor's own message; the loop follows the job. */
export function jobStep(plan: AgentToolPlan, context: AgentToolContext, started: string): AgentToolStep {
  return {
    kind: 'execute',
    plan,
    report: ({ outcome, sceneAfter }) => {
      context.refs.sync(sceneAfter)
      return outcome.ok
        ? { ok: true, summary: started, details: [outcome.message] }
        : { ok: false, summary: outcome.message }
    }
  }
}
