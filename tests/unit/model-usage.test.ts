import { describe, expect, it } from 'vitest'
import { cacheHitPercent, estimateModelCostCny, formatTurnModelUsage } from '../../src/shared/model-usage'

describe('text-model usage', () => {
  it('prices cached input separately and falls back to the input price', () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000 }
    expect(estimateModelCostCny(usage, { inputPerMillionCny: 2, cachedInputPerMillionCny: 0.5, outputPerMillionCny: 8 })).toBe(1.9)
    expect(estimateModelCostCny(usage, { inputPerMillionCny: 2, cachedInputPerMillionCny: null, outputPerMillionCny: 8 })).toBe(2.8)
    // A vendor reporting more cached than total input is not billed below zero.
    expect(estimateModelCostCny({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 }, { inputPerMillionCny: 1, cachedInputPerMillionCny: 0, outputPerMillionCny: 1 })).toBe(0)
  })

  it('reads as one line with the estimate only when priced', () => {
    expect(formatTurnModelUsage({ calls: 12, inputTokens: 85_230, cachedInputTokens: 60_100, outputTokens: 9_300, estimatedCostCny: 0.1234 }))
      .toBe('文字模型 12 次 · 输入 85.2K（缓存命中 60.1K，71%） · 输出 9.3K · 估算 ¥0.12')
    expect(formatTurnModelUsage({ calls: 1, inputTokens: 900, cachedInputTokens: 0, outputTokens: 40, estimatedCostCny: 0.0004 })).toBe('文字模型 1 次 · 输入 900 · 输出 40 · 估算 <¥0.01')
    expect(formatTurnModelUsage({ calls: 2, inputTokens: 1_500_000, cachedInputTokens: 0, outputTokens: 2_000, estimatedCostCny: null })).toBe('文字模型 2 次 · 输入 1.50M · 输出 2.0K')
  })

  it('takes the cache hit rate over all input, and never above the whole of it', () => {
    expect(cacheHitPercent({ inputTokens: 85_230, cachedInputTokens: 60_100, outputTokens: 0 })).toBe(71)
    expect(cacheHitPercent({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0)
    expect(cacheHitPercent({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 })).toBe(100)
  })
})
