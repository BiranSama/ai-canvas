import type { AgentItem, AgentTurn } from './agent-harness'
import type { GenerationJob } from './generation'

/** Time spent waiting for the person to decide is not the Agent's time. */
export function userDecisionWaitMs(items: readonly Pick<AgentItem, 'type' | 'status' | 'createdAt' | 'updatedAt'>[], nowMs: number): number {
  let total = 0
  for (const item of items) {
    if (item.type !== 'decision') continue
    const start = Date.parse(item.createdAt)
    const end = item.status === 'waiting' ? nowMs : Date.parse(item.updatedAt)
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) total += end - start
  }
  return total
}

/** Wall time a turn has spent working; waiting on a decision does not count. */
export function activeTurnElapsedMs(
  turn: Pick<AgentTurn, 'createdAt'>,
  items: readonly Pick<AgentItem, 'type' | 'status' | 'createdAt' | 'updatedAt'>[],
  nowMs: number
): number {
  return Math.max(0, nowMs - Date.parse(turn.createdAt) - userDecisionWaitMs(items, nowMs))
}

export function formatTimeLimit(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}

export function generationTiming(job: GenerationJob, now = Date.now()) {
  const limitMs = job.effectiveTimeoutMs ?? null
  const started = job.startedAt === null ? null : Date.parse(job.startedAt)
  const end = job.completedAt === null ? now : Date.parse(job.completedAt)
  const elapsedMs = started === null || !Number.isFinite(started) ? 0 : Math.max(0, end - started)
  return { limitMs, elapsedMs, remainingMs: limitMs === null ? null : Math.max(0, limitMs - elapsedMs),
    deadlineAt: limitMs === null || started === null || !Number.isFinite(started) ? null : new Date(started + limitMs).toISOString() }
}
