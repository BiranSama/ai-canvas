import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { EditRequest, GenerationJob, GenerationRequest, ProviderCapabilities } from '../../src/shared/generation'
import {
  GenerationJobRepository,
  GenerationQueue,
  MockImageProvider,
  ProviderRegistry,
  type ImageProvider,
  type ProviderGenerateContext,
  type ProviderOutput
} from '../../src/main/generation'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'

const roots: string[] = []

class ResumableFixtureProvider implements ImageProvider {
  readonly id = 'resumable-fixture'
  readonly label = 'Resumable Fixture'
  readonly capabilities: ProviderCapabilities = {
    textToImage: true,
    imageReferences: false,
    maskEditing: false,
    multipleReferences: false,
    transparentOutput: false,
    maxImages: 1,
    supportedRatios: ['custom'],
    supportedFormats: ['png']
  }
  readonly generatedTaskIds: string[] = []
  readonly resumedTaskIds: string[] = []
  readonly #stagingDirectory: string

  constructor(stagingDirectory: string) {
    this.#stagingDirectory = stagingDirectory
  }

  async #output(context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    await context.onStage('generating')
    await context.onStage('localizing')
    await mkdir(this.#stagingDirectory, { recursive: true })
    const filePath = join(this.#stagingDirectory, `${crypto.randomUUID()}.png`)
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#4878A8' } }).png().toFile(filePath)
    return [{ filePath, mimeType: 'image/png' }]
  }

  async generate(_request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    await context.onStage('submitting')
    const taskId = 'fixture-task-created'
    this.generatedTaskIds.push(taskId)
    await context.onExternalTaskId(taskId)
    return this.#output(context)
  }

  async edit(): Promise<readonly ProviderOutput[]> {
    throw new Error('Fixture editing is unsupported')
  }

  async resume(_request: GenerationRequest | EditRequest, externalTaskId: string, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.resumedTaskIds.push(externalTaskId)
    return this.#output(context)
  }
}

function idFactory(): () => string {
  let value = 1_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: 'A quiet pearl perfume still life with soft blue light',
    negativePrompt: '',
    aspectWidth: 1,
    aspectHeight: 1,
    outputWidth: 192,
    outputHeight: 192,
    count: 1,
    providerId: 'mock',
    model: 'mock-balanced',
    references: [],
    parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 5 },
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '',
    ...overrides
  }
}

async function harness(options: { readonly timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-generation-'))
  roots.push(root)
  const ids = idFactory()
  const projectDirectory = join(root, 'mock.aicanvas')
  const opened = await ProjectWorkspace.create(projectDirectory, 'Mock generation', { idFactory: ids })
  const repository = new GenerationJobRepository(join(projectDirectory, 'project.db'), { idFactory: ids })
  const providers = new ProviderRegistry([new MockImageProvider(join(root, 'staging'))])
  const queue = new GenerationQueue({
    projectId: opened.workspace.metadata.id,
    repository,
    assetStore: opened.workspace.assets,
    providers,
    timeoutMs: options.timeoutMs ?? 2_000
  })
  await queue.initialize()
  return { root, projectDirectory, opened, repository, queue }
}

async function closeHarness(value: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await value.queue.close()
  await value.repository.close()
  await value.opened.workspace.close(true)
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('persistent generation queue', () => {
  it('uses the persisted total deadline on resume and excludes time spent queued', async () => {
    const root = await mkdtemp(join(tmpdir(), 'queue-deadline-'))
    roots.push(root)
    const opened = await ProjectWorkspace.create(join(root, 'deadline.aicanvas'), 'Deadline fixture')
    const repository = new GenerationJobRepository(join(opened.workspace.directory, 'project.db'))
    const provider = new ResumableFixtureProvider(join(root, 'staging'))
    const now = Date.now()
    const expired = await repository.createJob({ projectId: opened.workspace.metadata.id,
      request: request({ providerId: provider.id, model: 'fixture-model' }), effectiveTimeoutMs: 300_000 })
    await repository.transition(expired.id, { status: 'preparing', stage: 'generating',
      startedAt: new Date(now - 300_001).toISOString(), externalTaskId: 'already-expired' })
    const remaining = await repository.createJob({ projectId: opened.workspace.metadata.id,
      request: request({ providerId: provider.id, model: 'fixture-model' }), effectiveTimeoutMs: 300_000 })
    await repository.transition(remaining.id, { status: 'preparing', stage: 'generating',
      startedAt: new Date(now - 180_000).toISOString(), externalTaskId: 'within-original-deadline' })
    const queued = await repository.createJob({ projectId: opened.workspace.metadata.id,
      request: request({ providerId: provider.id, model: 'fixture-model' }), effectiveTimeoutMs: 300_000 })
    const queue = new GenerationQueue({ projectId: opened.workspace.metadata.id, repository, assetStore: opened.workspace.assets,
      providers: new ProviderRegistry([provider]), timeoutMs: 1, now: () => new Date(now).toISOString() })
    try {
      await queue.initialize()
      await queue.waitForIdle()
      expect(await repository.getJob(expired.id)).toMatchObject({ status: 'timed_out', error: { code: 'GENERATION_TIMEOUT' } })
      expect(await repository.getJob(remaining.id)).toMatchObject({ status: 'completed', startedAt: new Date(now - 180_000).toISOString() })
      expect(await repository.getJob(queued.id)).toMatchObject({ status: 'completed', startedAt: new Date(now).toISOString() })
      expect(provider.resumedTaskIds).toEqual(['within-original-deadline'])
      expect(provider.generatedTaskIds).toHaveLength(1)
    } finally {
      await queue.close()
      await repository.close()
      await opened.workspace.close(true)
    }
  })

  it('runs the deterministic provider through honest stages and stores immutable result assets', async () => {
    const value = await harness()
    const seen: GenerationJob[] = []
    value.queue.subscribe((job) => seen.push(job))
    const created = await value.queue.enqueue(request({ count: 2, sourceMessageId: 'message-01' }))
    await value.queue.waitForIdle()

    const completed = await value.repository.getJob(created.id)
    expect(completed).toMatchObject({
      status: 'completed',
      stage: 'completed',
      sourceMessageId: 'message-01',
      error: null
    })
    expect(completed.results).toHaveLength(2)
    expect(seen.map((job) => job.stage)).toEqual(
      expect.arrayContaining(['queued', 'validating', 'submitting', 'generating', 'localizing', 'completed'])
    )
    const assets = await value.opened.workspace.repository.listAssets()
    expect(assets).toHaveLength(2)
    expect(assets[0]).toMatchObject({ sourceType: 'generated', sourceId: created.id, status: 'available' })
    await expect(stat(value.opened.workspace.assets.resolveOriginal(assets[0]!))).resolves.toBeDefined()
    await closeHarness(value)
  })

  it('retains the request, provider stage and actionable error after a provider failure', async () => {
    const value = await harness()
    const created = await value.queue.enqueue(request({ model: 'mock-failure', prompt: 'Preserve this exact prompt' }))
    await value.queue.waitForIdle()

    const failed = await value.repository.getJob(created.id)
    expect(failed).toMatchObject({
      status: 'failed',
      request: { prompt: 'Preserve this exact prompt' },
      error: { code: 'MOCK_PROVIDER_FAILURE', stage: 'generating' }
    })
    expect(failed.results).toHaveLength(0)
    await closeHarness(value)
  })

  it('distinguishes timeout from failure and cancellation without fake progress', async () => {
    const value = await harness({ timeoutMs: 30 })
    const timedOut = await value.queue.enqueue(request({ model: 'mock-timeout', parameters: { mockSubmitDelayMs: 1 } }))
    await value.queue.waitForIdle()
    await expect(value.repository.getJob(timedOut.id)).resolves.toMatchObject({
      status: 'timed_out',
      stage: 'timed_out',
      error: { code: 'GENERATION_TIMEOUT' }
    })

    const slow = await value.queue.enqueue(request({ model: 'mock-slow', parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 500 } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await value.queue.cancel(slow.id)
    await value.queue.waitForIdle()
    await expect(value.repository.getJob(slow.id)).resolves.toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      error: { code: 'USER_CANCELLED' }
    })
    await closeHarness(value)
  })

  it('cancels a queued job without disturbing the active job', async () => {
    const value = await harness()
    const first = await value.queue.enqueue(request({ model: 'mock-slow', parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 80 } }))
    const second = await value.queue.enqueue(request({ prompt: 'Never start this request' }))
    await value.queue.cancel(second.id)
    await value.queue.waitForIdle()

    await expect(value.repository.getJob(first.id)).resolves.toMatchObject({ status: 'completed' })
    await expect(value.repository.getJob(second.id)).resolves.toMatchObject({ status: 'cancelled', startedAt: null })
    await closeHarness(value)
  })

  it('marks abandoned active work as interrupted and leaves it retryable after restart', async () => {
    const value = await harness()
    const abandoned = await value.repository.createJob({
      projectId: value.opened.workspace.metadata.id,
      request: request()
    })
    await value.repository.transition(abandoned.id, {
      status: 'preparing',
      stage: 'submitting',
      startedAt: '2026-08-10T00:00:00.000Z'
    })
    const recoveredCount = await value.queue.initialize()

    expect(recoveredCount).toBe(1)
    await expect(value.repository.getJob(abandoned.id)).resolves.toMatchObject({
      status: 'interrupted',
      error: { code: 'APP_INTERRUPTED' }
    })
    await closeHarness(value)
  })

  it('persists an external task receipt and resumes a preserved remote task without resubmitting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-generation-resume-'))
    roots.push(root)
    const ids = idFactory()
    const projectDirectory = join(root, 'resume.aicanvas')
    const opened = await ProjectWorkspace.create(projectDirectory, 'Remote resume', { idFactory: ids })
    const repository = new GenerationJobRepository(join(projectDirectory, 'project.db'), { idFactory: ids })
    const provider = new ResumableFixtureProvider(join(root, 'staging'))
    const providers = new ProviderRegistry([provider])
    const queue = new GenerationQueue({
      projectId: opened.workspace.metadata.id,
      repository,
      assetStore: opened.workspace.assets,
      providers,
      timeoutMs: 2_000
    })
    await queue.initialize()
    const submitted = await queue.enqueue(request({ providerId: provider.id, model: 'fixture-model' }))
    await queue.waitForIdle()
    await expect(repository.getJob(submitted.id)).resolves.toMatchObject({
      status: 'completed', externalTaskId: 'fixture-task-created'
    })

    const abandoned = await repository.createJob({
      projectId: opened.workspace.metadata.id,
      request: request({ providerId: provider.id, model: 'fixture-model' })
    })
    await repository.transition(abandoned.id, {
      status: 'preparing',
      stage: 'submitting',
      startedAt: new Date().toISOString()
    })
    await repository.transition(abandoned.id, {
      status: 'generating',
      stage: 'generating',
      externalTaskId: 'fixture-task-resume',
    })
    const recoveredCount = await queue.initialize()
    await queue.waitForIdle()

    expect(recoveredCount).toBe(0)
    expect(provider.generatedTaskIds).toEqual(['fixture-task-created'])
    expect(provider.resumedTaskIds).toEqual(['fixture-task-resume'])
    await expect(repository.getJob(abandoned.id)).resolves.toMatchObject({
      status: 'completed', externalTaskId: 'fixture-task-resume', error: null
    })
    await queue.close()
    await repository.close()
    await opened.workspace.close(true)
  })

  it('retries from the preserved request while recording attempt and job lineage', async () => {
    const value = await harness()
    const parent = await value.queue.enqueue(request({ prompt: 'Parent generation' }))
    await value.queue.waitForIdle()
    const parentResult = (await value.repository.getJob(parent.id)).results[0]
    expect(parentResult).toBeDefined()
    const original = await value.queue.enqueue(request({ model: 'mock-failure', parentResultId: parentResult!.id }))
    await value.queue.waitForIdle()
    const retried = await value.queue.retry(original.id, { model: 'mock-balanced' })
    await value.queue.waitForIdle()

    const completed = await value.repository.getJob(retried.id)
    expect(completed.error).toBeNull()
    expect(completed).toMatchObject({
      status: 'completed',
      parentJobId: original.id,
      attempt: 2,
      request: { prompt: original.request.prompt, parentResultId: parentResult!.id }
    })
    expect(completed.results[0]).toMatchObject({ parentResultId: parentResult!.id })
    await closeHarness(value)
  })
})
