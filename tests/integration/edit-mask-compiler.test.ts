import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type SceneElement } from '../../src/domain'
import { EditMaskCompiler } from '../../src/main/edit'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('EditMaskCompiler', () => {
  it('maps normalized edit/protect paths to exact source pixels and retains feather alpha', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-mask-'))
    roots.push(root)
    const opened = await ProjectWorkspace.create(join(root, 'Mask.aicanvas'), 'Mask')
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width: 320, height: 200, channels: 4, background: '#73869a' } }).png().toFile(sourcePath)
    const source = await opened.workspace.assets.importImage({ sourcePath })
    const targetId = '10000000-0000-4000-8000-000000000081'
    const target: SceneElement = {
      id: targetId,
      version: ELEMENT_SCHEMA_VERSION,
      type: 'image',
      name: 'Source',
      description: '',
      transform: { x: .2, y: .2, width: .6, height: .6, rotation: 0 },
      zIndex: 0,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'content',
      referencePolicy: 'include',
      assetId: source.id,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      fit: 'fill',
      referenceRole: 'general'
    }
    const editMask: SceneElement = {
      ...target,
      id: '10000000-0000-4000-8000-000000000082',
      type: 'mask',
      name: 'Edit',
      zIndex: 1,
      semanticRole: 'edit-mask',
      referencePolicy: 'exclude',
      mode: 'edit',
      targetElementId: target.id,
      paths: [{
        id: '10000000-0000-4000-8000-000000000083',
        points: [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }],
        closed: true
      }],
      feather: .12
    }
    const protectMask: SceneElement = {
      ...editMask,
      id: '10000000-0000-4000-8000-000000000084',
      name: 'Protect',
      zIndex: 2,
      mode: 'protect',
      paths: [{
        id: '10000000-0000-4000-8000-000000000085',
        points: [{ x: .44, y: .44 }, { x: .56, y: .44 }, { x: .56, y: .56 }, { x: .44, y: .56 }],
        closed: true
      }],
      feather: 0
    }
    const fixture = createNightVeilScene()
    const scene = sceneSchema.parse({ ...fixture, projectId: opened.workspace.metadata.id, elements: [target, editMask, protectMask], relations: [] })
    const compiler = new EditMaskCompiler({
      assetStore: opened.workspace.assets,
      stagingDirectory: join(root, 'staging'),
      idFactory: () => '10000000-0000-4000-8000-000000000086'
    })
    const compiled = await compiler.compile(scene, target.id, source)
    const maskPath = opened.workspace.assets.resolveOriginal(compiled.asset)
    const metadata = await sharp(maskPath).metadata()
    expect(metadata).toMatchObject({ width: 320, height: 200, format: 'png' })
    expect(compiled.contributingMaskIds).toEqual([editMask.id, protectMask.id])
    const pixels = await sharp(await readFile(maskPath)).greyscale().removeAlpha().raw().toBuffer()
    expect(pixels[100 * 320 + 160]).toBe(0)
    expect(pixels[70 * 320 + 100]).toBeGreaterThan(245)
    expect([...pixels].some((value) => value > 0 && value < 255)).toBe(true)
    await opened.workspace.close(true)
  })

  it('maps a full-canvas transient region through rotated crop/contain geometry into source pixels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-mask-rotated-'))
    roots.push(root)
    const opened = await ProjectWorkspace.create(join(root, 'Rotated.aicanvas'), 'Rotated')
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width: 400, height: 240, channels: 4, background: '#718496' } }).png().toFile(sourcePath)
    const source = await opened.workspace.assets.importImage({ sourcePath })
    const target: SceneElement = {
      id: '11000000-0000-4000-8000-000000000081', version: ELEMENT_SCHEMA_VERSION, type: 'image', name: 'Rotated source', description: '',
      transform: { x: .18, y: .14, width: .62, height: .68, rotation: 24 }, zIndex: 0, opacity: 1, visible: true, locked: false,
      groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: source.id,
      crop: { x: .1, y: .12, width: .76, height: .72 }, fit: 'contain', referenceRole: 'general'
    }
    const mask: SceneElement = {
      id: '11000000-0000-4000-8000-000000000082', version: ELEMENT_SCHEMA_VERSION, type: 'mask', name: 'Transient canvas region', description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: 1, opacity: 1, visible: true, locked: false,
      groupId: null, semanticRole: 'ephemeral-edit-mask', referencePolicy: 'exclude', mode: 'generate', targetElementId: target.id,
      paths: [{ id: '11000000-0000-4000-8000-000000000083', points: [{ x: .34, y: .31 }, { x: .59, y: .34 }, { x: .57, y: .58 }, { x: .33, y: .55 }], closed: true }], feather: .04
    }
    const fixture = createNightVeilScene()
    const scene = sceneSchema.parse({ ...fixture, projectId: opened.workspace.metadata.id, elements: [target, mask], relations: [] })
    const compiled = await new EditMaskCompiler({
      assetStore: opened.workspace.assets, stagingDirectory: join(root, 'staging'), idFactory: () => '11000000-0000-4000-8000-000000000084'
    }).compile(scene, target.id, source)
    const pixels = await sharp(await readFile(opened.workspace.assets.resolveOriginal(compiled.asset))).greyscale().removeAlpha().raw().toBuffer()
    const active = [...pixels].reduce((count, value) => count + Number(value > 8), 0)
    expect(active).toBeGreaterThan(1_000)
    expect(active).toBeLessThan(400 * 240 * .6)
    expect(compiled.contributingMaskIds).toEqual([mask.id])
    await opened.workspace.close(true)
  })
})
