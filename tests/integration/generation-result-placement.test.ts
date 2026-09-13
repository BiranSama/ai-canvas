import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob, GenerationRequest } from '../../src/shared/generation'

const roots: string[] = []

function request(): GenerationRequest {
  return {
    prompt: 'Quiet blue editorial object for reversible placement',
    negativePrompt: '',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 320,
    outputHeight: 400,
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
  }
}

async function waitForCompleted(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job?.status === 'completed') return job
    if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
      throw new Error(`Generation ended as ${job.status}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Generation did not complete in time.')
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S7 generation result actions', () => {
  it('places a result through Main once, replays by placement id, favorites it, and undoes the exact batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-result-place-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    const completed = await waitForCompleted(runtime, (await runtime.enqueue(request())).id)
    const result = completed.results[0]
    expect(result).toBeDefined()
    const placementId = '00000000-0000-4000-8000-000000099001'

    const placed = await runtime.placeGenerationResult({ resultId: result!.id, placementId, origin: 'user' })
    expect(placed).toMatchObject({
      resultId: result!.id,
      jobId: completed.id,
      assetId: result!.assetId,
      elementId: placementId,
      batchId: placementId,
      reused: false
    })
    expect(runtime.getWorkspaceBootstrap().scene.elements).toEqual([
      expect.objectContaining({
        id: placementId,
        type: 'image',
        assetId: result!.assetId,
        semanticRole: 'generated-result',
        provenance: expect.objectContaining({ origin: 'mock-generated', sourceAssetId: result!.assetId })
      })
    ])

    const replayed = await runtime.placeGenerationResult({ resultId: result!.id, placementId, origin: 'user' })
    expect(replayed).toMatchObject({ elementId: placementId, batchId: placementId, reused: true })
    expect(runtime.getWorkspaceBootstrap().scene.elements).toHaveLength(1)

    const families = await runtime.setGenerationResultFavorite({ resultId: result!.id, favorite: true })
    expect(families).toEqual([
      expect.objectContaining({
        rootResultId: result!.id,
        favoriteResultIds: [result!.id],
        members: [expect.objectContaining({ resultId: result!.id, favorite: true })]
      })
    ])

    const beforeUndo = runtime.getWorkspaceBootstrap()
    const undone = await runtime.undoScene({ expectedSceneRevision: beforeUndo.scene.revision, batchId: placed.batchId })
    expect(undone).toMatchObject({ ok: true, receipt: { action: 'undo', affectedBatchId: placed.batchId } })
    expect(runtime.getWorkspaceBootstrap().scene.elements).toEqual([])
    await runtime.close()
  })
})
