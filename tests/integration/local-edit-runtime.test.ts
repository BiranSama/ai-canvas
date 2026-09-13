import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type SceneElement } from '../../src/domain'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob } from '../../src/shared/generation'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { commitSceneFixture } from '../helpers/commit-scene-fixture'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function waitForTerminal(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job !== undefined && ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Task did not reach a terminal state.')
}

function request(model = 'mock-balanced') {
  return {
    prompt: 'Create a stable source image',
    negativePrompt: '',
    aspectWidth: 8,
    aspectHeight: 5,
    outputWidth: 320,
    outputHeight: 200,
    count: 1,
    providerId: 'mock',
    model,
    references: [],
    parameters: {},
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid' as const,
    variationInstruction: '',
    preserveConstraints: ''
  }
}

describe('non-destructive local edit runtime', () => {
  it('retains source, mask, requirement and lineage across failure, retry and cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-local-edit-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    try {
    const sourceJob = await waitForTerminal(runtime, (await runtime.enqueue(request())).id)
    expect(sourceJob.status).toBe('completed')
    const sourceResult = sourceJob.results[0]
    expect(sourceResult).toBeDefined()
    const sourceBefore = await runtime.readAssetDataUrl(sourceResult!.assetId, false)
    const bootstrap = runtime.getWorkspaceBootstrap()
    const targetId = '20000000-0000-4000-8000-000000000081'
    const target: SceneElement = {
      id: targetId,
      version: ELEMENT_SCHEMA_VERSION,
      type: 'image',
      name: 'Editable source',
      description: '',
      transform: { x: .15, y: .18, width: .7, height: .64, rotation: 0 },
      zIndex: 0,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'content',
      referencePolicy: 'include',
      assetId: sourceResult!.assetId,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'fill',
      referenceRole: 'general'
    }
    const mask: SceneElement = {
      ...target,
      id: '20000000-0000-4000-8000-000000000082',
      type: 'mask',
      name: 'Edit area',
      zIndex: 1,
      semanticRole: 'edit-mask',
      referencePolicy: 'exclude',
      mode: 'edit',
      targetElementId: target.id,
      paths: [{
        id: '20000000-0000-4000-8000-000000000083',
        points: [{ x: .18, y: .18 }, { x: .82, y: .18 }, { x: .82, y: .82 }, { x: .18, y: .82 }],
        closed: true
      }],
      feather: .08
    }
    const fixture = createNightVeilScene()
    const scene = await commitSceneFixture(runtime, sceneSchema.parse({ ...fixture, projectId: bootstrap.projectId, elements: [target, mask], relations: [] }))
    const requirement = 'Replace this area with a quiet blue glass bloom; keep everything else unchanged.'
    const failedInput = {
      scene,
      targetElementId: target.id,
      prompt: requirement,
      negativePrompt: '',
      providerId: 'mock',
      model: 'mock-failure',
      count: 1,
      sourceMessageId: null,
      parentResultId: sourceResult!.id
    }
    const submitted = await runtime.editFromCanvas(failedInput)
    const failed = await waitForTerminal(runtime, submitted.jobId)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'MOCK_PROVIDER_FAILURE', stage: 'generating' } })
    expect('kind' in failed.request && failed.request.kind).toBe('edit')
    if (!('kind' in failed.request)) throw new Error('Expected edit request.')
    expect(failed.request).toMatchObject({
      prompt: requirement,
      sourceAssetId: sourceResult!.assetId,
      maskAssetId: submitted.maskAssetId,
      parentResultId: sourceResult!.id,
      parameters: { mode: 'local-edit', targetElementId: target.id }
    })
    expect(await runtime.readAssetDataUrl(sourceResult!.assetId, false)).toBe(sourceBefore)
    const maskData = await runtime.readAssetDataUrl(submitted.maskAssetId, false)
    const maskMetadata = await sharp(Buffer.from(maskData.split(',')[1] ?? '', 'base64')).metadata()
    expect(maskMetadata).toMatchObject({ width: 320, height: 200 })

    const retried = await runtime.retry(failed.id, { model: 'mock-balanced' })
    const completed = await waitForTerminal(runtime, retried.id)
    expect(completed.status).toBe('completed')
    expect(completed.parentJobId).toBe(failed.id)
    expect(completed.results[0]).toMatchObject({ parentResultId: sourceResult!.id })
    expect(completed.results[0]?.assetId).not.toBe(sourceResult!.assetId)
    expect(await runtime.readAssetDataUrl(sourceResult!.assetId, false)).toBe(sourceBefore)

    const slow = await runtime.editFromCanvas({ ...failedInput, model: 'mock-slow' })
    await runtime.cancel(slow.jobId)
    const cancelled = await waitForTerminal(runtime, slow.jobId)
    expect(cancelled.status).toBe('cancelled')
    expect(await runtime.readAssetDataUrl(sourceResult!.assetId, false)).toBe(sourceBefore)

    const cleared = await runtime.executeSceneCommands({ expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision,
      batch: { id: '20000000-0000-4000-8000-000000000086', origin: 'user', summary: 'Remove persistent mask',
        commands: [{ kind: 'element.remove', elementId: mask.id }] } })
    expect(cleared.ok).toBe(true)
    const cleanScene = runtime.getWorkspaceBootstrap().scene
    expect(cleanScene.elements.filter((element) => element.type === 'mask')).toHaveLength(0)
    const cleanInput = { ...failedInput, scene: cleanScene }
    // A renderer-supplied Scene cannot inject a mask. The internal Agent path
    // compiles its separately validated one-turn annotation without persisting it.
    await expect(runtime.editFromCanvas({ ...cleanInput, scene: { ...cleanScene, elements: [target, mask] } }))
      .rejects.toThrow('请先为所选图片绘制至少一个修改蒙版')
    const annotation = { id: '20000000-0000-4000-8000-000000000085', targetElementId: target.id,
      mode: 'edit' as const, closed: true, width: .015,
      points: [{ x: .25, y: .25 }, { x: .65, y: .25 }, { x: .65, y: .65 }, { x: .25, y: .65 }] }
    const annotated = await runtime.editFromCanvas(cleanInput, 'one-turn-annotation', undefined, false, undefined, annotation)
    expect((await waitForTerminal(runtime, annotated.jobId)).status).toBe('failed')
    expect(await runtime.editFromCanvas(cleanInput, 'one-turn-annotation', undefined, false, undefined, annotation)).toEqual({ ...annotated, jobStatus: 'failed' })
    await expect(runtime.editFromCanvas(cleanInput, 'one-turn-annotation', undefined, false, undefined, { ...annotation, width: .1 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const pixels = await sharp(Buffer.from((await runtime.readAssetDataUrl(annotated.maskAssetId, false)).split(',')[1]!, 'base64')).greyscale().raw().toBuffer()
    expect(pixels.some((pixel) => pixel > 0)).toBe(true)
    expect(pixels.some((pixel) => pixel === 0)).toBe(true)
    expect(runtime.getWorkspaceBootstrap().scene).toEqual(cleanScene)
    expect(await runtime.readAssetDataUrl(sourceResult!.assetId, false)).toBe(sourceBefore)
    } finally { await runtime.close() }
  })
})
