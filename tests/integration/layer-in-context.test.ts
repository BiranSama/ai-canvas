import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type SceneElement } from '../../src/domain'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationJob } from '../../src/shared/generation'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { commitSceneFixture } from '../helpers/commit-scene-fixture'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function terminal(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === jobId)?.status, { timeout: 8_000 })
    .toMatch(/^(completed|failed|cancelled|timed_out|interrupted)$/)
  return (await runtime.listJobs()).find((job) => job.id === jobId)!
}

async function image(runtime: GenerationRuntime, assetId: string) {
  const dataUrl = await runtime.readAssetDataUrl(assetId, false)
  return sharp(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'))
}

const BASE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, blendMode: 'normal' as const, visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include' as const
}

it('redraws a placeholder within the picture beneath it and places a blended cut-out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-layer-'))
  roots.push(root)
  const runtime = await GenerationRuntime.create(root)
  try {
    const fixture = { ...createNightVeilScene(), projectId: runtime.getWorkspaceBootstrap().projectId, elements: [], relations: [] }
    const background: SceneElement = {
      ...BASE, id: '30000000-0000-4000-8000-000000000001', type: 'shape', name: '背景', zIndex: 0, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      shape: 'rectangle', fill: '#335577', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
    }
    const subject: SceneElement = {
      ...BASE, id: '30000000-0000-4000-8000-000000000002', type: 'placeholder', name: '主体', zIndex: 1, transform: { x: 0.3, y: 0.3, width: 0.4, height: 0.4, rotation: 0 },
      subject: '玻璃鹿', pose: '', facing: '', allowOverflow: false, transparentBackground: true, frameShape: 'rectangle', generationNotes: ''
    }
    const title: SceneElement = {
      ...BASE, id: '30000000-0000-4000-8000-000000000003', type: 'text', name: '标题', zIndex: 2, transform: { x: 0.2, y: 0.05, width: 0.6, height: 0.12, rotation: 0 },
      content: 'NIGHT VEIL', orientation: 'horizontal', align: 'center', wrapping: 'word', fontFamily: 'Georgia', fontSize: 48, fontWeight: 400,
      fill: '#F4F4F2', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 0, lineHeight: 1.2, accuracy: 'strict',
      visualWeight: 'primary', styleDescription: '', renderStrategy: 'standard', resultAssetId: null
    }
    const scene = await commitSceneFixture(runtime, sceneSchema.parse({ ...fixture, elements: [background, subject, title] }))
    const { outputWidth, outputHeight } = scene.canvas

    const submitted = await runtime.editFromCanvas({
      scene, targetElementId: subject.id, prompt: '一只发光的玻璃鹿', negativePrompt: '', providerId: 'mock', model: 'mock-balanced',
      count: 1, sourceMessageId: null, parentResultId: null, mode: 'in-context'
    })
    const job = await terminal(runtime, submitted.jobId)
    expect(job.status).toBe('completed')
    if (!('kind' in job.request)) throw new Error('Expected an edit request.')
    expect(job.request).toMatchObject({
      kind: 'edit',
      prompt: expect.stringContaining('在标出的区域里画出：一只发光的玻璃鹿'),
      parameters: { mode: 'layer-in-context', targetElementId: subject.id, originalRequirement: '一只发光的玻璃鹿' }
    })
    const region = job.request.parameters.layerRegion as { core: { left: number; top: number; width: number; height: number }; expanded: { left: number; top: number; width: number; height: number } }
    expect(region.core).toEqual({ left: Math.floor(0.3 * outputWidth), top: Math.floor(0.3 * outputHeight), width: Math.ceil(0.7 * outputWidth) - Math.floor(0.3 * outputWidth), height: Math.ceil(0.7 * outputHeight) - Math.floor(0.3 * outputHeight) })

    // The source is the canvas as exported, with only the layer beneath: the background colour, no title.
    const source = await (await image(runtime, submitted.sourceAssetId)).raw().toBuffer({ resolveWithObject: true })
    expect([source.info.width, source.info.height]).toEqual([outputWidth, outputHeight])
    const centre = (Math.floor(outputHeight / 2) * outputWidth + Math.floor(outputWidth / 2)) * source.info.channels
    expect([...source.data.subarray(centre, centre + 3)]).toEqual([0x33, 0x55, 0x77])
    const mask = await (await image(runtime, submitted.maskAssetId)).raw().toBuffer({ resolveWithObject: true })
    const maskAt = (x: number, y: number) => mask.data[(y * mask.info.width + x) * mask.info.channels]
    expect([maskAt(region.expanded.left, region.expanded.top), maskAt(region.expanded.left - 1, region.expanded.top), maskAt(5, 5)]).toEqual([255, 0, 0])

    // Placing without naming a target puts the cut-out into the placeholder it was drawn for.
    const result = job.results[0]!
    const placementId = '30000000-0000-4000-8000-000000000010'
    const receipt = await runtime.placeGenerationResult({ resultId: result.id, placementId, origin: 'agent' })
    expect(receipt).toMatchObject({ elementId: subject.id, reused: false })
    const placed = runtime.getWorkspaceBootstrap().scene.elements.find((candidate) => candidate.id === subject.id)!
    expect(placed).toMatchObject({ type: 'image', fit: 'fill', zIndex: 1, provenance: { sourceAssetId: result.assetId } })
    if (placed.type !== 'image') throw new Error('Expected an image.')
    expect(placed.assetId).not.toBe(result.assetId)
    expect(placed.transform.x).toBeCloseTo(region.expanded.left / outputWidth, 6)
    expect(placed.transform.width).toBeCloseTo(region.expanded.width / outputWidth, 6)
    const layer = await (await image(runtime, placed.assetId)).raw().toBuffer({ resolveWithObject: true })
    expect([layer.info.width, layer.info.height, layer.info.channels]).toEqual([region.expanded.width, region.expanded.height, 4])
    expect(layer.data[3]).toBeLessThan(20)
    const middle = (Math.floor(layer.info.height / 2) * layer.info.width + Math.floor(layer.info.width / 2)) * 4
    expect(layer.data[middle + 3]).toBe(255)

    // Placing the same result again changes nothing.
    expect(await runtime.placeGenerationResult({ resultId: result.id, placementId, origin: 'agent' })).toMatchObject({ elementId: subject.id, reused: true })
  } finally {
    await runtime.close()
  }
}, 30_000)
