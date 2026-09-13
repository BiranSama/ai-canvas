import { describe, expect, it } from 'vitest'
import { HANDOFF_FIXTURE_IDS, HANDOFF_FIXTURES } from '../fixtures/handoff-fixtures'

describe('Development Handoff deterministic fixtures', () => {
  it('provides every required named state without enabling real calls', () => {
    expect(Object.keys(HANDOFF_FIXTURES)).toEqual(HANDOFF_FIXTURE_IDS)
    expect(HANDOFF_FIXTURES['canvas.nightVeil'].elements).toHaveLength(4)
    expect(HANDOFF_FIXTURES['canvas.textSelected'].selectedIds).toHaveLength(1)
    expect(HANDOFF_FIXTURES['composer.allStates']).toEqual([
      'idle', 'editing', 'acting', 'confirm', 'generating', 'completed', 'failed', 'cancelled'
    ])
    expect(HANDOFF_FIXTURES['provider.settings'].realCallsAuthorized).toBe(false)
  })
})
