import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sceneSchema } from '../../src/domain'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { commitSceneFixture } from '../helpers/commit-scene-fixture'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function waitForCompleted(runtime: GenerationRuntime, jobId: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job?.status === 'completed') return job
    if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
      throw new Error(`Canvas generation ended as ${job.status}: ${job.error?.message ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Canvas generation did not complete in time.')
}

describe('canvas generation orchestration', () => {
  it('persists original requirement, Prompt IR, sent prompt, Composite Reference and result lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-runtime-reference-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    const bootstrap = runtime.getWorkspaceBootstrap()
    const scene = await commitSceneFixture(runtime, sceneSchema.parse({ ...createNightVeilScene(), projectId: bootstrap.projectId }))
    const input = {
      scene,
      originalRequirement: '依据当前结构生成完整的深蓝香水广告',
      providerId: 'mock',
      model: 'mock-balanced',
      count: 1,
      sourceMessageId: null
    }
    const compiled = await runtime.generateFromCanvas(input)
    const completed = await waitForCompleted(runtime, compiled.jobId)
    expect(completed.request.references).toEqual([
      { assetId: compiled.referenceAssetId, intent: 'composition', strength: .82 },
      { assetId: compiled.semanticSheetAssetId, intent: 'composition', strength: .72 }
    ])
    expect(completed.request.parameters).toMatchObject({
      mode: 'canvas',
      originalRequirement: input.originalRequirement,
      promptIr: { sceneId: scene.id, sceneRevision: scene.revision },
      promptPackage: {
        sceneIntent: { originalRequirement: input.originalRequirement },
        referenceManifest: [
          { assetId: compiled.referenceAssetId, role: 'appearance-composite' },
          { assetId: compiled.semanticSheetAssetId, role: 'semantic-sheet' }
        ],
        generationProfile: { providerId: 'mock', model: 'mock-balanced' }
      },
      semanticSheetAssetId: compiled.semanticSheetAssetId,
      sentPrompt: expect.stringContaining('NIGHT VEIL')
    })
    expect(completed.results).toHaveLength(1)
    expect(completed.results[0]?.assetId).not.toBe(compiled.referenceAssetId)
    expect(await runtime.readAssetDataUrl(compiled.referenceAssetId, false)).toMatch(/^data:image\/png;base64,/)
    expect(await runtime.readAssetDataUrl(compiled.semanticSheetAssetId, false)).toMatch(/^data:image\/png;base64,/)

    const repeated = await runtime.generateFromCanvas(input)
    expect(repeated.referenceAssetId).toBe(compiled.referenceAssetId)
    expect(repeated.semanticSheetAssetId).toBe(compiled.semanticSheetAssetId)
    await waitForCompleted(runtime, repeated.jobId)
    await runtime.close()
  })

  it('uses structured Scene semantics without attaching the composite in structure-only mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-runtime-structure-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    const bootstrap = runtime.getWorkspaceBootstrap()
    const scene = await commitSceneFixture(runtime, sceneSchema.parse({ ...createNightVeilScene(), projectId: bootstrap.projectId }))
    const compiled = await runtime.generateFromCanvas({
      scene,
      originalRequirement: '保留结构关系，重新探索材质与光线',
      providerId: 'mock',
      model: 'mock-balanced',
      count: 1,
      sourceMessageId: null,
      referenceMode: 'structure'
    })
    const completed = await waitForCompleted(runtime, compiled.jobId)

    expect(completed.request.references).toEqual([])
    expect(completed.request.referenceMode).toBe('structure')
    expect(completed.request.parameters).toMatchObject({ mode: 'canvas', referenceMode: 'structure' })
    expect(compiled.promptPackage.referenceMode).toBe('structure')
    expect(compiled.sentPrompt).toContain('本次使用结构参考')
    await runtime.close()
  })
})
