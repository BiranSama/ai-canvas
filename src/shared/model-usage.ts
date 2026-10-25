import { z } from 'zod'

/**
 * What the owner pays the text-model vendor, in CNY per million tokens. It is
 * entered by hand and only ever produces an estimate, never an actual cost.
 */
export const llmPricingSchema = z.object({
  inputPerMillionCny: z.number().min(0).max(10_000),
  /** Null when cached input is billed like other input. */
  cachedInputPerMillionCny: z.number().min(0).max(10_000).nullable(),
  outputPerMillionCny: z.number().min(0).max(10_000)
}).strict()

export type LlmPricing = z.infer<typeof llmPricingSchema>

export interface ModelTokenUsage {
  /** All input, cached input included. */
  readonly inputTokens: number
  readonly cachedInputTokens: number
  /** Output, reasoning included: every vendor bills thinking as output. */
  readonly outputTokens: number
}

/** Cache writes are counted at the input price, so vendors that charge extra for them come out slightly low. */
export function estimateModelCostCny(usage: ModelTokenUsage, pricing: LlmPricing): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens)
  const cost = (usage.inputTokens - cached) * pricing.inputPerMillionCny
    + cached * (pricing.cachedInputPerMillionCny ?? pricing.inputPerMillionCny)
    + usage.outputTokens * pricing.outputPerMillionCny
  return Number((cost / 1_000_000).toFixed(6))
}

export interface TurnModelUsage extends ModelTokenUsage {
  readonly calls: number
  /** Null unless every call of the turn reported usage under a set price. */
  readonly estimatedCostCny: number | null
}

function tokenCount(value: number): string {
  if (value < 1_000) return String(value)
  return value < 1_000_000 ? `${(value / 1_000).toFixed(1)}K` : `${(value / 1_000_000).toFixed(2)}M`
}

export function formatTurnModelUsage(usage: TurnModelUsage): string {
  const parts = [
    `文字模型 ${usage.calls} 次`,
    `输入 ${tokenCount(usage.inputTokens)}${usage.cachedInputTokens > 0 ? `（缓存命中 ${tokenCount(usage.cachedInputTokens)}）` : ''}`,
    `输出 ${tokenCount(usage.outputTokens)}`
  ]
  if (usage.estimatedCostCny !== null) {
    parts.push(`估算 ${usage.estimatedCostCny > 0 && usage.estimatedCostCny < 0.01 ? '<¥0.01' : `¥${usage.estimatedCostCny.toFixed(2)}`}`)
  }
  return parts.join(' · ')
}
