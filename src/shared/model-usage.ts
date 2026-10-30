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

/** A token count the way people read it: 900, 12.3K, 1.50M. */
export function tokenCount(value: number): string {
  if (value < 1_000) return String(value)
  return value < 1_000_000 ? `${(value / 1_000).toFixed(1)}K` : `${(value / 1_000_000).toFixed(2)}M`
}

/** The share of input served from the provider's cache, as a whole percentage. */
export function cacheHitPercent(usage: ModelTokenUsage): number {
  return usage.inputTokens === 0 ? 0 : Math.round(Math.min(usage.cachedInputTokens, usage.inputTokens) / usage.inputTokens * 100)
}

export function formatTurnModelUsage(usage: TurnModelUsage): string {
  const parts = [
    `文字模型 ${usage.calls} 次`,
    `输入 ${tokenCount(usage.inputTokens)}${usage.cachedInputTokens > 0 ? `（缓存命中 ${tokenCount(usage.cachedInputTokens)}，${cacheHitPercent(usage)}%）` : ''}`,
    `输出 ${tokenCount(usage.outputTokens)}`
  ]
  if (usage.estimatedCostCny !== null) {
    parts.push(`估算 ${usage.estimatedCostCny > 0 && usage.estimatedCostCny < 0.01 ? '<¥0.01' : `¥${usage.estimatedCostCny.toFixed(2)}`}`)
  }
  return parts.join(' · ')
}

const recordedUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative()
})

/** What a model-calling planner records on each plan item it writes: the calls of that pass and their usage. */
const recordedPassSchema = z.object({
  usage: z.array(recordedUsageSchema).default([]),
  modelCalls: z.number().int().nonnegative().default(0),
  costCny: z.number().nonnegative().nullable().default(null)
})

interface RecordedItem {
  readonly type: string
  readonly payload: unknown
}

function recordedPass(item: RecordedItem): z.infer<typeof recordedPassSchema> | null {
  if (item.type !== 'plan') return null
  const trace = (item.payload as { readonly step?: { readonly trace?: unknown } } | null)?.step?.trace
  if (trace === undefined || trace === null) return null
  const parsed = recordedPassSchema.safeParse(trace)
  return parsed.success ? parsed.data : null
}

/** Token usage and estimated cost of every model call recorded on a turn's items, or null when it made none. */
export function turnModelUsage(items: readonly RecordedItem[]): TurnModelUsage | null {
  const passes = items.flatMap((item) => {
    const pass = recordedPass(item)
    // Passes written before calls were counted still list their usage.
    const calls = pass === null ? 0 : Math.max(pass.modelCalls, pass.usage.length)
    return pass === null || calls === 0 ? [] : [{ pass, calls }]
  })
  if (passes.length === 0) return null
  const usage = passes.flatMap(({ pass }) => pass.usage)
  const costs = passes.map(({ pass }) => pass.costCny)
  return {
    calls: passes.reduce((total, { calls }) => total + calls, 0),
    inputTokens: usage.reduce((total, entry) => total + entry.inputTokens, 0),
    cachedInputTokens: usage.reduce((total, entry) => total + entry.cachedInputTokens, 0),
    outputTokens: usage.reduce((total, entry) => total + entry.outputTokens, 0),
    estimatedCostCny: costs.every((cost): cost is number => cost !== null) ? Number(costs.reduce((total, cost) => total + cost, 0).toFixed(6)) : null
  }
}
