import type { AgentHarnessSnapshot } from '../../../shared/agent-harness'
import { activeTurnElapsedMs } from '../../../shared/execution-timing'
import { turnModelUsage, type TurnModelUsage } from '../../../shared/model-usage'

export interface TurnUsageRow {
  readonly turnId: string
  readonly startedAt: string
  /** What the person asked for, as they typed it. */
  readonly request: string
  /** Working time, without the time spent waiting on the person. */
  readonly durationMs: number
  /** Null for a turn that made no text-model call, such as one planned locally. */
  readonly usage: TurnModelUsage | null
}

export interface UsageTotals extends TurnModelUsage {
  readonly turns: number
  /** Set when some calls had no price, so the estimate leaves them out. */
  readonly partlyUnpriced: boolean
}

/** The project's latest turns with what their model calls used, newest first. */
export function turnUsageRows(snapshot: AgentHarnessSnapshot, nowMs: number, limit = 20): TurnUsageRow[] {
  return [...snapshot.turns]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit)
    .map((turn) => {
      const items = snapshot.items.filter((item) => item.turnId === turn.id)
      const request = items.find((item) => item.type === 'user_message')?.payload as { readonly request?: { readonly text?: unknown } } | undefined
      return {
        turnId: turn.id,
        startedAt: turn.createdAt,
        request: typeof request?.request?.text === 'string' ? request.request.text : '',
        durationMs: activeTurnElapsedMs(turn, items, turn.completedAt === null ? nowMs : Date.parse(turn.completedAt)),
        usage: turnModelUsage(items)
      }
    })
}

/** What the rows that called a model add up to, or null when none did. */
export function usageTotals(rows: readonly TurnUsageRow[]): UsageTotals | null {
  const used = rows.flatMap((row) => row.usage === null ? [] : [row.usage])
  if (used.length === 0) return null
  return {
    turns: used.length,
    calls: used.reduce((total, usage) => total + usage.calls, 0),
    inputTokens: used.reduce((total, usage) => total + usage.inputTokens, 0),
    cachedInputTokens: used.reduce((total, usage) => total + usage.cachedInputTokens, 0),
    outputTokens: used.reduce((total, usage) => total + usage.outputTokens, 0),
    estimatedCostCny: Number(used.reduce((total, usage) => total + (usage.estimatedCostCny ?? 0), 0).toFixed(6)),
    partlyUnpriced: used.some((usage) => usage.estimatedCostCny === null)
  }
}
