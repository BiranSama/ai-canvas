import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KRILL_IMAGE_CAPABILITIES,
  KRILL_IMAGE_MODELS,
  KrillImageProvider,
  KrillImagesProtocol,
  type KrillTransport
} from '../../src/main/generation'
import type { GenerationRequest } from '../../src/shared/generation'

const roots: string[] = []

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: 'A quiet editorial product image with soft window light',
    negativePrompt: 'readable brand marks',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 1024,
    outputHeight: 1280,
    count: 1,
    providerId: 'krill-image',
    model: 'qwen-image-2.0',
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

afterEach(async () => {
  vi.restoreAllMocks()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

describe('Krill offline image contract', () => {
  it('pins the endpoint, emits one asynchronous image request and never contains credentials', () => {
    const protocol = new KrillImagesProtocol()
    const built = protocol.buildGenerationRequest(request())
    expect(built).toEqual({
      url: 'https://api.krill-ai.net/v1/images/generations',
      body: {
        model: 'qwen-image-2.0',
        prompt: '画幅比例严格保持 4:5。\nA quiet editorial product image with soft window light\n\n避免出现：readable brand marks',
        size: '1024x1280',
        n: 1,
        async: true,
        stream: false,
        response_format: 'url'
      }
    })
    expect(JSON.stringify(built)).not.toMatch(/api.?key|authorization|bearer/i)
    expect(() => new KrillImagesProtocol({ baseUrl: 'https://example.test/v1' })).toThrow(/pinned/)
    expect(() => protocol.buildGenerationRequest(request({ count: 2 }))).toThrow(/exactly one/)
    expect(() => protocol.buildGenerationRequest(request({ model: 'gpt-image-2' }))).toThrow()
    expect(() => protocol.buildGenerationRequest(request({
      references: [{ assetId: 'reference-1', intent: 'style', strength: 0.7 }]
    }))).toThrow(/not verified/)

    const restricted = new KrillImagesProtocol({ allowedModels: ['qwen-image-2.0'] })
    expect(() => restricted.buildGenerationRequest(request({ model: 'wan2.7-image' }))).toThrow(/outside this authorization/)
    expect(restricted.parseModelList({ data: [
      { id: 'qwen-image-2.0' },
      { id: 'wan2.7-image' }
    ] })).toEqual(['qwen-image-2.0'])
  })

  it('normalizes the verified model list and asynchronous lifecycle without trusting marketplace-only routes', () => {
    const protocol = new KrillImagesProtocol()
    expect(protocol.parseModelList({ data: [
      { id: 'wan2.7-image' },
      { id: 'gpt-image-2' },
      { id: 'qwen-image-2.0-pro' },
      { id: 'unrelated-text-model' }
    ] })).toEqual(['qwen-image-2.0-pro', 'wan2.7-image'])

    expect(protocol.parseSubmission({ id: 'task-1', status: 'queued' })).toEqual({
      kind: 'pending', taskId: 'task-1', status: 'queued'
    })
    expect(protocol.parseTask({ status: 'completed' }, 'task-1')).toEqual({
      kind: 'completed', taskId: 'task-1', images: []
    })
    expect(protocol.parseTask({
      status: 'completed',
      data: [{ b64_json: 'iVBORw0KGgo=' }]
    }, 'task-1')).toEqual({
      kind: 'completed', taskId: 'task-1', images: [{ kind: 'base64', value: 'iVBORw0KGgo=' }]
    })
    expect(() => protocol.parseTask({ status: 'failed', error: { code: 404, message: 'no route available' } }, 'task-1'))
      .toThrow(/404: no route available/)
  })

  it('persists the task callback, polls, downloads from the pinned content endpoint and verifies image bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-krill-'))
    roots.push(root)
    const png = await sharp({
      create: { width: 8, height: 10, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } }
    }).png().toBuffer()
    const transport: KrillTransport = {
      postJson: vi.fn(async () => ({ id: 'task-verified-1', status: 'queued' })),
      getJson: vi.fn()
        .mockResolvedValueOnce({ id: 'task-verified-1', status: 'processing' })
        .mockResolvedValueOnce({ id: 'task-verified-1', status: 'completed' }),
      getImage: vi.fn(async (input) => {
        expect(input.url).toBe('https://api.krill-ai.net/v1/images/task-verified-1/content')
        return { bytes: png, mimeType: 'image/png' as const }
      })
    }
    const provider = new KrillImageProvider({
      protocol: new KrillImagesProtocol(), transport, stagingDirectory: root, pollIntervalMs: 1
    })
    const stages: string[] = []
    const taskIds: string[] = []
    const outputs = await provider.generate(request(), {
      signal: new AbortController().signal,
      onStage: async (stage) => { stages.push(stage) },
      onExternalTaskId: async (taskId) => { taskIds.push(taskId) },
      resolveAsset: async () => { throw new Error('No reference expected') }
    })

    expect(taskIds).toEqual(['task-verified-1'])
    expect(stages).toEqual(['submitting', 'generating', 'localizing'])
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.mimeType).toBe('image/png')
    await expect(readFile(outputs[0]!.filePath)).resolves.toEqual(png)
    expect(transport.postJson).toHaveBeenCalledTimes(1)
    expect(transport.getJson).toHaveBeenCalledTimes(2)
    expect(transport.getImage).toHaveBeenCalledTimes(1)
  })

  it('resumes an existing task without resubmission and keeps unverified capabilities disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-krill-resume-'))
    roots.push(root)
    const jpeg = await sharp({
      create: { width: 6, height: 6, channels: 3, background: { r: 100, g: 80, b: 60 } }
    }).jpeg().toBuffer()
    const transport: KrillTransport = {
      postJson: vi.fn(async () => { throw new Error('resume must not submit') }),
      getJson: vi.fn(async () => ({ status: 'completed' })),
      getImage: vi.fn(async () => ({ bytes: jpeg, mimeType: 'image/jpeg' as const }))
    }
    const provider = new KrillImageProvider({
      protocol: new KrillImagesProtocol(), transport, stagingDirectory: root, pollIntervalMs: 1
    })
    const output = await provider.resume(request(), 'task-resume-1', {
      signal: new AbortController().signal,
      onStage: async () => undefined,
      onExternalTaskId: async () => undefined,
      resolveAsset: async () => { throw new Error('No reference expected') }
    })
    expect(output[0]?.mimeType).toBe('image/jpeg')
    expect(transport.postJson).not.toHaveBeenCalled()
    expect(KRILL_IMAGE_MODELS).toEqual([
      'qwen-image-2.0', 'qwen-image-2.0-pro', 'wan2.7-image', 'wan2.7-image-pro'
    ])
    expect(KRILL_IMAGE_CAPABILITIES).toMatchObject({
      textToImage: true,
      imageReferences: false,
      maskEditing: false,
      multipleReferences: false,
      transparentOutput: false,
      maxImages: 1
    })
  })

  it('stops polling at the configured safety limit without downloading or resubmitting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-krill-poll-limit-'))
    roots.push(root)
    const transport: KrillTransport = {
      postJson: vi.fn(async () => ({ id: 'task-poll-limit', status: 'queued' })),
      getJson: vi.fn(async () => ({ id: 'task-poll-limit', status: 'processing' })),
      getImage: vi.fn(async () => { throw new Error('poll limit must prevent download') })
    }
    const provider = new KrillImageProvider({
      protocol: new KrillImagesProtocol({ allowedModels: ['qwen-image-2.0'] }),
      transport,
      stagingDirectory: root,
      pollIntervalMs: 1,
      maxPollRequests: 2
    })

    await expect(provider.generate(request(), {
      signal: new AbortController().signal,
      onStage: async () => undefined,
      onExternalTaskId: async () => undefined,
      resolveAsset: async () => { throw new Error('No reference expected') }
    })).rejects.toMatchObject({ code: 'KRILL_POLL_LIMIT_REACHED', stage: 'generating' })
    expect(transport.postJson).toHaveBeenCalledTimes(1)
    expect(transport.getJson).toHaveBeenCalledTimes(2)
    expect(transport.getImage).not.toHaveBeenCalled()
  })
})
