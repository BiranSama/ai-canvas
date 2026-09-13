import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene } from '../../src/domain'
import type { ProviderCapabilities } from '../../src/shared/generation'
import { CompositeReferenceRenderer, ReferenceCompiler } from '../../src/main/reference'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { makeText } from '../fixtures/scene-fixtures'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('Reference Compiler and offscreen Composite Reference', () => {
  it('final artwork uses the saved text color, font size and weight instead of placeholder typography', async () => {
    const renderer = new CompositeReferenceRenderer()
    const base = createNightVeilScene()
    const renderText = async (size: number, weight: number) => {
      const scene = sceneSchema.parse({ ...base, canvas: { ...base.canvas, backgroundColor: '#ffffff' }, elements: [{ ...makeText(),
        content: 'MOUNTAIN', fill: '#b00000', fontFamily: 'Segoe UI', fontSize: size, fontWeight: weight, letterSpacing: 0,
        transform: { x: .1, y: .2, width: .8, height: .4, rotation: 0 } }], relations: [] })
      const { buffer } = await renderer.render(scene, 'final')
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let ink = 0
      for (let index = 0; index < data.length; index += info.channels) if (data[index]! > 120 && data[index + 1]! < 60 && data[index + 2]! < 60) ink++
      return ink
    }
    const small = await renderText(32, 400), large = await renderText(64, 400)
    expect(small).toBeGreaterThan(200)
    expect(large).toBeGreaterThan(small * 2)
    expect(await renderText(64, 900)).toBeGreaterThan(await renderText(64, 100))
  })

  it('renders a deterministic Golden Image at output resolution without editor chrome', async () => {
    const renderer = new CompositeReferenceRenderer()
    const scene = createNightVeilScene()
    const first = await renderer.render(scene, 'reference')
    const second = await renderer.render(scene, 'reference')
    expect(sha256(first.buffer)).toBe(sha256(second.buffer))
    const goldenPath = new URL('./golden/night-veil-reference.png', import.meta.url)
    if (process.env.UPDATE_REFERENCE_GOLDEN === '1') await writeFile(goldenPath, first.buffer)
    expect(sha256(first.buffer)).toBe(sha256(await readFile(goldenPath)))
    const metadata = await sharp(first.buffer).metadata()
    expect(metadata).toMatchObject({ width: 1024, height: 1280, format: 'png' })

    const editing = await renderer.render(scene, 'editing')
    const final = await renderer.render(scene, 'final')
    expect(sha256(editing.buffer)).not.toBe(sha256(first.buffer))
    expect(sha256(final.buffer)).not.toBe(sha256(first.buffer))
  })

  it('composites real image assets, persists the reference, and deduplicates identical Scene output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-reference-'))
    roots.push(root)
    const projectDirectory = join(root, 'Reference.aicanvas')
    const opened = await ProjectWorkspace.create(projectDirectory, 'Reference')
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width: 180, height: 120, channels: 4, background: { r: 177, g: 202, b: 226, alpha: 1 } } }).png().toFile(sourcePath)
    const imageAsset = await opened.workspace.assets.importImage({ sourcePath })
    const fixture = createNightVeilScene()
    const scene: Scene = sceneSchema.parse({
      ...fixture,
      projectId: opened.workspace.metadata.id,
      elements: fixture.elements.map((element, index) => ({ ...element, zIndex: index })).concat([{
        id: '10000000-0000-4000-8000-000000000077',
        version: ELEMENT_SCHEMA_VERSION,
        type: 'image' as const,
        name: '材质样片',
        description: '冷色珍珠材质参考',
        transform: { x: .05, y: .7, width: .24, height: .18, rotation: -4 },
        zIndex: 4,
        opacity: .84,
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'material-reference',
        referencePolicy: 'reference-only' as const,
        assetId: imageAsset.id,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        fit: 'cover' as const,
        referenceRole: 'material' as const
      }])
    })
    const compiler = new ReferenceCompiler({
      assetStore: opened.workspace.assets,
      repository: opened.workspace.repository,
      stagingDirectory: join(root, 'staging'),
      idFactory: (() => { let index = 0; return () => `20000000-0000-4000-8000-${(++index).toString().padStart(12, '0')}` })(),
      now: () => '2026-08-10T00:00:00.000Z'
    })
    const capabilities: ProviderCapabilities = {
      textToImage: true,
      imageReferences: true,
      maskEditing: true,
      multipleReferences: true,
      transparentOutput: false,
      maxImages: 4,
      supportedRatios: ['4:5'],
      supportedFormats: ['png']
    }
    const first = await compiler.compile(scene, '使用当前画布生成完整香水广告', 'mock', capabilities)
    const second = await compiler.compile(scene, '使用当前画布生成完整香水广告', 'mock', capabilities)
    expect(second.asset.id).toBe(first.asset.id)
    expect(first.asset.sourceType).toBe('reference')
    expect(first.asset).toMatchObject({ width: 1024, height: 1280, format: 'png' })
    expect(first.promptIr.elements.find((element) => element.type === 'image')).toMatchObject({
      presentation: 'semantic-guide',
      attributes: { assetId: imageAsset.id, referenceRole: 'material' }
    })
    expect(first.providerPrompt.prompt).toContain('材质样片')
    expect(first.warnings).toEqual([])
    const saved = await readFile(opened.workspace.assets.resolveOriginal(first.asset))
    expect((await sharp(saved).metadata()).width).toBe(1024)
    await opened.workspace.close(true)
  })
})
