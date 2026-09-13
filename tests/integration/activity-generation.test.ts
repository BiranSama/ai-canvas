import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('generation activity projection', () => {
  it('persists queue lifecycle events and exposes a locatable result without raw request data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-activity-generation-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    const job = await runtime.enqueue({
      prompt: 'safe mock activity fixture',
      negativePrompt: '',
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 640,
      outputHeight: 800,
      count: 1,
      providerId: 'mock',
      model: 'mock-balanced',
      references: [],
      parameters: {},
      sourceMessageId: null,
      parentResultId: null,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: ''
    })
    const started = Date.now()
    while (Date.now() - started < 5_000) {
      const current = (await runtime.listJobs()).find((candidate) => candidate.id === job.id)
      if (current?.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await runtime.close()

    const reopened = await GenerationRuntime.create(root)
    const activity = (await reopened.getConversation()).activities.find((candidate) => candidate.jobId === job.id)
    expect(activity).toMatchObject({
      kind: 'generation',
      state: 'completed',
      progress: 1,
      objectLabel: '1 张图片',
      actionLabel: '生成图片',
      recoverable: false,
      affectedIds: [expect.any(String)],
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: 'generation.queued' }),
        expect.objectContaining({ eventType: 'generation.completed' })
      ])
    })
    expect(JSON.stringify(activity)).not.toContain('safe mock activity fixture')
    await reopened.close()
  })
})
