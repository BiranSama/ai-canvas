import { describe, expect, it } from 'vitest'
import { activeTurnElapsedMs, userDecisionWaitMs } from '../../src/shared/execution-timing'

const at = (time: string) => `2026-10-17T10:${time}.000Z`

describe('turn clock', () => {
  it('excludes resolved and open decision waits from the time a turn has worked', () => {
    const items = [
      { type: 'plan' as const, status: 'completed' as const, createdAt: at('00:05'), updatedAt: at('00:06') },
      { type: 'decision' as const, status: 'completed' as const, createdAt: at('00:10'), updatedAt: at('03:10') },
      { type: 'decision' as const, status: 'waiting' as const, createdAt: at('04:00'), updatedAt: at('04:00') }
    ]
    const now = Date.parse(at('05:00'))
    expect(userDecisionWaitMs(items, now)).toBe(180_000 + 60_000)
    expect(activeTurnElapsedMs({ createdAt: at('00:00') }, items, now)).toBe(300_000 - 240_000)
  })

  it('never reports negative work time', () => {
    const items = [{ type: 'decision' as const, status: 'waiting' as const, createdAt: at('00:00'), updatedAt: at('00:00') }]
    expect(activeTurnElapsedMs({ createdAt: at('00:30') }, items, Date.parse(at('01:00')))).toBe(0)
  })
})
