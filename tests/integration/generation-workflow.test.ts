import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  GenerationJobRepository,
  GenerationWorkflowCoordinator,
  GenerationWorkflowRepository,
  type GenerationWorkflowQueuePort
} from '../../src/main/generation'
import type { GenerationWorkflowCoordinatorError } from '../../src/main/generation'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { GenerationRequest, ImageTaskRequest, ProviderCapabilities } from '../../src/shared/generation'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function ids(): () => string {
  let value = 82_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

const capabilities: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: true,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png']
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: 'S7 durable mock result',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 1024,
    outputHeight: 1280,
    count: 1,
    providerId: 'mock',
    model: 'mock-balanced',
    references: [],
    parameters: { generationProfileId: 'local-sketch', generationProfileTier: 'local-sketch', actualCostCny: 0 },
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '',
    ...overrides
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s7-'))
  roots.push(root)
  const idFactory = ids()
  const opened = await ProjectWorkspace.create(join(root, 'workflow.aicanvas'), 'Workflow', { idFactory })
  const databasePath = join(opened.workspace.directory, 'project.db')
  const jobs = new GenerationJobRepository(databasePath, { idFactory, now: () => '2026-08-22T18:00:00.000+08:00' })
  const workflows = new GenerationWorkflowRepository(databasePath, { idFactory, now: () => '2026-08-22T18:00:00.000+08:00' })
  closers.push(async () => {
    await workflows.close().catch(() => undefined)
    await jobs.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return { root, idFactory, opened, jobs, workflows }
}

function input(projectId: string, task: ImageTaskRequest, idempotencyKey: string) {
  return {
    projectId,
    request: task,
    capabilities,
    profileId: 'local-sketch',
    tier: 'local-sketch' as const,
    operation: task.parentResultId === null ? 'text' as const : 'similar' as const,
    sourceSceneRevision: 4,
    promptPackage: { version: 1, originalRequirement: task.prompt },
    idempotencyKey,
    limits: { maxJobs: 1, maxImages: 4, maxCostCny: 0, maxWallTimeMs: 120_000, noImprovementLimit: 1 },
    estimatedCostCny: 0
  }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S7 generation workflow repository', () => {
  it('reserves before dispatch, forbids automatic repost after an unknown create, and reconciles the original Job', async () => {
    const value = await fixture()
    let calls = 0
    const reservationStates: string[] = []
    const queue: GenerationWorkflowQueuePort = {
      enqueue: async (task) => {
        calls += 1
        const intentId = String(task.parameters.workflowIntentId)
        reservationStates.push((await value.workflows.getReservation(intentId)).status)
        await value.jobs.createJob({ projectId: value.opened.workspace.metadata.id, request: task })
        throw new Error('simulated crash after durable Job create')
      },
      listJobs: () => value.jobs.listJobs(value.opened.workspace.metadata.id),
      cancel: async (jobId) => value.jobs.requestCancel(jobId)
    }
    const coordinator = new GenerationWorkflowCoordinator({ repository: value.workflows, queue, idFactory: value.idFactory })
    const createInput = input(value.opened.workspace.metadata.id, request(), 'turn:s7:unknown:0')

    await expect(coordinator.create(createInput)).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' } satisfies Partial<GenerationWorkflowCoordinatorError>)
    expect(calls).toBe(1)
    expect(reservationStates).toEqual(['reserved'])
    await expect(coordinator.create(createInput)).rejects.toMatchObject({ code: 'NO_REPOST' } satisfies Partial<GenerationWorkflowCoordinatorError>)
    expect(calls).toBe(1)

    const queued = (await value.jobs.listJobs(value.opened.workspace.metadata.id))[0]
    const intentId = String(queued?.request.parameters.workflowIntentId)
    const reconciled = await coordinator.reconcile(intentId)
    expect(reconciled).toMatchObject({ status: 'waiting', jobId: queued?.id, dispatchAttempts: 1 })
    expect(calls).toBe(1)
  })

  it('records immutable result provenance and groups parent/child results into one family', async () => {
    const value = await fixture()
    const queue: GenerationWorkflowQueuePort = {
      enqueue: (task) => value.jobs.createJob({ projectId: value.opened.workspace.metadata.id, request: task }),
      listJobs: () => value.jobs.listJobs(value.opened.workspace.metadata.id),
      cancel: async (jobId) => value.jobs.requestCancel(jobId)
    }
    const coordinator = new GenerationWorkflowCoordinator({ repository: value.workflows, queue, idFactory: value.idFactory })
    const parent = await coordinator.create(input(value.opened.workspace.metadata.id, request(), 'turn:s7:family:0'))
    await value.jobs.transition(parent.job.id, { status: 'preparing', stage: 'validating', startedAt: '2026-08-22T18:00:00.000+08:00' })
    const parentPath = join(value.root, 'parent.png')
    await sharp({ create: { width: 32, height: 40, channels: 4, background: '#334B68' } }).png().toFile(parentPath)
    const parentAsset = await value.opened.workspace.assets.importImage({ sourcePath: parentPath, sourceType: 'generated', sourceId: parent.job.id })
    const parentCompleted = await value.jobs.completeWithAssets(parent.job.id, [parentAsset])
    await coordinator.observeJob(parentCompleted)
    const parentResult = parentCompleted.results[0]!

    const childRequest = request({
      prompt: 'S7 similar branch',
      parentResultId: parentResult.id,
      referenceMode: 'hybrid',
      variationInstruction: '让光线更柔和，标题更轻盈',
      preserveConstraints: '保持主体身份、画面比例与核心色调'
    })
    const child = await coordinator.create(input(value.opened.workspace.metadata.id, childRequest, 'turn:s7:family:1'))
    await value.jobs.transition(child.job.id, { status: 'preparing', stage: 'validating', startedAt: '2026-08-22T18:00:00.000+08:00' })
    const childPath = join(value.root, 'child.png')
    await sharp({ create: { width: 32, height: 40, channels: 4, background: '#829ABB' } }).png().toFile(childPath)
    const childAsset = await value.opened.workspace.assets.importImage({ sourcePath: childPath, sourceType: 'generated', sourceId: child.job.id })
    const childCompleted = await value.jobs.completeWithAssets(child.job.id, [childAsset])
    await coordinator.observeJob(childCompleted)

    const records = await value.workflows.listResultRecords()
    expect(records).toHaveLength(2)
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ resultId: parentResult.id, profileId: 'local-sketch', sourceSceneRevision: 4, operation: 'text' }),
      expect.objectContaining({ resultId: childCompleted.results[0]?.id, operation: 'similar' })
    ]))
    const families = await coordinator.resultFamilies()
    expect(families).toHaveLength(1)
    expect(families[0]).toMatchObject({
      rootResultId: parentResult.id,
      members: [
        expect.objectContaining({ resultId: parentResult.id, parentResultId: null }),
        expect.objectContaining({
          parentResultId: parentResult.id,
          rootResultId: parentResult.id,
          referenceMode: 'hybrid',
          variationInstruction: '让光线更柔和，标题更轻盈',
          preserveConstraints: '保持主体身份、画面比例与核心色调'
        })
      ]
    })
  })

  it('creates one durable retry Intent with parent Job lineage and reuses it idempotently', async () => {
    const value = await fixture()
    let retryCreates = 0
    const queue: GenerationWorkflowQueuePort = {
      enqueue: (task) => value.jobs.createJob({ projectId: value.opened.workspace.metadata.id, request: task }),
      prepare: (task) => value.jobs.createJob({ projectId: value.opened.workspace.metadata.id, request: task }),
      prepareRetry: async (parentJobId, task) => {
        retryCreates += 1
        const parent = await value.jobs.getJob(parentJobId)
        return value.jobs.createJob({
          projectId: value.opened.workspace.metadata.id,
          request: task,
          attempt: parent.attempt + 1,
          parentJobId: parent.id
        })
      },
      activate: async () => undefined,
      listJobs: () => value.jobs.listJobs(value.opened.workspace.metadata.id),
      cancel: async (jobId) => value.jobs.requestCancel(jobId)
    }
    const coordinator = new GenerationWorkflowCoordinator({ repository: value.workflows, queue, idFactory: value.idFactory })
    const original = await coordinator.create(input(value.opened.workspace.metadata.id, request(), 'turn:s7:retry:original'))
    await value.jobs.transition(original.job.id, { status: 'preparing', stage: 'validating', startedAt: '2026-08-23T08:00:00.000+08:00' })
    const failed = await value.jobs.transition(original.job.id, {
      status: 'failed',
      stage: 'failed',
      completedAt: '2026-08-23T08:00:01.000+08:00',
      error: { code: 'MOCK_FAILURE', message: 'Explicit retry fixture.', stage: 'failed' }
    })
    await coordinator.observeJob(failed)

    const retryInput = {
      ...input(value.opened.workspace.metadata.id, request({ model: 'mock-balanced' }), 'retry:job:attempt:2'),
      parentJobId: original.job.id
    }
    const retried = await coordinator.create(retryInput)
    const replayed = await coordinator.create(retryInput)
    expect(retried.job).toMatchObject({ attempt: 2, parentJobId: original.job.id, status: 'queued' })
    expect(replayed).toMatchObject({ reused: true, job: { id: retried.job.id } })
    expect(retryCreates).toBe(1)
    expect(await value.workflows.getReservation(retried.intent.id)).toMatchObject({ status: 'reserved', actualRequests: 0 })
  })

  it('commits the actual result count and exposes a completed count mismatch for review', async () => {
    const value = await fixture()
    const queue: GenerationWorkflowQueuePort = {
      enqueue: (task) => value.jobs.createJob({ projectId: value.opened.workspace.metadata.id, request: task }),
      listJobs: () => value.jobs.listJobs(value.opened.workspace.metadata.id),
      cancel: async (jobId) => value.jobs.requestCancel(jobId)
    }
    const coordinator = new GenerationWorkflowCoordinator({ repository: value.workflows, queue, idFactory: value.idFactory })
    const created = await coordinator.create(input(
      value.opened.workspace.metadata.id,
      request({ count: 2 }),
      'turn:s7:result-count-mismatch'
    ))
    await value.jobs.transition(created.job.id, { status: 'preparing', stage: 'validating', submissionState: 'accepted', startedAt: '2026-08-23T08:10:00.000+08:00' })
    const completed = await value.jobs.completeWithAssets(created.job.id, [])
    const observed = await coordinator.observeJob(completed)

    expect(observed).toMatchObject({
      status: 'completed',
      errorCode: 'RESULT_COUNT_MISMATCH',
      errorMessage: 'Provider returned 0 result(s); 2 were requested.'
    })
    expect(await value.workflows.getReservation(created.intent.id)).toMatchObject({
      status: 'committed',
      actualRequests: 1,
      actualImages: 0
    })
  })
})
