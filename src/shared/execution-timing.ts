import type { GenerationJob } from './generation'

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
