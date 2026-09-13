import { describe, expect, it } from 'vitest'
import { createAgentFailureEnvelope } from '../../src/main/agent/agent-failure'
import {
  AGENT_ERROR_RECIPES,
  agentFailureDescriptor,
  agentFailureEnvelopeSchema,
  agentFailureFingerprint,
  isAutomaticAgentRecovery,
  normalizeAgentFailureEnvelope
} from '../../src/shared/agent-recovery'

describe('Agent Failure Envelope v2', () => {
  it('classifies only known completed model-output failures as model repairable', () => {
    expect(agentFailureDescriptor('MODEL_TOOL_UNSUPPORTED')).toMatchObject({
      retryClass: 'model_can_repair',
      externalState: 'completed'
    })
    expect(agentFailureDescriptor('SCENE_REVISION_STALE')).toMatchObject({
      retryClass: 'refresh_then_replan',
      externalState: 'not_started'
    })
    expect(agentFailureDescriptor('EXTERNAL_POST_STATE_UNKNOWN')).toMatchObject({
      retryClass: 'query_only',
      externalState: 'unknown'
    })
    expect(agentFailureDescriptor('UNRECOGNIZED_FAILURE')).toMatchObject({ retryClass: 'terminal' })
    expect(isAutomaticAgentRecovery('query_only')).toBe(false)
  })

  it('redacts local paths and bearer tokens before persistence or model feedback', () => {
    const error = Object.assign(new Error('Bearer secret-token failed at C:\\Users\\Owner\\private.json'), {
      code: 'MODEL_PLAN_SCHEMA_INVALID'
    })
    const envelope = createAgentFailureEnvelope({
      error,
      fallbackCode: 'AGENT_PLANNING_FAILED',
      attempt: 1,
      maxAttempts: 2
    })

    expect(agentFailureEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 2,
      code: 'MODEL_PLAN_SCHEMA_INVALID',
      retryClass: 'model_can_repair',
      attempt: 1,
      maxAttempts: 2
    })
    expect(envelope.safeMessage).toContain('Bearer [REDACTED]')
    expect(envelope.safeMessage).toContain('[LOCAL_PATH]')
    expect(envelope.safeMessage).not.toContain('secret-token')
    expect(envelope.safeMessage).not.toContain('private.json')
    expect(envelope.fingerprint).toMatch(/^[a-f0-9]{16,64}$/)
  })

  it('projects legacy v1 history to a conservative deterministic v2 view without granting repair', () => {
    const legacy = agentFailureEnvelopeSchema.parse({
      schemaVersion: 1,
      code: 'MODEL_PLAN_SCHEMA_INVALID',
      phase: 'validation',
      category: 'schema',
      retryClass: 'model_can_repair',
      toolName: null,
      safeMessage: '旧记录',
      schemaIssues: [{ path: 'tools.0.kind', expected: 'known tool kind' }],
      expectedSceneRevision: 3,
      currentSceneRevision: 3,
      affectedElementIds: [],
      externalState: 'completed',
      attempt: 1,
      maxAttempts: 2
    })
    const first = normalizeAgentFailureEnvelope(legacy)
    const second = normalizeAgentFailureEnvelope(legacy)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: 2,
      replacementScope: 'none',
      remainingModelTurns: 0,
      remainingRecoveryAttempts: 0,
      allowedActions: ['ask_user', 'stop']
    })
    expect(first.schemaIssues[0]).toMatchObject({ issueCode: 'LEGACY_UNATTRIBUTED' })
  })

  it('keeps schema paths in the safe repair envelope and fingerprints only the repair identity', () => {
    const error = Object.assign(new Error('结构不符合工具约束'), {
      code: 'MODEL_PLAN_SCHEMA_INVALID',
      schemaIssues: [{ issueCode: 'INVALID_TYPE', path: 'tools.1.commands.0', expected: 'Scene command' }]
    })
    const envelope = createAgentFailureEnvelope({
      error,
      fallbackCode: 'AGENT_PLANNING_FAILED',
      attempt: 1,
      maxAttempts: 2,
      remainingModelTurns: 2,
      remainingRecoveryAttempts: 3,
      remainingWallTimeMs: 45_000
    })
    expect(envelope.schemaIssues).toEqual([
      { issueCode: 'INVALID_TYPE', path: 'tools.1.commands.0', expected: 'Scene command' }
    ])
    expect(envelope.fingerprint).toBe(agentFailureFingerprint({
      code: envelope.code,
      phase: envelope.phase,
      toolName: null,
      schemaIssues: envelope.schemaIssues
    }))
  })

  it('registers bounded policies for model, protocol, tool, external-state and budget failures', () => {
    for (const code of [
      'MODEL_ARGUMENTS_INVALID', 'PROVIDER_STREAM_INCOMPLETE', 'TOOL_NOT_FOUND',
      'SCENE_REVISION_STALE', 'EXTERNAL_POST_STATE_UNKNOWN', 'EXTERNAL_RESULT_INVALID',
      'BUDGET_WALL_TIME'
    ]) {
      expect(AGENT_ERROR_RECIPES[code]).toMatchObject({ code })
      expect(AGENT_ERROR_RECIPES[code]!.maxAutomaticModelRepairs).toBeLessThanOrEqual(2)
      expect(AGENT_ERROR_RECIPES[code]!.maxAutomaticLocalRetries).toBeLessThanOrEqual(2)
    }
  })
})
