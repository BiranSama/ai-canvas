import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { makeImage } from '../fixtures/scene-fixtures'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('desktop project runtime', () => {
  it('creates, saves as, reopens the last project and restores imported Asset IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-project-runtime-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(join(root, 'user-data'))
    const projectA = join(root, 'projects', 'Poster A.aicanvas')
    const projectB = join(root, 'projects', 'Poster B.aicanvas')
    await runtime.createProject(projectA, 'Poster A')

    const png = await sharp({
      create: { width: 96, height: 128, channels: 4, background: { r: 34, g: 64, b: 98, alpha: 0.82 } }
    }).png().toBuffer()
    const asset = await runtime.importAsset({ name: 'source.png', mimeType: 'image/png', bytes: new Uint8Array(png) })
    const bootstrap = runtime.getWorkspaceBootstrap()
    const image = { ...makeImage(), id: randomUUID(), assetId: asset.id, name: '持久化图片' }
    const mutation = await runtime.executeSceneCommands({
      expectedSceneRevision: bootstrap.scene.revision,
      batch: {
        id: randomUUID(),
        origin: 'user',
        summary: '添加持久化图片',
        commands: [{ kind: 'element.add', element: image }]
      }
    })
    expect(mutation.ok).toBe(true)
    await runtime.saveProjectAs(projectB)
    await runtime.close()

    const reopened = await GenerationRuntime.create(join(root, 'user-data'))
    expect(reopened.getWorkspaceBootstrap()).toMatchObject({ projectName: 'Poster B', scene: { elements: [{ assetId: asset.id }] } })
    expect(await reopened.readAssetDataUrl(asset.id, false)).toMatch(/^data:image\/png;base64,/)
    expect(await reopened.readAssetDataUrl(asset.id, true)).toMatch(/^data:image\/webp;base64,/)
    const recent = await reopened.listRecentProjects()
    expect(recent[0]).toMatchObject({ name: 'Poster B' })

    await reopened.createProject(join(root, 'projects', 'Scratch.aicanvas'), 'Scratch')
    await reopened.openRecentProject(recent[0]!.id)
    expect(reopened.getWorkspaceBootstrap().scene.elements[0]).toMatchObject({ assetId: asset.id, name: '持久化图片' })
    await reopened.close()
  })

  it('moves an active library project through the injected trash boundary and keeps a valid session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-project-delete-'))
    roots.push(root)
    const userData = join(root, 'user-data')
    const runtime = await GenerationRuntime.create(userData)
    const created = await runtime.createProjectInLibrary('待删除项目')
    const target = join(userData, 'projects', '待删除项目.aicanvas')
    const trashed: string[] = []

    const result = await runtime.deleteRecentProject(created.projectId, async (targetPath) => {
      trashed.push(targetPath)
      await rm(targetPath, { recursive: true })
    })

    expect(trashed).toEqual([target])
    expect(result).toMatchObject({ projectId: created.projectId, disposition: 'trashed' })
    expect(result.projects.some((project) => project.id === created.projectId)).toBe(false)
    expect(result.replacementBootstrap?.projectId).not.toBe(created.projectId)
    expect(runtime.getWorkspaceBootstrap().projectId).toBe(result.replacementBootstrap?.projectId)
    await runtime.close()
  })

  it('only removes an external project card and leaves the external package untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-project-unlink-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(join(root, 'user-data'))
    const externalProject = join(root, '外部项目.aicanvas')
    const created = await runtime.createProject(externalProject, '外部项目')
    let trashCalls = 0

    const result = await runtime.deleteRecentProject(created.projectId, async () => { trashCalls += 1 })

    expect(result.disposition).toBe('removed')
    expect(trashCalls).toBe(0)
    await expect(stat(join(externalProject, 'project.db'))).resolves.toBeDefined()
    await runtime.close()
  })
})
