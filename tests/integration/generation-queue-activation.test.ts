import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GenerationJobRepository,
  GenerationQueue,
  MockImageProvider,
  ProviderRegistry
} from '../../src/main/generation'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { GenerationJob, GenerationRequest } from '../../src/shared/generation'

const roots: string[] = []

function ids(): () => string {
  let value = 96_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(): GenerationRequest {
  return {
    prompt: 'Prepared jobs stay dormant until their owner is ready to observe them.',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 96,
    outputHeight: 120,
    count: 1,
    providerId: 'mock',
    model: 'mock-balanced',
    references: [],
    parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 },
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: ''
  }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S7 generation activation barrier', () => {
  it('does not broadcast or run a prepared Job before explicit activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-generation-activation-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'activation.aicanvas'), 'Activation barrier', { idFactory: nextId })
    const repository = new GenerationJobRepository(join(opened.workspace.directory, 'project.db'), { idFactory: nextId })
    const queue = new GenerationQueue({
      projectId: opened.workspace.metadata.id,
      repository,
      assetStore: opened.workspace.assets,
      providers: new ProviderRegistry([new MockImageProvider(join(root, 'staging'))])
    })
    const observed: GenerationJob[] = []
    queue.subscribe((job) => observed.push(job))

    const prepared = await queue.prepare(request())
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(await repository.getJob(prepared.id)).toMatchObject({ status: 'queued', stage: 'queued' })
    expect(observed).toEqual([])

    await queue.activate(prepared.id)
    await queue.waitForIdle()
    expect((await repository.getJob(prepared.id)).status).toBe('completed')
    expect(observed.map((job) => job.stage)).toEqual(expect.arrayContaining(['queued', 'validating', 'completed']))

    await queue.close()
    await repository.close()
    await opened.workspace.close(true)
  })

  it('records a preflight Provider failure instead of leaving the Job queued forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-generation-preflight-'))
    roots.push(root)
    const nextId = ids()
    const opened = await ProjectWorkspace.create(join(root, 'preflight.aicanvas'), 'Preflight failure', { idFactory: nextId })
    const repository = new GenerationJobRepository(join(opened.workspace.directory, 'project.db'), { idFactory: nextId })
    const queue = new GenerationQueue({
      projectId: opened.workspace.metadata.id,
      repository,
      assetStore: opened.workspace.assets,
      providers: new ProviderRegistry()
    })

    const prepared = await queue.prepare(request())
    await queue.activate(prepared.id)
    await queue.waitForIdle()

    expect(await repository.getJob(prepared.id)).toMatchObject({
      status: 'failed',
      stage: 'failed',
      error: { code: 'PROVIDER_NOT_FOUND' }
    })

    await queue.close()
    await repository.close()
    await opened.workspace.close(true)
  })
})
