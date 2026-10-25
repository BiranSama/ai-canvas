import { z } from 'zod'

/** plan-once: one model call returns the whole plan. multi-step: one small tool per model step. */
export const agentEngineSchema = z.enum(['plan-once', 'multi-step'])

export const agentEngineSettingSchema = z.object({
  /** What the owner chose; applies from the next project open. */
  selected: agentEngineSchema,
  /** What the open project runs on now. */
  active: agentEngineSchema,
  /** Set when AI_CANVAS_AGENT_ENGINE overrides the stored choice. */
  forcedByEnvironment: z.boolean()
}).strict()

export type AgentEngine = z.infer<typeof agentEngineSchema>
export type AgentEngineSetting = z.infer<typeof agentEngineSettingSchema>
