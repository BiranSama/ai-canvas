import { z } from 'zod'
import type { AgentToolRisk } from '../../../shared/agent-tools'
import { STATIC_AGENT_TOOL_REGISTRY } from '../agent-tool-registry'
import type { LlmToolCall, LlmToolDefinition } from '../llm/transcript'
import { addLightTool } from './add-light'
import { addMaskTool } from './add-mask'
import { addShapeTool } from './add-shape'
import { addSubjectTool } from './add-subject'
import { addTextTool } from './add-text'
import { arrangeTool } from './arrange'
import { askUserTool } from './ask-user'
import { cancelGenerationTool } from './cancel-generation'
import { editImageTool } from './edit-image'
import { fillTool } from './fill'
import { generateTool } from './generate'
import { groupTool } from './group'
import { inspectTool } from './inspect'
import { loadManualTool } from './load-manual'
import { lookTool } from './look'
import { maskLayerTool } from './mask-layer'
import { mergeLayersTool } from './merge'
import { placeResultTool } from './place-result'
import { blendTool } from './blend'
import { rememberTool } from './remember'
import { removeTool } from './remove'
import { reorderTool } from './reorder'
import { setCanvasTool } from './set-canvas'
import { rejected, type AgentToolContext, type AgentToolSpec, type AgentToolStep } from './types'
import { undoTool } from './undo'
import { updateTool } from './update'
import { viewResultTool } from './view-result'

/** Every small tool, in the order the model sees them. */
export const AGENT_TOOLS: readonly AgentToolSpec<never>[] = [
  lookTool, inspectTool, viewResultTool,
  setCanvasTool, addTextTool, addShapeTool, updateTool, arrangeTool, reorderTool, groupTool, mergeLayersTool, fillTool, maskLayerTool, removeTool,
  addSubjectTool, addLightTool, addMaskTool, undoTool,
  generateTool, editImageTool, placeResultTool, blendTool, cancelGenerationTool,
  askUserTool, rememberTool, loadManualTool
] as readonly AgentToolSpec<unknown>[] as readonly AgentToolSpec<never>[]

export function findAgentTool(name: string): AgentToolSpec<unknown> | null {
  return (AGENT_TOOLS.find((tool) => tool.name === name) ?? null) as AgentToolSpec<unknown> | null
}

/** Tools offered this step: no image editing without images, no generation without a service. */
export function availableAgentTools(context: AgentToolContext): readonly AgentToolSpec<unknown>[] {
  return (AGENT_TOOLS as readonly AgentToolSpec<unknown>[]).filter((tool) => tool.available?.(context) ?? true)
}

export function agentToolRisk(tool: Pick<AgentToolSpec<unknown>, 'registryName'>): AgentToolRisk {
  return STATIC_AGENT_TOOL_REGISTRY.require(tool.registryName).risk
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = { ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) } as Record<string, unknown>
  delete generated.$schema
  return generated
}

const definitionCache = new Map<string, LlmToolDefinition>()

/** The definitions sent to the model; the protocol adapters translate them per vendor. */
export function llmToolDefinitions(tools: readonly AgentToolSpec<unknown>[]): readonly LlmToolDefinition[] {
  return tools.map((tool) => {
    const cached = definitionCache.get(tool.name)
    if (cached !== undefined) return cached
    const definition = { name: tool.name, description: tool.description, parameters: jsonSchema(tool.parameters) }
    definitionCache.set(tool.name, definition)
    return definition
  })
}

function issueText(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.length === 0 ? '参数' : issue.path.join('.')}：${issue.message}`).join('；')
}

/**
 * Turns one model tool call into a step. Unknown tools, broken JSON and invalid
 * arguments come back as failed results the model can correct, never as
 * exceptions that end the turn.
 */
export async function prepareAgentToolCall(call: LlmToolCall, context: AgentToolContext): Promise<{
  readonly tool: AgentToolSpec<unknown> | null
  readonly args: unknown
  readonly step: AgentToolStep
}> {
  const tool = findAgentTool(call.name)
  if (tool === null || !(tool.available?.(context) ?? true)) {
    return {
      tool: null,
      args: null,
      step: rejected(`没有可用的工具 ${call.name}。`, `可用的工具：${availableAgentTools(context).map((candidate) => candidate.name).join('、')}`)
    }
  }
  if (call.arguments === null) {
    return {
      tool,
      args: null,
      step: rejected(
        call.argumentsError === 'incomplete' ? '参数没有写完整，可能是输出被截断。' : '参数不是合法的 JSON 对象。',
        '重新调用，参数写成一个完整的 JSON 对象；内容较多时拆成几次调用。'
      )
    }
  }
  const parsed = tool.parameters.safeParse(call.arguments)
  if (!parsed.success) return { tool, args: call.arguments, step: rejected(`参数不对：${issueText(parsed.error)}`) }
  return { tool, args: parsed.data, step: await tool.prepare(parsed.data, context) }
}
