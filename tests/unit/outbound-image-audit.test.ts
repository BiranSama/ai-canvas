import { describe, expect, it } from 'vitest'
import { measureOutboundImagePayload } from '../../src/main/generation/outbound-image-audit'
import type { ImageTaskRequest } from '../../src/shared/generation'

describe('Outbound image audit', () => {
  it('counts the exact binary payload fields prepared for a reference generation', async () => {
    const request = {
      prompt: 'reference study', negativePrompt: '', aspectWidth: 4, aspectHeight: 5,
      outputWidth: 1024, outputHeight: 1280, count: 1, providerId: 'image-provider', model: 'image-1',
      references: [
        { assetId: 'asset-a', intent: 'composition', strength: 0.7 },
        { assetId: 'asset-b', intent: 'style', strength: 0.5 }
      ], parameters: {}, sourceMessageId: null, parentResultId: null,
      referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
    } satisfies ImageTaskRequest
    const sizes = new Map([['asset-a', 1_024], ['asset-b', 2_048]])

    await expect(measureOutboundImagePayload(request, async (assetId) => sizes.get(assetId) ?? 0)).resolves.toEqual({
      imageAssetIds: ['asset-a', 'asset-b'],
      imageBytes: 3_072
    })
  })

  it('includes edit source, mask and reference fields without hiding duplicate transmissions', async () => {
    const request = {
      kind: 'edit', prompt: 'edit locally', negativePrompt: '', aspectWidth: 1, aspectHeight: 1,
      outputWidth: 1024, outputHeight: 1024, count: 1, providerId: 'image-provider', model: 'image-1',
      sourceAssetId: 'source', maskAssetId: 'mask',
      references: [{ assetId: 'source', intent: 'edit-source', strength: 1 }],
      parameters: {}, sourceMessageId: null, parentResultId: null,
      referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
    } satisfies ImageTaskRequest
    const sizes = new Map([['source', 4_096], ['mask', 512]])

    await expect(measureOutboundImagePayload(request, async (assetId) => sizes.get(assetId) ?? 0)).resolves.toEqual({
      imageAssetIds: ['source', 'mask', 'source'],
      imageBytes: 8_704
    })
  })
})
