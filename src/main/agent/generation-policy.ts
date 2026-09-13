import type { AgentPlan, AgentRequest } from '../../shared/agent'

const EXPLICIT_GENERATION = /(?:直接|现在|请)?(?:生成|生图|出图|渲染)(?:一张|图片|图像|成图)?/i
const NEGATED_GENERATION = /(?:不要|不需要|不必|先不|暂不|无需|不用|禁止|别|不)(?:再|继续|立刻|马上|自动|直接|帮我|为我|进行|去){0,3}\s*(?:生成|生图|出图|渲染)/i

export function hasExplicitGenerationInstruction(text: string): boolean {
  return EXPLICIT_GENERATION.test(text) && !NEGATED_GENERATION.test(text)
}

export function hasNegatedGenerationInstruction(text: string): boolean {
  return NEGATED_GENERATION.test(text)
}

export class GenerationPolicy {
  requiresConfirmation(request: AgentRequest, plan: AgentPlan): boolean {
    const hasGeneration = plan.tools.some((tool) => tool.kind === 'generation' || tool.kind === 'canvas_generation' || tool.kind === 'canvas_edit')
    if (!hasGeneration) return false
    if (hasNegatedGenerationInstruction(request.text)) return true
    if (request.autoGenerate) return false
    if (plan.tools.some((tool) => tool.kind === 'canvas_edit')) return false
    return !hasExplicitGenerationInstruction(request.text)
  }
}
