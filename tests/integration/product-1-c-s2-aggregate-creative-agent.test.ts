import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob } from '../../src/shared/generation'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'

const roots: string[] = []

async function waitForAgent(runtime: GenerationRuntime, priorTurnIds: ReadonlySet<string> = new Set()): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const snapshot = await runtime.getAgentHarnessSnapshot()
    const turn = snapshot.turns.find((candidate) => !priorTurnIds.has(candidate.id))
    if (turn?.status === 'failed') throw new Error(`Agent turn failed: ${turn.errorCode}: ${turn.errorMessage}`)
    if (turn !== undefined && ['completed', 'completed_with_notes', 'needs_user_review'].includes(turn.status)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Agent design turn did not become terminal.')
}

async function waitForCompleted(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job?.status === 'completed') return job
    if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
      throw new Error(`Generation ended as ${job.status}: ${job.error?.message ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Generation did not complete in time.')
}

afterEach(async () => {
  vi.unstubAllGlobals()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Product 1.0 C-S2 aggregate creative Agent workflow', () => {
  it('keeps direction lineage through Agent generation, draft-to-final continuation, placement replay, and placement-only Undo', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-c-s2-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)

    const initialScene = runtime.getWorkspaceBootstrap().scene
    const run = await runtime.startAgentRun(fixtureAgentRequest(
      initialScene,
      '创建一个 4:5 的视觉封面，主体保持中性，先不要生成图片。'
    ), 'auto')
    await waitForAgent(runtime)

    const designedScene = runtime.getWorkspaceBootstrap().scene
    const creativeContext = designedScene.creativeContext
    const direction = creativeContext?.directions?.find((candidate) => candidate.id !== creativeContext.selectedDirectionId)
    if (creativeContext === undefined || creativeContext === null || direction === undefined) throw new Error('Expected at least two design directions.')

    const selection = await runtime.selectDesignDirection({
      sourceRunId: run.id,
      briefId: creativeContext.brief.id,
      directionId: direction.id,
      expectedSceneRevision: designedScene.revision,
      resolution: 'strict'
    })
    expect(selection).toMatchObject({ status: 'applied', directionId: direction.id })

    const selectedScene = runtime.getWorkspaceBootstrap().scene
    const elementIdsBeforePlacement = selectedScene.elements.map((element) => element.id)
    const priorTurnIds = new Set((await runtime.getAgentHarnessSnapshot()).turns.map((turn) => turn.id))
    const jobsBeforeGeneration = new Set((await runtime.listJobs()).map((job) => job.id))
    await runtime.startAgentRun(fixtureAgentRequest(
      selectedScene,
      '依据当前画布与已选设计方向生成图片，保持结构与安静留白。'
    ), 'auto')
    await waitForAgent(runtime, priorTurnIds)

    const generatedJob = (await runtime.listJobs()).find((job) =>
      !jobsBeforeGeneration.has(job.id) && job.request.parameters.mode === 'canvas'
    )
    if (generatedJob === undefined) throw new Error('Expected the Agent to create one canvas-generation job.')
    const completed = await waitForCompleted(runtime, generatedJob.id)
    expect(completed.request.parameters.promptPackage).toMatchObject({
      referenceMode: 'hybrid',
      provenance: {
        briefId: creativeContext.brief.id,
        directionId: direction.id,
        sceneId: selectedScene.id,
        sceneRevision: selectedScene.revision
      }
    })

    const rootResult = completed.results[0]
    if (rootResult === undefined) throw new Error('Expected one Mock result.')
    expect(await runtime.resultFamilies()).toEqual([
      expect.objectContaining({
        members: [expect.objectContaining({
          resultId: rootResult.id,
          sourceBriefId: creativeContext.brief.id,
          sourceDirectionId: direction.id,
          sourceSceneRevision: selectedScene.revision,
          promptPackageHash: expect.any(String)
        })]
      })
    ])

    const continuation = await runtime.enqueueProfile({
      profileId: 'mock-final',
      confirmed: true,
      operation: 'reference',
      draft: {
        prompt: '把当前方向收敛为定稿候选，只让光线更柔和。',
        negativePrompt: '',
        aspect: { width: selectedScene.canvas.aspectWidth, height: selectedScene.canvas.aspectHeight },
        quantity: 1,
        profileId: 'mock-final',
        referenceResultIds: [rootResult.id],
        sourceSceneRevision: selectedScene.revision,
        referenceMode: 'visual',
        variationInstruction: '让光线更柔和',
        preserveConstraints: '保持已选设计方向、主体结构、画面比例与留白',
        expandedSections: []
      },
      outputWidth: selectedScene.canvas.outputWidth,
      outputHeight: selectedScene.canvas.outputHeight,
      references: [{ assetId: rootResult.assetId, intent: 'composition', strength: 0.68 }],
      parameters: { basePrompt: '把当前方向收敛为定稿候选', referenceMode: 'visual' },
      sourceMessageId: null,
      parentResultId: rootResult.id,
      modelOverride: 'mock-balanced'
    })
    const continued = await waitForCompleted(runtime, continuation.id)
    const finalResult = continued.results[0]
    if (finalResult === undefined) throw new Error('Expected one continued Mock result.')
    const family = (await runtime.resultFamilies())[0]
    expect(family?.members).toEqual([
      expect.objectContaining({
        resultId: rootResult.id,
        sourceBriefId: creativeContext.brief.id,
        sourceDirectionId: direction.id,
        promptPackageHash: expect.any(String)
      }),
      expect.objectContaining({
        resultId: finalResult.id,
        parentResultId: rootResult.id,
        sourceBriefId: creativeContext.brief.id,
        sourceDirectionId: direction.id,
        promptPackageHash: family?.members[0]?.promptPackageHash,
        variationInstruction: '让光线更柔和',
        preserveConstraints: '保持已选设计方向、主体结构、画面比例与留白'
      })
    ])
    const placementId = '92000000-0000-4000-8000-000000000001'
    const placed = await runtime.placeGenerationResult({ resultId: finalResult.id, placementId, origin: 'user' })
    const placedScene = runtime.getWorkspaceBootstrap().scene
    expect(placedScene.creativeContext?.selectedDirectionId).toBe(direction.id)
    expect(placedScene.elements.find((element) => element.id === placementId)).toMatchObject({
      type: 'image',
      assetId: finalResult.assetId,
      provenance: {
        origin: 'mock-generated',
        sourceBriefId: creativeContext.brief.id,
        sourceDirectionId: direction.id,
        sourceAssetId: finalResult.assetId
      }
    })

    const replay = await runtime.placeGenerationResult({ resultId: finalResult.id, placementId, origin: 'user' })
    expect(replay).toMatchObject({ reused: true, elementId: placementId, batchId: placementId })
    expect(runtime.getWorkspaceBootstrap().scene.elements).toHaveLength(elementIdsBeforePlacement.length + 1)

    const undo = await runtime.undoScene({
      expectedSceneRevision: placedScene.revision,
      batchId: placed.batchId
    })
    expect(undo).toMatchObject({ ok: true, receipt: { action: 'undo', affectedBatchId: placed.batchId } })
    const restoredScene = runtime.getWorkspaceBootstrap().scene
    expect(restoredScene.creativeContext?.selectedDirectionId).toBe(direction.id)
    expect(restoredScene.elements.map((element) => element.id)).toEqual(elementIdsBeforePlacement)
    expect(fetcher).not.toHaveBeenCalled()
    await runtime.close()
  }, 20_000)
})
