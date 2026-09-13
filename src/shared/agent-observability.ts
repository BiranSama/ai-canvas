import { z } from 'zod'
import { llmProtocolSchema } from './provider-settings'
import {
  agentExternalStateSchema,
  agentFailureCategorySchema,
  agentFailurePhaseSchema,
  agentFailureRetryClassSchema,
  agentReplacementScopeSchema,
  agentAllowedRecoveryActionSchema
} from './agent-recovery'

export const agentProviderAttemptPhaseSchema = z.enum([
  'reserved', 'connecting', 'headers', 'first_event', 'receiving', 'completed', 'failed', 'cancelled'
])

export const agentProviderAttemptEventSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().uuid(),
  requestCorrelationId: z.string().uuid(),
  providerId: z.string().trim().min(1).max(200),
  providerLabel: z.string().trim().min(1).max(80),
  protocol: llmProtocolSchema,
  model: z.string().trim().min(1).max(160),
  transportMode: z.enum(['stream', 'buffered']),
  attempt: z.number().int().positive(),
  phase: agentProviderAttemptPhaseSchema,
  occurredAt: z.string().datetime({ offset: true }),
  elapsedMs: z.number().int().nonnegative(),
  lastTransportActivityAt: z.string().datetime({ offset: true }).nullable(),
  lastSemanticProgressAt: z.string().datetime({ offset: true }).nullable(),
  receivedBytes: z.number().int().nonnegative(),
  recognizedEventCount: z.number().int().nonnegative(),
  providerResponseId: z.string().trim().max(500).nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/).nullable()
}).strict()

export const agentPlanLifecycleEventSchema = z.object({
  schemaVersion: z.literal(1),
  requestCorrelationId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  elapsedMs: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative().max(12).nullable(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/).nullable()
}).strict()

export const agentRecoveryLifecycleEventSchema = z.object({
  schemaVersion: z.literal(1),
  requestCorrelationId: z.string().uuid().nullable(),
  failureId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/),
  failure: z.object({
    phase: agentFailurePhaseSchema,
    category: agentFailureCategorySchema,
    retryClass: agentFailureRetryClassSchema,
    externalState: agentExternalStateSchema,
    replacementScope: agentReplacementScopeSchema,
    allowedActions: z.array(agentAllowedRecoveryActionSchema).max(12),
    completedToolIndexes: z.array(z.number().int().nonnegative()).max(12),
    failedToolIndex: z.number().int().nonnegative().nullable(),
    unstartedToolIndexes: z.array(z.number().int().nonnegative()).max(12),
    remainingModelTurns: z.number().int().nonnegative(),
    remainingRecoveryAttempts: z.number().int().nonnegative(),
    remainingWallTimeMs: z.number().int().nonnegative(),
    remainingCostCny: z.number().nonnegative().nullable()
  }).strict().optional()
}).strict()

export type AgentProviderAttemptEventV1 = z.infer<typeof agentProviderAttemptEventSchema>
export type AgentProviderAttemptPhase = z.infer<typeof agentProviderAttemptPhaseSchema>
export type AgentPlanLifecycleEventV1 = z.infer<typeof agentPlanLifecycleEventSchema>
export type AgentRecoveryLifecycleEventV1 = z.infer<typeof agentRecoveryLifecycleEventSchema>

export type AgentObservableEvent =
  | { readonly type: `provider.attempt.${AgentProviderAttemptPhase}`; readonly payload: AgentProviderAttemptEventV1 }
  | { readonly type: 'plan.validation.started' | 'plan.validation.completed' | 'plan.validation.failed'; readonly payload: AgentPlanLifecycleEventV1 }
  | { readonly type: 'recovery.started' | 'recovery.completed' | 'recovery.exhausted'; readonly payload: AgentRecoveryLifecycleEventV1 }

export function parseAgentObservableEvent(type: string, payload: unknown): AgentObservableEvent | null {
  if (type.startsWith('provider.attempt.')) {
    const parsed = agentProviderAttemptEventSchema.safeParse(payload)
    if (!parsed.success || type !== `provider.attempt.${parsed.data.phase}`) return null
    return { type: type as `provider.attempt.${AgentProviderAttemptPhase}`, payload: parsed.data }
  }
  if (type === 'plan.validation.started' || type === 'plan.validation.completed' || type === 'plan.validation.failed') {
    const parsed = agentPlanLifecycleEventSchema.safeParse(payload)
    return parsed.success ? { type, payload: parsed.data } : null
  }
  if (type === 'recovery.started' || type === 'recovery.completed' || type === 'recovery.exhausted') {
    const parsed = agentRecoveryLifecycleEventSchema.safeParse(payload)
    return parsed.success ? { type, payload: parsed.data } : null
  }
  return null
}
