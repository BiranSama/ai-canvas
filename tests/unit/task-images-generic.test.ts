import { describe, expect, it } from 'vitest'
import { TaskImagesProtocol } from '../../src/main/generation/task-images-protocol'
import type { GenerationRequest } from '../../src/shared/generation'

const request: GenerationRequest = {
  prompt: 'quiet product study',
  negativePrompt: '',
  aspectWidth: 1,
  aspectHeight: 1,
  outputWidth: 1024,
  outputHeight: 1024,
  count: 1,
  providerId: 'image-provider',
  model: 'owner-model',
  references: [],
  parameters: {},
  sourceMessageId: null,
  parentResultId: null,
  referenceMode: 'hybrid',
  variationInstruction: '',
  preserveConstraints: ''
}

describe('generic asynchronous Images protocol without external calls', () => {
  const protocol = new TaskImagesProtocol({
    baseUrl: 'https://tasks.example.test/api/v1',
    allowedModels: ['owner-model']
  })

  it('uses the configured address and arbitrary saved model', () => {
    expect(protocol.buildGenerationRequest(request)).toMatchObject({
      url: 'https://tasks.example.test/api/v1/images/generations',
      body: { model: 'owner-model', n: 1, async: true, response_format: 'url' }
    })
    expect(protocol.buildTaskStatusRequest('task-1')).toEqual({
      url: 'https://tasks.example.test/api/v1/images/task-1'
    })
    expect(protocol.buildTaskContentRequest('task-1')).toEqual({
      url: 'https://tasks.example.test/api/v1/images/task-1/content'
    })
  })

  it('normalizes pending and completed task envelopes', () => {
    expect(protocol.parseSubmission({ image_id: 'task-1', status: 'queued' }))
      .toEqual({ kind: 'pending', taskId: 'task-1', status: 'queued' })
    expect(protocol.parseTask({ status: 'completed' }, 'task-1'))
      .toEqual({ kind: 'completed', taskId: 'task-1', images: [] })
  })

  it('rejects unsupported references, counts, models and unsafe task ids', () => {
    expect(() => protocol.buildGenerationRequest({ ...request, count: 2 })).toThrow(/one image/i)
    expect(() => protocol.buildGenerationRequest({ ...request, model: 'other-model' })).toThrow(/configured/i)
    expect(() => protocol.buildGenerationRequest({
      ...request,
      references: [{ assetId: 'asset-1', intent: 'subject', strength: 0.7 }]
    })).toThrow(/reference/i)
    expect(() => protocol.buildTaskStatusRequest('../escape')).toThrow()
  })
})
