import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createScene } from '../../src/domain'
import {
  allocateProjectDirectory,
  LibrarySettingsStore,
  migrateProjectLibrary,
  rebuildProjectCover,
  sanitizeProjectName
} from '../../src/main/storage/project-library'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('project library', () => {
  it('normalizes unsafe and reserved Windows project names', () => {
    expect(sanitizeProjectName('  海报：春/夏  ')).toBe('海报 春 夏')
    expect(sanitizeProjectName('CON')).toBe('未命名创作')
    expect(sanitizeProjectName('...')).toBe('未命名创作')
    expect(sanitizeProjectName('春'.repeat(180))).toHaveLength(96)
  })

  it('allocates a unique project package without asking for a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-library-'))
    roots.push(root)
    await mkdir(join(root, '未命名创作.aicanvas'))
    const target = await allocateProjectDirectory(root, '未命名创作')
    expect(target).toEqual({ directory: join(root, '未命名创作 2.aicanvas'), name: '未命名创作 2' })
  })

  it('stores only the future library root without moving old projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-library-'))
    roots.push(root)
    const oldRoot = join(root, '旧项目库')
    const nextRoot = join(root, '新项目库')
    await mkdir(join(oldRoot, '原作.aicanvas'), { recursive: true })
    const store = new LibrarySettingsStore(join(root, 'state', 'library-settings.json'), oldRoot, () => '2026-08-13T00:00:00.000Z')
    expect((await store.get()).rootDirectory).toBe(oldRoot)
    expect((await store.set(nextRoot)).rootDirectory).toBe(nextRoot)
    await expect(stat(join(oldRoot, '原作.aicanvas'))).resolves.toBeDefined()
  })

  it('rebuilds a missing or damaged cover cache from a project asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-library-'))
    roots.push(root)
    const projectDirectory = join(root, '封面.aicanvas')
    const assetDirectory = join(projectDirectory, 'assets', 'thumbnails')
    await mkdir(assetDirectory, { recursive: true })
    const thumbnailPath = join(assetDirectory, 'source.webp')
    await sharp({ create: { width: 80, height: 120, channels: 4, background: '#274568' } }).webp().toFile(thumbnailPath)
    const scene = createScene({ id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', now: '2026-08-13T00:00:00.000Z' })
    const assets = [{
      id: '00000000-0000-4000-8000-000000000003', projectId: scene.projectId,
      relativePath: 'assets/original/source.webp', thumbnailRelativePath: 'assets/thumbnails/source.webp',
      contentHash: 'a'.repeat(64), width: 80, height: 120, format: 'webp' as const, hasAlpha: false,
      sourceType: 'generated' as const, sourceId: null, status: 'available' as const, createdAt: scene.createdAt
    }]

    const first = await rebuildProjectCover(projectDirectory, scene, assets)
    expect(first.source).toBe('generated')
    expect(first.dataUrl).toMatch(/^data:image\/webp;base64,/)
    await writeFile(join(projectDirectory, 'preview', 'cover.webp'), 'damaged')
    const rebuilt = await rebuildProjectCover(projectDirectory, scene, assets)
    expect(rebuilt.source).toBe('generated')
    expect((await sharp(await readFile(join(projectDirectory, 'preview', 'cover.webp'))).metadata()).format).toBe('webp')
  })

  it('copies, verifies and reports a fixture migration while preserving the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-library-'))
    roots.push(root)
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    const projectDirectory = join(source, '旧作.aicanvas')
    const opened = await ProjectWorkspace.create(projectDirectory, '旧作', {
      idFactory: (() => { let index = 1; return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}` })(),
      now: () => '2026-08-13T00:00:00.000Z'
    })
    await opened.workspace.close()

    const report = await migrateProjectLibrary(source, destination, {
      idFactory: (() => { let index = 20; return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}` })(),
      now: () => '2026-08-13T01:00:00.000Z'
    })
    expect(report).toMatchObject({ switched: true, sourcePreserved: true })
    expect(report.items).toEqual([expect.objectContaining({ projectName: '旧作.aicanvas', status: 'copied' })])
    await expect(stat(join(source, '旧作.aicanvas', 'project.db'))).resolves.toBeDefined()
    await expect(stat(join(destination, '旧作.aicanvas', 'project.db'))).resolves.toBeDefined()
  })

  it('does not approve an atomic switch when a destination conflict is skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-library-'))
    roots.push(root)
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(join(source, '同名.aicanvas'), { recursive: true })
    await mkdir(join(destination, '同名.aicanvas'), { recursive: true })
    const report = await migrateProjectLibrary(source, destination)
    expect(report.switched).toBe(false)
    expect(report.items).toEqual([expect.objectContaining({ status: 'skipped' })])
  })
})
