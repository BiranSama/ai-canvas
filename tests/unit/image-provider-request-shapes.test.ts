import { describe, expect, it } from 'vitest'
import { ArkSeedreamProtocol, seedreamCapabilitiesFor } from '../../src/main/generation/ark-seedream-protocol'
import { OpenAiImagesProtocol, openAiImagesCapabilitiesFor } from '../../src/main/generation/openai-images-protocol'
import { familyPrompt, imagePromptFamily } from '../../src/main/generation/image-prompt-families'
import type { GenerationRequest } from '../../src/shared/generation'

function request(model: string, overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: '晨雾中的玻璃香水瓶',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 1024,
    outputHeight: 1280,
    count: 1,
    providerId: 'image-provider',
    model,
    references: [],
    parameters: {},
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '',
    ...overrides
  }
}

function openAi(model: string): OpenAiImagesProtocol {
  return new OpenAiImagesProtocol({ baseUrl: 'https://api.openai.com/v1', allowedModels: [model] })
}

function pixels(size: unknown): number {
  const [width, height] = String(size).split('x').map(Number)
  return (width ?? 0) * (height ?? 0)
}

describe('OpenAI image request shapes', () => {
  it('omits response_format for gpt-image models, which reject it', () => {
    const generation = openAi('gpt-image-2').buildGenerationRequest(request('gpt-image-2'))
    expect(generation.body).not.toHaveProperty('response_format')
    const edit = openAi('gpt-image-2').buildEditRequest({
      request: request('gpt-image-2'),
      images: [{ name: 'source.png', mimeType: 'image/png', bytes: Buffer.from('source') }],
      mask: null
    })
    expect(edit.fields).not.toHaveProperty('response_format')
  })

  it('still asks other OpenAI-compatible services for Base64 output', () => {
    expect(openAi('studio-image').buildGenerationRequest(request('studio-image')).body)
      .toMatchObject({ response_format: 'b64_json' })
  })

  it('rounds gpt-image-2 sizes to the 16 px grid it requires', () => {
    const body = openAi('gpt-image-2').buildGenerationRequest(request('gpt-image-2', {
      aspectWidth: 7, aspectHeight: 5, outputWidth: 1280, outputHeight: 914
    })).body
    expect(body.size).toBe('1280x912')
  })

  it('keeps gpt-image-2 sizes inside its pixel range and 3:1 aspect limit', () => {
    const small = openAi('gpt-image-2').buildGenerationRequest(request('gpt-image-2', {
      aspectWidth: 1, aspectHeight: 1, outputWidth: 512, outputHeight: 512
    })).body.size
    expect(pixels(small)).toBeGreaterThanOrEqual(655_360)
    const banner = String(openAi('gpt-image-2').buildGenerationRequest(request('gpt-image-2', {
      aspectWidth: 4, aspectHeight: 1, outputWidth: 2560, outputHeight: 640
    })).body.size).split('x').map(Number)
    expect((banner[0] ?? 0) / (banner[1] ?? 1)).toBeLessThanOrEqual(3)
    expect((banner[0] ?? 0) % 16).toBe(0)
    expect((banner[1] ?? 0) % 16).toBe(0)
  })

  it('picks the closest preset for gpt-image-1.x, which only takes three sizes', () => {
    expect(openAi('gpt-image-1.5').buildGenerationRequest(request('gpt-image-1.5')).body.size).toBe('1024x1536')
    expect(openAi('gpt-image-1').buildGenerationRequest(request('gpt-image-1', {
      aspectWidth: 16, aspectHeight: 9, outputWidth: 1280, outputHeight: 720
    })).body.size).toBe('1536x1024')
    expect(openAi('gpt-image-1-mini').buildGenerationRequest(request('gpt-image-1-mini', {
      aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024
    })).body.size).toBe('1024x1024')
  })
})

describe('Seedream request shapes per model', () => {
  const protocol = new ArkSeedreamProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })

  it('raises a large 5.0 lite request to its minimum pixel count instead of sending an invalid size', () => {
    const body = protocol.buildRequest({
      request: request('doubao-seedream-5-0-260128', { aspectWidth: 16, aspectHeight: 9, outputWidth: 1600, outputHeight: 900 }),
      images: []
    }).body
    expect(body.size).toBe('2560x1440')
  })

  it('lowers a 5.0 pro request that exceeds its maximum pixel count', () => {
    const body = protocol.buildRequest({
      request: request('doubao-seedream-5-0-pro-260628', { outputWidth: 2048, outputHeight: 2560 }),
      images: []
    }).body
    expect(pixels(body.size)).toBeLessThanOrEqual(4_624_220)
    expect(body.size).toBe('1920x2400')
  })

  it('sends image-set fields only to models that support them', () => {
    const pro = protocol.buildRequest({ request: request('doubao-seedream-5-0-pro-260628'), images: [] }).body
    expect(pro).not.toHaveProperty('sequential_image_generation')
    expect(() => protocol.buildRequest({ request: request('doubao-seedream-5-0-pro-260628', { count: 2 }), images: [] }))
      .toThrow(/at most 1/)
    expect(seedreamCapabilitiesFor('doubao-seedream-5-0-pro-260628').maxImages).toBe(1)
    expect(seedreamCapabilitiesFor('doubao-seedream-4-5-251128').maxImages).toBe(4)
  })

  it('ignores a configured preset the model does not offer', () => {
    const body = protocol.buildRequest({
      request: request('doubao-seedream-5-0-flash-260915', { parameters: { seedreamSize: '4K' } }),
      images: []
    }).body
    expect(body.size).toBe('2K')
  })

  it('keeps seed and guidance scale for SeedEdit 3.0, which supports them, and lets it keep the input size', () => {
    const source = 'data:image/png;base64,iVBORw0KGgo='
    const body = protocol.buildRequest({
      request: request('doubao-seededit-3-0-i2i-250628', {
        references: [{ assetId: 'source', intent: 'edit-source', strength: 1 }],
        parameters: { seed: 7, guidanceScale: 5.5 }
      }),
      images: [source]
    }).body
    expect(body).toMatchObject({ size: 'adaptive', seed: 7, guidance_scale: 5.5 })
  })

  it('sends only the universally accepted shape to an unrecognised model', () => {
    const body = protocol.buildRequest({
      request: request('doubao-seedream-9-0-future', { outputWidth: 2048, outputHeight: 2560, parameters: { seed: 3 } }),
      images: []
    }).body
    expect(body).toMatchObject({ size: '2K' })
    expect(body).not.toHaveProperty('sequential_image_generation')
    expect(body).not.toHaveProperty('seed')
  })
})

describe('Grok Imagine request shape', () => {
  it('sends an aspect ratio and a resolution instead of pixel sizes, and no frame sentence', () => {
    const body = new OpenAiImagesProtocol({ baseUrl: 'https://api.x.ai/v1', allowedModels: ['grok-imagine-image'] })
      .buildGenerationRequest(request('grok-imagine-image', { aspectWidth: 7, aspectHeight: 5, outputWidth: 2048, outputHeight: 1463, count: 2 })).body
    expect(body).toEqual({
      model: 'grok-imagine-image',
      prompt: '晨雾中的玻璃香水瓶',
      n: 2,
      response_format: 'b64_json',
      aspect_ratio: '4:3',
      resolution: '2k'
    })
  })

  it('declares only text-to-image until references and edits are mapped', () => {
    expect(openAiImagesCapabilitiesFor('grok-imagine-image')).toMatchObject({ textToImage: true, imageReferences: false, maskEditing: false, transparentOutput: false })
    expect(openAiImagesCapabilitiesFor('gpt-image-2')).toMatchObject({ imageReferences: true, maskEditing: true })
    expect(() => new OpenAiImagesProtocol({ baseUrl: 'https://api.x.ai/v1', allowedModels: ['grok-imagine-image'] })
      .buildEditRequest({ request: request('grok-imagine-image'), images: [{ name: 'a.png', mimeType: 'image/png', bytes: Buffer.from('x') }], mask: null }))
      .toThrow(/not supported/)
  })
})

describe('image prompt families', () => {
  it('recognises families by model name', () => {
    expect(['gpt-image-2', 'doubao-seedream-5-0-260128', 'grok-imagine-image', 'gemini-3-pro-image', 'ep-20260101-x'].map(imagePromptFamily))
      .toEqual(['gpt-image', 'seedream', 'grok', 'gemini', 'generic'])
  })

  it('frames the ratio in words except where a parameter carries it, and groups images only for Seedream', () => {
    const negative = request('gpt-image-2', { negativePrompt: '水印', count: 2 })
    expect(familyPrompt(negative)).toBe('画幅比例严格保持 4:5。\n晨雾中的玻璃香水瓶\n\n避免出现：水印')
    expect(familyPrompt({ ...negative, model: 'grok-imagine-image' })).toBe('晨雾中的玻璃香水瓶\n\n避免出现：水印')
    expect(familyPrompt(negative, 'seedream')).toMatch(/^请生成一组共 2 张内容关联/)
  })
})
