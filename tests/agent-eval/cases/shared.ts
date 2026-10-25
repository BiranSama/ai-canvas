import type { AgentEvalCaseInput } from '../../../src/main/agent/eval'

/** A serif face by family name, never a sans-serif one. */
export const SERIF_FONT_PATTERN = '^(?!.*sans).*(?:serif|宋|明朝|song|ming|times|georgia|garamond|baskerville|didot|bodoni|playfair|衬线|楷|kai|仿宋|fangsong)'

/** Anything that can stand for the main subject of a new layout. */
export const SUBJECT_SELECTION = [{ role: 'subject' }, { type: 'placeholder' }, { type: 'image' }] as const

export const NO_PAID_GENERATION = { kind: 'paid_generation_requests', max: 0 } as const

/**
 * Limits describe acceptable product behaviour, not today's engine: a
 * multi-step engine may take several model calls for one request. Spend caps
 * are checked against token pricing when configured, otherwise against the
 * transport's per-request reservation ceiling.
 */
export const LIMITS = {
  advise: { maxToolSteps: 1, maxModelCalls: 4, maxSpendCny: 1 },
  edit: { maxToolSteps: 4, maxModelCalls: 6, maxSpendCny: 1.5 },
  layout: { maxToolSteps: 12, maxModelCalls: 10, maxSpendCny: 2.5 },
  multiTurn: { maxToolSteps: 6, maxModelCalls: 6, maxSpendCny: 4 },
  generate: { maxToolSteps: 4, maxModelCalls: 6, maxSpendCny: 1.5 }
} as const satisfies Record<string, AgentEvalCaseInput['limits']>
