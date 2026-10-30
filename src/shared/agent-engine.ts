import { z } from 'zod'

/** plan-once: one model call returns the whole plan. multi-step: one small tool per model step. */
export const agentEngineSchema = z.enum(['plan-once', 'multi-step'])

export const agentEngineSettingSchema = z.object({
  /** What the open project runs on: multi-step once a text model is set up, plan-once with the local planner before that. */
  active: agentEngineSchema,
  /** Set when AI_CANVAS_AGENT_ENGINE forces the engine. */
  forcedByEnvironment: z.boolean()
}).strict()

export type AgentEngine = z.infer<typeof agentEngineSchema>
export type AgentEngineSetting = z.infer<typeof agentEngineSettingSchema>
