import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecentProjectsStore } from '../../src/main/storage/recent-projects-store'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

describe('recent projects atomic index', () => {
  it('serializes overlapping records and metadata refreshes without losing the newest project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-recent-race-'))
    roots.push(root)
    const store = new RecentProjectsStore(join(root, 'recent-projects.json'))
    const a = { id: '10000000-0000-4000-8000-000000000001', name: 'Poster A', path: join(root, 'A.aicanvas'), lastOpenedAt: '2026-08-14T00:00:00.000Z' }
    const b = { id: '10000000-0000-4000-8000-000000000002', name: 'Poster B', path: join(root, 'B.aicanvas'), lastOpenedAt: '2026-08-14T00:01:00.000Z' }
    await store.record(a)
    await Promise.all([
      store.update(a.id, { aspectLabel: '4:5', coverSource: 'scene' }),
      store.record(b),
      store.setFavorite(a.id, true)
    ])
    const projects = await store.list()
    expect(projects.map((project) => project.name)).toEqual(['Poster B', 'Poster A'])
    expect(projects[1]).toMatchObject({ favorite: true, aspectLabel: '4:5', coverSource: 'scene' })
  })

  it('removes only the exact indexed project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-recent-remove-'))
    roots.push(root)
    const store = new RecentProjectsStore(join(root, 'recent-projects.json'))
    const a = { id: '10000000-0000-4000-8000-000000000011', name: 'Poster A', path: join(root, 'A.aicanvas'), lastOpenedAt: '2026-08-14T00:00:00.000Z' }
    const b = { id: '10000000-0000-4000-8000-000000000012', name: 'Poster B', path: join(root, 'B.aicanvas'), lastOpenedAt: '2026-08-14T00:01:00.000Z' }
    await store.record(a)
    await store.record(b)

    await expect(store.remove(a.id)).resolves.toMatchObject({ id: a.id, name: 'Poster A' })
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: b.id })])
    await expect(store.remove(a.id)).rejects.toThrow('no longer indexed')
  })

  it('drops a corrupt convenience index without touching project packages and can rebuild from the next explicit open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-recent-corrupt-'))
    roots.push(root)
    const packagePath = join(root, 'Preserved.aicanvas')
    const databasePath = join(packagePath, 'project.db')
    const indexPath = join(root, 'state', 'recent-projects.json')
    await mkdir(packagePath, { recursive: true })
    await writeFile(databasePath, 'project-body-remains-owned-by-the-package', 'utf8')
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(indexPath, '{broken recent index', 'utf8')

    const store = new RecentProjectsStore(indexPath)
    await expect(store.list()).resolves.toEqual([])
    expect((await stat(databasePath)).isFile()).toBe(true)

    const reopened = {
      id: '10000000-0000-4000-8000-000000000021',
      name: 'Preserved',
      path: packagePath,
      lastOpenedAt: '2026-09-01T08:00:00.000Z'
    }
    await store.record(reopened)

    await expect(store.list()).resolves.toEqual([expect.objectContaining(reopened)])
    await expect(stat(databasePath)).resolves.toMatchObject({ size: 41 })
  })
})
