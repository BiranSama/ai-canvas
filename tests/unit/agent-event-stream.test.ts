import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/shared/agent-harness'
import { agentEventsForTurn, recordAgentEvent, resetRetainedAgentEventsForTests } from '../../src/renderer/src/agent/agent-event-stream'

const event = (threadId: string, sequence: number, time: number): AgentEvent => ({
  id: `${threadId}-${sequence}`, projectId: `project-${threadId}`, threadId, turnId: `turn-${threadId}`, itemId: null,
  sequence, type: 'provider.attempt.receiving', payloadVersion: 1, payload: { receivedBytes: time }, createdAt: new Date(time).toISOString()
})

beforeEach(resetRetainedAgentEventsForTests)
describe('live Agent checkpoint delivery', () => {
  it('replaces live progress without duplicate DOM history and refuses older replay', () => {
    expect(recordAgentEvent(event('a', 1, 1_000))).toBe(true)
    expect(recordAgentEvent(event('a', 1, 1_100))).toBe(true)
    expect(recordAgentEvent(event('a', 1, 1_000))).toBe(false)
    expect(agentEventsForTurn('turn-a')).toEqual([event('a', 1, 1_100)])
  })
  it('keeps equal sequence numbers from different project threads separate', () => {
    recordAgentEvent(event('a', 1, 1_000))
    recordAgentEvent(event('b', 1, 1_000))
    expect(agentEventsForTurn('turn-a')).toHaveLength(1)
    expect(agentEventsForTurn('turn-b')).toHaveLength(1)
  })
  it('bounds retained per-turn history', () => {
    for (let index = 0; index < 2_100; index += 1) recordAgentEvent(event('a', index, index))
    expect(agentEventsForTurn('turn-a')).toHaveLength(500)
    expect(agentEventsForTurn('turn-a').at(-1)?.sequence).toBe(2_099)
  })
})
