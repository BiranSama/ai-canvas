import type { OutboundContextRecord } from '../../shared/agent-context'
import type { AgentContextRepository } from './agent-context-repository'
import { OutboundPolicyGuard } from './context-builder'

export interface PrepareOutboundContextInput {
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly manifestId: string
  readonly toolCallId?: string | null
  readonly providerId: string
  readonly model: string
  readonly dataTypes: readonly string[]
  readonly imageAssetIds: readonly string[]
  readonly textBytes: number
  readonly imageBytes?: number | null
  readonly approvalId?: string | null
  readonly requestCorrelationId?: string | null
  readonly providerLocal: boolean
  readonly permissionAllowsExternal: boolean
  readonly imageReviewApproved?: boolean
  readonly customAllowedDataTypes?: readonly string[]
}

/**
 * The sole S5 entry point for preparing model-bound context. It records the
 * attempted scope even when policy blocks it, and never receives credentials,
 * headers, absolute paths or image bytes themselves. It records only the
 * measured aggregate byte count and a non-sensitive request correlation id.
 */
export class OutboundContextService {
  readonly #repository: AgentContextRepository
  readonly #guard: OutboundPolicyGuard

  constructor(repository: AgentContextRepository, guard = new OutboundPolicyGuard()) {
    this.#repository = repository
    this.#guard = guard
  }

  async prepare(input: PrepareOutboundContextInput): Promise<OutboundContextRecord> {
    const manifest = await this.#repository.getManifest(input.manifestId)
    if (manifest.projectId !== input.projectId || manifest.threadId !== input.threadId || manifest.turnId !== input.turnId) {
      throw new Error('Outbound context scope does not match its manifest.')
    }
    const evaluation = this.#guard.evaluate({
      policy: manifest.outboundPolicy,
      dataTypes: input.dataTypes,
      imageAssetIds: input.imageAssetIds,
      providerLocal: input.providerLocal,
      permissionAllowsExternal: input.permissionAllowsExternal,
      ...(input.imageReviewApproved === undefined ? {} : { imageReviewApproved: input.imageReviewApproved }),
      ...(input.customAllowedDataTypes === undefined ? {} : { customAllowedDataTypes: input.customAllowedDataTypes })
    })
    return this.#repository.createOutboundRecord({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      manifestId: input.manifestId,
      toolCallId: input.toolCallId ?? null,
      providerId: input.providerId,
      model: input.model,
      policy: manifest.outboundPolicy,
      dataTypes: input.dataTypes,
      imageAssetIds: input.imageAssetIds,
      textBytes: Math.max(0, Math.floor(input.textBytes)),
      imageCount: input.imageAssetIds.length,
      imageBytes: input.imageBytes === undefined || input.imageBytes === null
        ? null
        : Math.max(0, Math.floor(input.imageBytes)),
      approvalId: input.approvalId ?? null,
      requestCorrelationId: input.requestCorrelationId ?? null,
      status: evaluation.status,
      reason: evaluation.reason
    })
  }

  markSent(recordId: string, reason = 'The prepared scope was delivered to the selected provider.'): Promise<OutboundContextRecord> {
    return this.#repository.transitionOutboundRecord(recordId, 'sent', reason)
  }

  cancel(recordId: string, reason: string): Promise<OutboundContextRecord> {
    return this.#repository.transitionOutboundRecord(recordId, 'cancelled', reason)
  }
}
