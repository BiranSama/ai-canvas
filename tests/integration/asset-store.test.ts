import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore } from '../../src/main/storage/asset-store'
import type { AssetMetadata, ProjectRepository } from '../../src/main/storage/project-repository'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const PROJECT = '00000000-0000-4000-8000-000000000001'
const ASSET = '00000000-0000-4000-8000-000000000002'

/** The two calls an import makes, recorded; nothing else is needed. */
function repository(): { readonly repository: ProjectRepository; readonly inserted: AssetMetadata[] } {
  const inserted: AssetMetadata[] = []
  const stub = {
    findAssetByHash: async () => null,
    insertAsset: async (asset: AssetMetadata) => { inserted.push(asset) }
  }
  return { repository: stub as unknown as ProjectRepository, inserted }
}

async function picture(root: string): Promise<string> {
  const path = join(root, 'source.png')
  await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toFile(path)
  return path
}

describe('importing an image into a project', () => {
  it('works when the copied original lands beyond Windows\' 260-character path limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asset-store-'))
    roots.push(root)
    const source = await picture(root)
    // Deep enough that <project>\assets\original\<sha256>.png passes 300 characters.
    let project = join(root, 'p'.repeat(60), 'r'.repeat(60), 'o'.repeat(60))
    project = join(project, 'j'.repeat(Math.max(1, 300 - project.length - 90)))
    await mkdir(project, { recursive: true })
    const { repository: store, inserted } = repository()
    const assets = new AssetStore(project, PROJECT, store, { idFactory: () => ASSET })

    const asset = await assets.importImage({ sourcePath: source })
    expect(assets.resolveOriginal(asset).length).toBeGreaterThan(300)
    expect(inserted).toHaveLength(1)
    expect(asset).toMatchObject({ width: 2, height: 2, format: 'png', status: 'available' })
    expect((await stat(assets.resolveOriginal(asset))).size).toBeGreaterThan(0)
    expect((await stat(assets.resolveThumbnail(asset))).size).toBeGreaterThan(0)
  })

  it('leaves no unregistered copy behind when the import fails halfway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asset-store-'))
    roots.push(root)
    const source = await picture(root)
    const project = join(root, 'project')
    // A folder where the thumbnail should be written makes the second write fail.
    await mkdir(join(project, 'assets', 'thumbnails', `${ASSET}.webp`), { recursive: true })
    const { repository: store, inserted } = repository()
    const assets = new AssetStore(project, PROJECT, store, { idFactory: () => ASSET })

    await expect(assets.importImage({ sourcePath: source })).rejects.toThrow()
    expect(inserted).toHaveLength(0)
    expect(await readdir(join(project, 'assets', 'original'))).toEqual([])
  })
})
