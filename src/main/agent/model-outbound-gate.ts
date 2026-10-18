import type { ContextManifest } from '../../shared/agent-context'
import type { AgentTurn } from '../../shared/agent-harness'
import type { OutboundContextService } from './outbound-context-service'
import type { ModelOutboundGate, ModelOutboundRequest } from './planner'

const BLOCKED_MESSAGES: Readonly<Record<string, string>> = {
  local_only: '当前隐私设置是「仅本地」，Agent 没有调用外部文字模型。手动编辑照常可用；需要 Agent 时可在隐私设置里改为其他选项。',
  custom: '当前的自定义隐私设置不允许把本轮内容发往文字模型，没有发出任何请求。'
}

/** Loopback addresses stay on this machine; everything else counts as external. */
export function isLocalModelEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

function blockedError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'OUTBOUND_POLICY_BLOCKED' })
}

/**
 * Records every model call in the turn's outbound ledger and enforces the
 * project policy on it. Under per-image review, images that were not approved
 * stay local and the text goes on its own.
 */
export function createModelOutboundGate(input: {
  readonly service: OutboundContextService
  readonly manifest: ContextManifest
  readonly turn: Pick<AgentTurn, 'id' | 'threadId'>
  readonly projectId: string
  readonly requestCorrelationId: string
}): ModelOutboundGate {
  const prepare = (request: ModelOutboundRequest, withImages: boolean) => input.service.prepare({
    projectId: input.projectId,
    threadId: input.turn.threadId,
    turnId: input.turn.id,
    manifestId: input.manifest.id,
    providerId: request.providerId,
    model: request.model,
    dataTypes: withImages ? request.dataTypes : request.dataTypes.filter((type) => type !== 'reference_image'),
    imageAssetIds: withImages ? request.imageAssetIds : [],
    textBytes: request.textBytes,
    imageBytes: withImages ? request.imageBytes : 0,
    requestCorrelationId: input.requestCorrelationId,
    providerLocal: isLocalModelEndpoint(request.endpoint),
    permissionAllowsExternal: true,
    imageReviewApproved: false
  })
  return {
    async authorize(request) {
      const record = await prepare(request, true)
      if (record.status !== 'blocked') return { recordId: record.id, imagesAllowed: true }
      if (input.manifest.outboundPolicy === 'review_each_image' && request.imageAssetIds.length > 0) {
        const textOnly = await prepare(request, false)
        if (textOnly.status !== 'blocked') return { recordId: textOnly.id, imagesAllowed: false }
      }
      throw blockedError(BLOCKED_MESSAGES[input.manifest.outboundPolicy] ?? '隐私设置不允许本次外发，没有发出任何请求。')
    },
    async sent(recordId) {
      await input.service.markSent(recordId, 'The model request was sent to the selected text model.')
    }
  }
}
