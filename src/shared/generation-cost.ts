import { z } from 'zod'

const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const amountSchema = z.number().finite().nonnegative().max(1_000_000)
const evidenceSchema = z.object({
  receiptId: z.string().trim().min(1).max(160),
  observedAt: z.string().datetime({ offset: true })
}).strict()

export const generationActualCostSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown'), amount: z.null(), currency: z.null(),
    source: z.enum(['provider_unreported', 'legacy_unverified']), reason: z.string().min(1).max(500) }).strict(),
  z.object({ status: z.literal('known_free'), amount: z.literal(0), currency: currencySchema,
    source: z.enum(['offline_mock', 'provider_free_receipt']), evidence: evidenceSchema }).strict(),
  z.object({ status: z.literal('actual_known'), amount: amountSchema, currency: currencySchema,
    source: z.literal('provider_receipt'), evidence: evidenceSchema }).strict()
])

export const generationCostEstimateSchema = z.object({
  amount: amountSchema, currency: currencySchema, source: z.enum(['offline_simulation', 'provider_price']),
  estimatedAt: z.string().datetime({ offset: true }),
  parameters: z.object({ profileId: z.string().max(120), model: z.string().max(200), imageCount: z.number().int().min(1).max(128) }).strict()
}).strict()

export const generationCostSchema = z.object({
  version: z.literal(1), actual: generationActualCostSchema, estimate: generationCostEstimateSchema.nullable()
}).strict()
export type GenerationActualCost = z.infer<typeof generationActualCostSchema>
export type GenerationCost = z.infer<typeof generationCostSchema>
export type GenerationCostEstimate = z.infer<typeof generationCostEstimateSchema>
export type ProviderCostReceipt = Extract<GenerationActualCost, { status: 'actual_known' }> | (Extract<GenerationActualCost, { status: 'known_free' }> & { source: 'provider_free_receipt' })

export function unknownGenerationCost(legacy = false): GenerationCost {
  return { version: 1, estimate: null, actual: {
    status: 'unknown', amount: null, currency: null,
    source: legacy ? 'legacy_unverified' : 'provider_unreported',
    reason: legacy ? '历史金额缺少可核对的实际结算证据。' : '服务尚未提供可核对的实际金额；图片数与预约额度不代表扣费。'
  } }
}

export function parseGenerationCost(value: string | null | undefined): GenerationCost {
  if (value == null) return unknownGenerationCost(true)
  try { return generationCostSchema.parse(JSON.parse(value)) } catch { return unknownGenerationCost(true) }
}

export function actualCostCny(cost: GenerationCost): number | null {
  return cost.actual.currency === 'CNY' ? cost.actual.amount : null
}

export function formatGenerationCost(cost: GenerationCost | undefined): string {
  const actual = cost?.actual
  if (actual === undefined || actual.status === 'unknown') return '费用未知'
  if (actual.status === 'known_free' && actual.source === 'offline_mock') return '离线模拟 · ¥0.00'
  const amount = `${actual.currency === 'CNY' ? '¥' : `${actual.currency} `}${actual.amount.toFixed(2)}`
  return `${actual.status === 'known_free' ? '已核实免费' : '实际回执'} · ${amount}`
}

export function summarizeGenerationCosts(jobs: readonly { readonly id: string; readonly cost?: GenerationCost; readonly copiedFromProjectId?: string | null }[]) {
  const currencies: Record<string, number> = {}
  let unknownJobs = 0
  let simulatedJobs = 0
  let inheritedJobs = 0
  for (const job of new Map(jobs.map((entry) => [entry.id, entry])).values()) {
    if (job.copiedFromProjectId != null) { inheritedJobs++; continue }
    const actual = job.cost?.actual
    if (actual === undefined || actual.status === 'unknown') { unknownJobs++; continue }
    if (actual.source === 'offline_mock') { simulatedJobs++; continue }
    currencies[actual.currency] = Number(((currencies[actual.currency] ?? 0) + actual.amount).toFixed(6))
  }
  return { currencies, unknownJobs, simulatedJobs, inheritedJobs }
}

export function formatGenerationCostSummary(summary: ReturnType<typeof summarizeGenerationCosts>): string {
  const amounts = Object.entries(summary.currencies).map(([currency, amount]) => `${currency === 'CNY' ? '¥' : `${currency} `}${amount.toFixed(2)}`)
  return [amounts.length ? `已知实际 ${amounts.join(' + ')}` : '', summary.unknownJobs ? `${summary.unknownJobs} 笔费用未知` : '',
    summary.simulatedJobs ? `${summary.simulatedJobs} 笔离线模拟` : '', summary.inheritedJobs ? `${summary.inheritedJobs} 笔源项目记录` : ''].filter(Boolean).join(' · ') || '暂无费用记录'
}
