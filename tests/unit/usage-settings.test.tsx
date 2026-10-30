import { act, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { UsageSettings } from '../../src/renderer/src/components/UsageSettings'
import { turnUsageRows, usageTotals } from '../../src/renderer/src/agent/turn-usage'
import type { AgentHarnessSnapshot, AgentItem, AgentTurn } from '../../src/shared/agent-harness'

const THREAD = '72000000-0000-4000-8000-000000000001'

function turn(id: string, createdAt: string, completedAt: string): AgentTurn {
  return {
    id, threadId: THREAD, goalId: null, inputMessageId: null, status: 'completed', sceneRevisionAtStart: 0,
    modelTurnsUsed: 0, toolCallsUsed: 0, sceneWriteBatchesUsed: 0, recoveryAttemptsUsed: 0,
    createdAt, updatedAt: completedAt, completedAt
  } as unknown as AgentTurn
}

function item(turnId: string, ordinal: number, type: AgentItem['type'], payload: unknown): AgentItem {
  return { id: `${turnId}-${ordinal}`, threadId: THREAD, turnId, ordinal, type, status: 'completed', payloadVersion: 1, payload,
    createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z' } as unknown as AgentItem
}

function pass(input: number, cached: number, costCny: number | null): unknown {
  return { step: { trace: { usage: [{ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: 500, reasoningTokens: null }], modelCalls: 1, costCny } } }
}

const SNAPSHOT = {
  turns: [
    turn('turn-a', '2026-10-30T10:00:00.000Z', '2026-10-30T10:01:30.000Z'),
    turn('turn-b', '2026-10-30T10:05:00.000Z', '2026-10-30T10:05:20.000Z'),
    turn('turn-c', '2026-10-30T10:06:00.000Z', '2026-10-30T10:06:05.000Z')
  ],
  items: [
    item('turn-a', 1, 'user_message', { request: { text: '做一张咖啡店海报' } }),
    item('turn-a', 2, 'plan', pass(10_000, 2_000, 0.02)),
    item('turn-a', 3, 'plan', pass(12_000, 10_000, 0.01)),
    item('turn-b', 1, 'user_message', { request: { text: '标题再大一点' } }),
    item('turn-b', 2, 'plan', pass(14_000, 12_000, null)),
    item('turn-c', 1, 'user_message', { request: { text: '本地排版' } })
  ]
} as unknown as AgentHarnessSnapshot

it('lists the latest turns, newest first, with calls, cache hits, cost and working time', () => {
  const rows = turnUsageRows(SNAPSHOT, Date.parse('2026-10-30T11:00:00.000Z'))
  expect(rows.map((row) => [row.request, row.usage?.calls ?? null, row.durationMs])).toEqual([
    ['本地排版', null, 5_000],
    ['标题再大一点', 1, 20_000],
    ['做一张咖啡店海报', 2, 90_000]
  ])
  expect(usageTotals(rows)).toEqual({
    turns: 2, calls: 3, inputTokens: 36_000, cachedInputTokens: 24_000, outputTokens: 1_500, estimatedCostCny: 0.03, partlyUnpriced: true
  })
})

it('shows the totals and one row per turn in settings', async () => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: { getAgentHarnessSnapshot: async () => SNAPSHOT } })
  render(<UsageSettings />)
  await act(async () => undefined)
  const totals = screen.getByTestId('usage-totals')
  expect(totals).toHaveTextContent('3 次')
  expect(totals).toHaveTextContent('67%')
  expect(totals).toHaveTextContent('¥0.03 起')
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('没有调用文字模型'),
    expect.stringMatching(/标题再大一点1.*14\.0K.*86%.*未定价.*20 秒/),
    expect.stringMatching(/做一张咖啡店海报2.*22\.0K.*55%.*¥0\.03.*1 分 30 秒/)
  ])
})
