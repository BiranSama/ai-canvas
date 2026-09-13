import { describe, expect, it } from 'vitest'
import { OpenAiImagesProtocol } from '../../src/main/generation/openai-images-protocol'
import type { EditRequest, GenerationRequest } from '../../src/shared/generation'

const generationRequest: GenerationRequest = {
  prompt: 'A restrained editorial still life',
  negativePrompt: 'watermark',
  aspectWidth: 4,
  aspectHeight: 5,
  outputWidth: 1024,
  outputHeight: 1280,
  count: 2,
  providerId: 'image-provider',
  model: 'studio-image',
  references: [],
  parameters: {},
  sourceMessageId: null,
  parentResultId: null,
  referenceMode: 'hybrid',
  variationInstruction: '',
  preserveConstraints: ''
}

describe('OpenAI Images compatible protocol without external calls', () => {
  const protocol = new OpenAiImagesProtocol({
    baseUrl: 'https://images.example.test/v1',
    allowedModels: ['studio-image']
  })

  it('builds a bounded JSON generation request and parses base64 results', () => {
    expect(protocol.buildGenerationRequest(generationRequest)).toEqual({
      url: 'https://images.example.test/v1/images/generations',
      body: expect.objectContaining({
        model: 'studio-image',
        n: 2,
        size: '1024x1280',
        response_format: 'b64_json'
      })
    })
    expect(protocol.parseResponse({ data: [{ b64_json: 'ZmFrZQ==' }, { b64_json: 'ZmFrZTI=' }] }))
      .toEqual([{ kind: 'base64', value: 'ZmFrZQ==' }, { kind: 'base64', value: 'ZmFrZTI=' }])
  })

  it('requests PNG transparency only when the configured capability is used by the job', () => {
    expect(protocol.buildGenerationRequest({
      ...generationRequest,
      count: 1,
      parameters: { transparentOutput: true }
    }).body).toMatchObject({ background: 'transparent', output_format: 'png' })
    expect(protocol.buildGenerationRequest({ ...generationRequest, count: 1 }).body).not.toHaveProperty('background')
  })

  it('builds standard multipart reference and mask-edit requests', () => {
    const referenceRequest = {
      ...generationRequest,
      count: 1,
      references: [{ assetId: 'asset-1', intent: 'subject' as const, strength: 0.8 }]
    }
    const reference = protocol.buildEditRequest({
      request: referenceRequest,
      images: [{ name: 'reference-1.png', mimeType: 'image/png', bytes: Buffer.from('reference') }],
      mask: null
    })
    expect(reference.url).toBe('https://images.example.test/v1/images/edits')
    expect(reference.fields).toMatchObject({ model: 'studio-image', n: '1', size: '1024x1280' })
    expect(reference.files.map((file) => file.field)).toEqual(['image[]'])

    const edit: EditRequest = {
      ...generationRequest,
      kind: 'edit',
      count: 1,
      sourceAssetId: 'source',
      maskAssetId: 'mask'
    }
    const builtEdit = protocol.buildEditRequest({
      request: edit,
      images: [{ name: 'source.png', mimeType: 'image/png', bytes: Buffer.from('source') }],
      mask: { name: 'mask.png', mimeType: 'image/png', bytes: Buffer.from('mask') }
    })
    expect(builtEdit.files.map((file) => file.field)).toEqual(['image[]', 'mask'])
  })

  it('rejects URL-only output instead of following an unapproved destination', () => {
    expect(() => protocol.parseResponse({ data: [{ url: 'https://cdn.example.test/image.png' }] }))
      .toThrow(/Base64/)
  })
})
