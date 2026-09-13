import type { ImageTaskRequest } from '../../shared/generation'

export interface OutboundImagePayloadMeasurement {
  readonly imageAssetIds: readonly string[]
  readonly imageBytes: number
}

function outboundImageAssetIds(request: ImageTaskRequest): readonly string[] {
  const editAssets = 'kind' in request && request.kind === 'edit'
    ? [request.sourceAssetId, request.maskAssetId]
    : []
  return [...editAssets, ...request.references.map((reference) => reference.assetId)]
}

export async function measureOutboundImagePayload(
  request: ImageTaskRequest,
  sizeOf: (assetId: string) => Promise<number>
): Promise<OutboundImagePayloadMeasurement> {
  const imageAssetIds = outboundImageAssetIds(request)
  let imageBytes = 0
  for (const assetId of imageAssetIds) {
    const size = await sizeOf(assetId)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Asset ${assetId} has an invalid byte size.`)
    imageBytes += size
    if (!Number.isSafeInteger(imageBytes)) throw new Error('Outbound image payload is too large to audit safely.')
  }
  return { imageAssetIds, imageBytes }
}
