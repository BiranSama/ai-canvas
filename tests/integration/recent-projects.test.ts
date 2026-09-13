import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { RecentProjectsStore } from '../../src/main/storage/recent-projects-store'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('RecentProjectsStore', () => {
  it('keeps the newest unique local projects in an atomic versioned registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-recents-'))
    roots.push(root)
    const store = new RecentProjectsStore(join(root, 'state', 'recent-projects.json'))

    for (let index = 0; index < 22; index += 1) {
      await store.record({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `项目 ${index}`,
        path: join(root, `project-${index}.aicanvas`),
        lastOpenedAt: `2026-08-10T00:00:${String(index).padStart(2, '0')}.000Z`
      })
    }

    const recent = await store.list()
    expect(recent).toHaveLength(20)
    expect(recent[0]?.name).toBe('项目 21')
    expect(recent.at(-1)?.name).toBe('项目 2')
    expect(recent[0]).toMatchObject({ aspectLabel: '自由画布', favorite: false, coverSource: 'none' })
  })

  it('keeps missing entries and updates only the safe card summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-recents-'))
    roots.push(root)
    const store = new RecentProjectsStore(join(root, 'state', 'recent-projects.json'))
    const id = '00000000-0000-4000-8000-000000000001'
    await store.record({ id, name: '雨后长标题项目', path: join(root, 'missing.aicanvas'), lastOpenedAt: '2026-08-13T00:00:00.000Z' })

    await store.update(id, { favorite: true, aspectLabel: '4:5', path: join(root, 'relocated.aicanvas') })
    expect(await store.list()).toEqual([
      expect.objectContaining({ id, favorite: true, aspectLabel: '4:5', path: join(root, 'relocated.aicanvas') })
    ])
  })
})
