import { describe, expect, it } from 'vitest'
import { formatGenerationCost, formatGenerationCostSummary, summarizeGenerationCosts, unknownGenerationCost, type GenerationCost } from '../../src/shared/generation-cost'

const estimated = (amount: number): GenerationCost => ({
  ...unknownGenerationCost(),
  estimate: { amount, currency: 'CNY', source: 'provider_price', estimatedAt: '2026-10-18T00:00:00.000Z', parameters: { profileId: 'configured-draft', model: 'grok-imagine-image', imageCount: 2 } }
})

describe('generation cost estimates from a set price', () => {
  it('shows a priced job as an estimate and keeps it apart from actual and unknown amounts', () => {
    expect(formatGenerationCost(estimated(0.6))).toBe('估算 · ¥0.60（按设置的单价）')
    expect(formatGenerationCost(unknownGenerationCost())).toBe('费用未知')
    const summary = summarizeGenerationCosts([
      { id: 'a', cost: estimated(0.6) },
      { id: 'b', cost: estimated(0.25) },
      { id: 'c', cost: unknownGenerationCost() }
    ])
    expect(summary).toMatchObject({ currencies: {}, estimated: { CNY: 0.85 }, estimatedJobs: 2, unknownJobs: 1 })
    expect(formatGenerationCostSummary(summary)).toBe('2 笔按单价估算 ¥0.85 · 1 笔费用未知')
  })
})
