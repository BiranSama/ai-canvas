import { describe, expect, it, vi } from 'vitest'
import { ArkResponsesLlmProtocol, ResponsesLlmProtocol } from '../../src/main/agent/ark-responses-protocol'
import { LlmProviderRegistry, OpenAiCompatibleLlmProtocol } from '../../src/main/agent/llm-provider'
import { compileSeedreamVisualEditReference } from '../../src/main/edit/seedream-visual-edit-compiler'
import { ArkSeedreamProtocol } from '../../src/main/generation/ark-seedream-protocol'
import { downloadRemoteImage } from '../../src/main/generation/remote-image'
import type { EditRequest, GenerationRequest } from '../../src/shared/generation'
import sharp from 'sharp'

const baseGenerationRequest: GenerationRequest = {
  prompt: '一张克制、雅致的香水广告图',
  negativePrompt: '杂乱背景',
  aspectWidth: 4,
  aspectHeight: 5,
  outputWidth: 1728,
  outputHeight: 2160,
  count: 1,
  providerId: 'image-provider',
  model: 'doubao-seedream-5-0-260128',
  references: [],
  parameters: {},
  sourceMessageId: null,
  parentResultId: null,
  referenceMode: 'hybrid',
  variationInstruction: '',
  preserveConstraints: ''
}

const transparentPng = 'data:image/png;base64,iVBORw0KGgo='

describe('provider protocol contracts without external calls', () => {
  it('maps OpenAI-compatible chat, tools, responses and SSE into a stable local contract', () => {
    const protocol = new OpenAiCompatibleLlmProtocol({
      baseUrl: 'https://llm.example.test/v1',
      model: 'fixture-model',
      reasoningEffort: 'max',
      imageDetail: 'original',
      vision: true
    })
    const registry = new LlmProviderRegistry([protocol])
    const request = registry.get('openai-compatible-llm').buildRequest({
      messages: [{ role: 'user', content: 'Move the title.' }],
      images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
      tools: [{ name: 'applySceneBatch', description: 'Apply one batch.', parameters: { type: 'object' } }],
      toolChoice: { name: 'applySceneBatch' },
      temperature: 0,
      maxOutputTokens: 512
    }, true)
    expect(request).toMatchObject({
      url: 'https://llm.example.test/v1/chat/completions',
      body: {
        model: 'fixture-model',
        stream: true,
        tool_choice: { type: 'function', function: { name: 'applySceneBatch' } },
        reasoning_effort: 'max',
        temperature: 0,
        max_tokens: 512
      }
    })
    expect(request.body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Move the title.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'original' } }
      ]
    }])
    expect(JSON.stringify(request)).not.toMatch(/api.?key|authorization/i)

    expect(protocol.parseResponse({
      id: 'chatcmpl-fixture',
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'applySceneBatch', arguments: '{"commands":[]}' } }] }
      }]
    })).toMatchObject({ toolCalls: [{ id: 'call-1', name: 'applySceneBatch', arguments: { commands: [] } }] })

    const events = protocol.parseEventStream([
      'data: {"id":"chatcmpl-fixture","choices":[{"delta":{"content":"好"}}]}',
      'data: {"id":"chatcmpl-fixture","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"applySceneBatch","arguments":"{\\"commands\\":"}}]}}]}',
      'data: {"id":"chatcmpl-fixture","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]'
    ].join('\n\n'))
    expect(events).toEqual([
      { type: 'text-delta', id: 'chatcmpl-fixture', text: '好' },
      { type: 'tool-call-delta', id: 'chatcmpl-fixture', index: 0, callId: 'call-1', name: 'applySceneBatch', argumentsDelta: '{"commands":' },
      { type: 'finish', id: 'chatcmpl-fixture', finishReason: 'tool_calls' }
    ])
    expect(() => new OpenAiCompatibleLlmProtocol({
      baseUrl: 'file:///tmp/provider',
      model: 'fixture-model'
    })).toThrow(/HTTP\(S\)/)
    expect(() => new OpenAiCompatibleLlmProtocol({
      baseUrl: 'https://user:password@llm.example.test/v1',
      model: 'fixture-model'
    })).toThrow(/credentials/)
  })

  it('maps Ark Responses API tools without placing credentials in protocol data', () => {
    const protocol = new ArkResponsesLlmProtocol({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-turbo-260628',
      reasoningEffort: 'high',
      imageDetail: 'low',
      vision: true
    })
    const request = protocol.buildRequest({
      messages: [
        { role: 'system', content: 'Operate the canvas safely.' },
        { role: 'user', content: '把标题向左移动。' }
      ],
      images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
      tools: [{ name: 'applySceneBatch', description: 'Apply one batch.', parameters: { type: 'object' } }],
      toolChoice: { name: 'applySceneBatch' },
      temperature: 0,
      maxOutputTokens: 512
    }, true)
    expect(request).toMatchObject({
      url: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      body: {
        model: 'doubao-seed-2-1-turbo-260628',
        stream: true,
        store: false,
        instructions: 'Operate the canvas safely.',
        tool_choice: { type: 'function', name: 'applySceneBatch' },
        reasoning: { effort: 'high' },
        max_output_tokens: 512
      }
    })
    expect(request.body.tools).toEqual([{
      type: 'function',
      name: 'applySceneBatch',
      description: 'Apply one batch.',
      parameters: { type: 'object' }
    }])
    expect(request.body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '把标题向左移动。' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' }
      ]
    }])
    expect(JSON.stringify(request)).not.toMatch(/api.?key|authorization|bearer/i)

    expect(protocol.parseResponse({
      id: 'resp-fixture',
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call-1', name: 'applySceneBatch', arguments: '{"commands":[]}' },
        { type: 'message', content: [{ type: 'output_text', text: '我会先移动标题。' }] }
      ]
    })).toEqual({
      id: 'resp-fixture',
      text: '我会先移动标题。',
      toolCalls: [{ id: 'call-1', name: 'applySceneBatch', arguments: { commands: [] } }],
      finishReason: 'completed'
    })

    expect(protocol.parseEventStream([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","response_id":"resp-fixture","output_index":0,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"applySceneBatch","arguments":""}}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","response_id":"resp-fixture","item_id":"fc-1","output_index":0,"delta":"{\\"commands\\":[]}"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-fixture","status":"completed"}}'
    ].join('\n\n'))).toEqual([
      { type: 'tool-call-delta', id: 'resp-fixture', index: 0, callId: 'call-1', name: 'applySceneBatch', argumentsDelta: '' },
      { type: 'tool-call-delta', id: 'resp-fixture', index: 0, callId: null, name: null, argumentsDelta: '{"commands":[]}' },
      { type: 'finish', id: 'resp-fixture', finishReason: 'completed' }
    ])

    expect(() => protocol.parseResponse({
      id: 'resp-truncated',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'call-cut', name: 'applySceneBatch', arguments: '{"commands":' }]
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_TRUNCATED' }))
  })

  it('maps DeepSeek Vision Responses reasoning and image detail without provider-name sniffing', () => {
    const protocol = new ResponsesLlmProtocol({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'minimal',
      imageDetail: 'low',
      vision: true
    })
    const request = protocol.buildRequest({
      messages: [{ role: 'user', content: '读取画布参考图并提交验证工具。' }],
      images: [{ mimeType: 'image/webp', base64: 'UklGRg==' }],
      tools: [{
        name: 'verifyAiCanvasConnection',
        description: '验证结构化工具调用。',
        parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
      }],
      toolChoice: { name: 'verifyAiCanvasConnection' },
      maxOutputTokens: 4_096
    }, false)

    expect(request).toMatchObject({
      url: 'https://api.deepseek.com/responses',
      body: {
        model: 'deepseek-v4-flash-vision-exp',
        stream: false,
        store: false,
        reasoning: { effort: 'minimal' },
        tool_choice: { type: 'function', name: 'verifyAiCanvasConnection' },
        max_output_tokens: 4_096,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '读取画布参考图并提交验证工具。' },
            { type: 'input_image', image_url: 'data:image/webp;base64,UklGRg==', detail: 'low' }
          ]
        }]
      }
    })
  })

  it('maps Seedream text, reference, group and visual-guided edit requests without network calls', () => {
    const protocol = new ArkSeedreamProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })
    const textRequest = protocol.buildRequest({ request: baseGenerationRequest, images: [] })
    expect(textRequest).toMatchObject({
      url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      body: {
        model: 'doubao-seedream-5-0-260128',
        size: '1728x2160',
        sequential_image_generation: 'disabled',
        stream: false,
        response_format: 'b64_json',
        watermark: false
      }
    })
    expect(textRequest.body).not.toHaveProperty('mask')
    expect(JSON.stringify(textRequest)).not.toMatch(/api.?key|authorization|bearer/i)
    const directEndpoint = new ArkSeedreamProtocol({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    })
    expect(directEndpoint.buildRequest({ request: baseGenerationRequest, images: [] }).url)
      .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')

    const groupRequest = protocol.buildRequest({
      request: {
        ...baseGenerationRequest,
        count: 3,
        references: [{ assetId: 'reference-1', intent: 'style', strength: 0.7 }],
        parameters: { seed: 42, guidanceScale: 4.5 }
      },
      images: [transparentPng]
    })
    expect(groupRequest.body).toMatchObject({
      image: [transparentPng],
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 3 },
      seed: 42,
      guidance_scale: 4.5
    })
    expect(groupRequest.body.prompt).toContain('一组共 3 张')

    const editRequest: EditRequest = {
      ...baseGenerationRequest,
      kind: 'edit',
      sourceAssetId: 'source-1',
      maskAssetId: 'mask-1',
      references: [
        { assetId: 'source-1', intent: 'edit-source', strength: 1 },
        { assetId: 'mask-1', intent: 'mask', strength: 1 }
      ]
    }
    const edit = protocol.buildRequest({ request: editRequest, images: [transparentPng, transparentPng] })
    expect(edit.body.prompt).toContain('图一是必须保留的原图')
    expect(edit.body.prompt).toContain('图二是带红色半透明标记的编辑指示图')
    expect(edit.body).not.toHaveProperty('mask')

    expect(protocol.parseResponse({
      model: 'doubao-seedream-5-0-260128',
      data: [{ b64_json: 'iVBORw0KGgo=', size: '1728x2160' }],
      usage: { generated_images: 1, output_tokens: 321, total_tokens: 321 }
    })).toEqual({
      images: [{ kind: 'base64', value: 'iVBORw0KGgo=', size: '1728x2160' }],
      generatedImages: 1,
      outputTokens: 321,
      totalTokens: 321
    })
  })

  it('compiles a grayscale mask into a bounded Seedream visual edit reference', async () => {
    const source = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 30, b: 40 } }
    }).png().toBuffer()
    const mask = await sharp(Buffer.alloc(4 * 4, 255), {
      raw: { width: 4, height: 4, channels: 1 }
    }).png().toBuffer()
    const compiled = await compileSeedreamVisualEditReference(source, mask)
    expect(compiled).toMatchObject({ width: 4, height: 4, mimeType: 'image/png', mode: 'visual-guided' })
    const pixel = await sharp(compiled.bytes).raw().toBuffer()
    expect(pixel[0]).toBeGreaterThan(20)
    expect(pixel[0]).toBeGreaterThan(pixel[1]! * 2)
    expect(pixel[0]).toBeGreaterThan(pixel[2]!)

    const wrongSizeMask = await sharp(Buffer.alloc(3 * 4, 255), {
      raw: { width: 3, height: 4, channels: 1 }
    }).png().toBuffer()
    await expect(compileSeedreamVisualEditReference(source, wrongSizeMask)).rejects.toThrow(/exactly match/)
  })

  it('localizes only bounded HTTPS image responses and rejects unsafe redirects locally', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/result.png?signature=temporary-secret#download' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' }
      }))
    const image = await downloadRemoteImage('https://images.example.test/result', {
      signal: new AbortController().signal,
      fetcher,
      maxBytes: 8,
      maxRedirects: 1
    })
    expect(image).toMatchObject({ mimeType: 'image/png', finalUrl: 'https://cdn.example.test/result.png' })
    expect(image.finalUrl).not.toContain('temporary-secret')
    expect(image.bytes).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(fetcher).toHaveBeenCalledTimes(2)

    const unsafeFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://cdn.example.test/result.png' }
    }))
    await expect(downloadRemoteImage('https://images.example.test/result', {
      signal: new AbortController().signal,
      fetcher: unsafeFetcher
    })).rejects.toMatchObject({ code: 'REMOTE_IMAGE_PROTOCOL', stage: 'localizing' })

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/webp', 'content-length': '100' }
    }))
    await expect(downloadRemoteImage('https://images.example.test/result', {
      signal: new AbortController().signal,
      fetcher: oversized,
      maxBytes: 16
    })).rejects.toMatchObject({ code: 'REMOTE_IMAGE_TOO_LARGE' })
  })
})
