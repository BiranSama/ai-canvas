import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  agentErrorRecipe,
  agentFailureEnvelopeV2Schema,
  agentFailureFingerprint,
  type AgentFailureEnvelopeV2
} from '../../shared/agent-recovery'

const WINDOWS_PATH = /(?:[a-zA-Z]:\\|\\\\)[^\s"']+/g
const POSIX_PATH = /\/(?:Users|home|var|tmp|etc)\/[^\s"']+/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

function safeText(value: string): string {
  return value
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(WINDOWS_PATH, '[LOCAL_PATH]')
    .replace(POSIX_PATH, '[LOCAL_PATH]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1_000) || '操作未能完成。'
}

function codeFrom(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return fallback
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(error.code) ? error.code : fallback
}

function schemaIssues(error: unknown): AgentFailureEnvelopeV2['schemaIssues'] {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 40).map((issue) => ({
      issueCode: issue.code.toUpperCase().slice(0, 120),
      path: issue.path.map(String).join('.').slice(0, 240),
      expected: issue.message.slice(0, 300)
    }))
  }
  if (typeof error !== 'object' || error === null || !('schemaIssues' in error) || !Array.isArray(error.schemaIssues)) return []
  return error.schemaIssues.slice(0, 40).flatMap((issue): AgentFailureEnvelopeV2['schemaIssues'] => {
    if (typeof issue !== 'object' || issue === null) return []
    const candidate = issue as { readonly issueCode?: unknown; readonly path?: unknown; readonly expected?: unknown }
    if (typeof candidate.issueCode !== 'string' || typeof candidate.path !== 'string' || typeof candidate.expected !== 'string') return []
    return [{
      issueCode: candidate.issueCode.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 120) || 'INVALID_VALUE',
      path: candidate.path.slice(0, 240),
      expected: safeText(candidate.expected).slice(0, 300)
    }]
  })
}

export function createAgentFailureEnvelope(input: {
  readonly error: unknown
  readonly fallbackCode: string
  readonly toolName?: string | null
  readonly attempt: number
  readonly maxAttempts: number
  readonly expectedSceneRevision?: number | null
  readonly currentSceneRevision?: number | null
  readonly affectedElementIds?: readonly string[]
  readonly parentFailureId?: string | null
  readonly requestCorrelationId?: string | null
  readonly providerAttemptId?: string | null
  readonly completedToolIndexes?: readonly number[]
  readonly failedToolIndex?: number | null
  readonly unstartedToolIndexes?: readonly number[]
  readonly remainingModelTurns?: number
  readonly remainingRecoveryAttempts?: number
  readonly remainingWallTimeMs?: number
  readonly remainingCostCny?: number | null
  readonly externalState?: AgentFailureEnvelopeV2['externalState']
  readonly createdAt?: string
}): AgentFailureEnvelopeV2 {
  const code = codeFrom(input.error, input.fallbackCode)
  const recipe = agentErrorRecipe(code)
  const message = input.error instanceof Error ? input.error.message : '操作未能完成。'
  const issues = schemaIssues(input.error)
  return agentFailureEnvelopeV2Schema.parse({
    schemaVersion: 2,
    failureId: randomUUID(),
    parentFailureId: input.parentFailureId ?? null,
    requestCorrelationId: input.requestCorrelationId ?? null,
    providerAttemptId: input.providerAttemptId ?? null,
    fingerprint: agentFailureFingerprint({ code, phase: recipe.phase, toolName: input.toolName ?? null, schemaIssues: issues }),
    code,
    phase: recipe.phase,
    category: recipe.category,
    retryClass: recipe.defaultRetryClass,
    externalState: input.externalState ?? recipe.defaultExternalState,
    toolName: input.toolName ?? null,
    safeMessage: safeText(message),
    schemaIssues: issues,
    expectedSceneRevision: input.expectedSceneRevision ?? null,
    currentSceneRevision: input.currentSceneRevision ?? null,
    affectedElementIds: [...new Set(input.affectedElementIds ?? [])].slice(0, 1_000),
    repairRecipeId: recipe.code === 'UNKNOWN_AGENT_FAILURE' ? null : recipe.code,
    repairFacts: [recipe.publicExplanation],
    prohibitedRepairs: [...recipe.prohibitedRepairs],
    replacementScope: recipe.replacementScope,
    completedToolIndexes: [...new Set(input.completedToolIndexes ?? [])].slice(0, 12),
    failedToolIndex: input.failedToolIndex ?? null,
    unstartedToolIndexes: [...new Set(input.unstartedToolIndexes ?? [])].slice(0, 12),
    attempt: Math.max(1, Math.floor(input.attempt)),
    maxAttempts: Math.max(0, Math.floor(input.maxAttempts)),
    remainingModelTurns: Math.max(0, Math.floor(input.remainingModelTurns ?? 0)),
    remainingRecoveryAttempts: Math.max(0, Math.floor(input.remainingRecoveryAttempts ?? 0)),
    remainingWallTimeMs: Math.max(0, Math.floor(input.remainingWallTimeMs ?? 0)),
    remainingCostCny: input.remainingCostCny ?? null,
    allowedActions: [...recipe.allowedActions],
    createdAt: input.createdAt ?? new Date().toISOString()
  })
}
