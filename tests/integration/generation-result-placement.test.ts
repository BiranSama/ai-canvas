import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SUBJECT_FEATHER } from '../../src/main/edit/subject-fit'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob, GenerationRequest } from '../../src/shared/generation'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

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

  it('cuts the subject out of a picture put in a subject placeholder, or feathers it without the model, and tones it to its surroundings', async () => {
    const fixture = makeAllElementTypesScene().elements
    const backdrop = { ...fixture.find((element) => element.id === IDS.shape)!, zIndex: 0 }
    const slot = fixture.find((element) => element.id === IDS.placeholder)!
    if (slot.type !== 'placeholder') throw new Error('The fixture has no placeholder.')
    const placeholder = { ...slot, groupId: null, zIndex: 1 }
    for (const withModel of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), 'ai-canvas-subject-fit-'))
      roots.push(root)
      // A stand-in model that finds the left half of the picture.
      const subject = () => ({
        status: async () => ({ state: 'ready' as const, receivedBytes: 1, totalBytes: 1, error: null }),
        segment: async (input: { width: number; height: number }) => ({
          width: input.width, height: input.height, milliseconds: 1,
          mask: Uint8Array.from({ length: input.width * input.height }, (_, index) => index % input.width < input.width / 2 ? 255 : 0)
        })
      })
      const runtime = await GenerationRuntime.create(root, withModel ? { subject } : {})
      const laid = await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batch: {
        id: randomUUID(), origin: 'user', summary: '布局', commands: [{ kind: 'element.add', element: backdrop }, { kind: 'element.add', element: placeholder }]
      } })
      expect(laid.ok).toBe(true)
      const completed = await waitForCompleted(runtime, (await runtime.enqueue(request())).id)
      const placed = await runtime.placeGenerationResult({ resultId: completed.results[0]!.id, placementId: randomUUID(), origin: 'agent' }, undefined, undefined, IDS.placeholder)
      expect(placed.fit).toBe(withModel ? 'cut-out' : 'feather')
      const element = runtime.getWorkspaceBootstrap().scene.elements.find((candidate) => candidate.id === IDS.placeholder)!
      if (element.type !== 'image') throw new Error('The placeholder was not replaced.')
      expect(element.transform).toEqual(placeholder.transform)
      expect(element.effects?.feather).toBe(withModel ? 0 : SUBJECT_FEATHER)
      // The dark backdrop pulls the picture's tone down.
      expect(element.effects?.colorMatch?.offset.every((value) => value < 0)).toBe(true)
      if (withModel) expect(element.mask).toMatchObject({ enabled: true })
      else expect(element.mask ?? null).toBeNull()

      // A placeholder kept with its background takes the picture as it came.
      const framed = await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batch: {
        id: randomUUID(), origin: 'user', summary: '相框', commands: [{ kind: 'element.add', element: { ...placeholder, id: IDS.group, transparentBackground: false, zIndex: 2 } }]
      } })
      expect(framed.ok).toBe(true)
      const second = await waitForCompleted(runtime, (await runtime.enqueue(request())).id)
      const kept = await runtime.placeGenerationResult({ resultId: second.results[0]!.id, placementId: randomUUID(), origin: 'agent' }, undefined, undefined, IDS.group)
      expect(kept.fit).toBeUndefined()
      expect(runtime.getWorkspaceBootstrap().scene.elements.find((candidate) => candidate.id === IDS.group)).not.toHaveProperty('mask')
      await runtime.close()
    }
  }, 30_000)
})
