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

const BASE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, blendMode: 'normal' as const, visible: true, locked: false,
  groupId: null, semanticRole: 'content', referencePolicy: 'include' as const
}
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function terminal(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === jobId)?.status, { timeout: 8_000 })
    .toMatch(/^(completed|failed|cancelled|timed_out|interrupted)$/)
  return (await runtime.listJobs()).find((job) => job.id === jobId)!
}

it('redraws every exported layer but text and lays the result between them and the text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-unified-'))
  roots.push(root)
  const runtime = await GenerationRuntime.create(root)
  try {
    const fixture = { ...createNightVeilScene(), projectId: runtime.getWorkspaceBootstrap().projectId, elements: [], relations: [] }
    const background: SceneElement = { ...BASE, id: id(1), type: 'shape', name: '背景', zIndex: 0, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      shape: 'rectangle', fill: '#335577', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final' }
    const title: SceneElement = { ...BASE, id: id(2), type: 'text', name: '标题', zIndex: 1, transform: { x: 0, y: 0, width: 1, height: 0.3, rotation: 0 },
      content: 'NIGHT', orientation: 'horizontal', align: 'center', wrapping: 'word', fontFamily: 'Georgia', fontSize: 80, fontWeight: 700,
      fill: '#FFFFFF', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 0, lineHeight: 1.2, accuracy: 'strict',
      visualWeight: 'hero', styleDescription: '', renderStrategy: 'standard', resultAssetId: null }
    const disc: SceneElement = { ...BASE, id: id(3), type: 'shape', name: '圆', zIndex: 2, transform: { x: 0.3, y: 0.4, width: 0.4, height: 0.4, rotation: 0 },
      shape: 'ellipse', fill: '#E0A030', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final' }
    const scene = await commitSceneFixture(runtime, sceneSchema.parse({ ...fixture, elements: [background, title, disc] }))

    const submitted = await runtime.unifiedRender({ scene, requirement: '清晨柔光', providerId: 'mock', model: 'mock-balanced', count: 1 })
    expect(submitted.coveredElementIds).toEqual([id(1), id(3)])
    const job = await terminal(runtime, submitted.jobId)
    expect(job.status).toBe('completed')
    expect(job.request).toMatchObject({
      prompt: expect.stringContaining('清晨柔光'),
      references: [{ assetId: submitted.sourceAssetId, intent: 'composition' }],
      parameters: { mode: 'unified-render', coveredElementIds: [id(1), id(3)] }
    })
    expect(job.request.prompt).toContain('不要出现任何文字')
    // The source has the disc but not the title: the top band is plain background.
    const dataUrl = await runtime.readAssetDataUrl(submitted.sourceAssetId, false)
    const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
    expect(at(Math.floor(info.width / 2), Math.floor(info.height * 0.15))).toEqual([0x33, 0x55, 0x77])
    expect(at(Math.floor(info.width / 2), Math.floor(info.height * 0.6))).toEqual([0xE0, 0xA0, 0x30])

    const receipt = await runtime.placeGenerationResult({ resultId: job.results[0]!.id, placementId: id(20), origin: 'user' })
    expect(receipt).toMatchObject({ elementId: id(20), reused: false })
    const placed = runtime.getWorkspaceBootstrap().scene.elements
    expect(placed.map((element) => element.name)).toEqual(['背景', '圆', '统一渲染 1', '标题'])
    expect(placed[2]).toMatchObject({ type: 'image', fit: 'cover', transform: { x: 0, y: 0, width: 1, height: 1 } })
    expect(placed.every((element) => element.visible)).toBe(true)

    // Nothing to redraw: only text.
    const textOnly = await commitSceneFixture(runtime, sceneSchema.parse({ ...fixture, elements: [{ ...title, zIndex: 0 }] }))
    await expect(runtime.unifiedRender({ scene: textOnly, providerId: 'mock', model: 'mock-balanced' })).rejects.toThrow(/还没有可以统一重绘的图片或形状/)
  } finally {
    await runtime.close()
  }
}, 30_000)
