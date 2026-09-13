import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { defaultProjectWorkContext } from '../../src/shared/project-work-context'
import { makeImage } from '../fixtures/scene-fixtures'

const roots: string[] = []
const runtimes: GenerationRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'context-')); roots.push(root)
  const fetch = vi.fn(async () => { throw new Error('OFFLINE_CONTEXT_BOUNDARY') }); vi.stubGlobal('fetch', fetch)
  const userData = join(root, 'user-data')
  const runtime = await GenerationRuntime.create(userData); runtimes.push(runtime)
  return { root, userData, runtime, fetch }
}

it('persists separate A/B draft and compare facts across switch/restart; rejects old-owner writes and assets', async () => {
  const { root, runtime, userData, fetch } = await fixture()
  const a = await runtime.createProject(join(root, 'A.aicanvas'), 'A')
  const savedA = defaultProjectWorkContext(a.projectId)
  savedA.generation = { ...savedA.generation, prompt: 'A 三个版本', quantity: 3, focusedResultId: randomUUID(), compareAId: randomUUID(), compareBId: randomUUID(), compareEnabled: true, resultScrollLeft: 84 }
  savedA.conversationDraft = 'A 的待发送需求'
  savedA.workspace = { ...savedA.workspace, activeView: 'generate', zoom: 1.6, pan: { x: 22, y: -36 } }
  runtime.saveProjectWorkContext(savedA)
  const b = await runtime.createProject(join(root, 'B.aicanvas'), 'B')
  expect(b.workContext).toBeNull()
  const savedB = defaultProjectWorkContext(b.projectId)
  savedB.generation.prompt = 'B 自己的草稿'
  runtime.saveProjectWorkContext(savedB)
  expect(() => runtime.saveProjectWorkContext(savedA)).toThrow(/项目/)
  expect(() => runtime.executeSceneCommands({ projectId: a.projectId, expectedSceneRevision: b.scene.revision, batch: { id: randomUUID(), origin: 'user', summary: '迟到 A', commands: [{ kind: 'element.add', element: makeImage() }] } })).toThrow(/PROJECT_CHANGED/)
  await expect(runtime.readAssetDataUrl(randomUUID(), false, a.projectId)).rejects.toThrow(/PROJECT_CHANGED/)
  await expect(runtime.placeGenerationResult({ projectId: a.projectId, resultId: randomUUID(), placementId: randomUUID(), origin: 'user' })).rejects.toThrow(/PROJECT_CHANGED/)
  expect(runtime.getWorkspaceBootstrap().scene.elements).toHaveLength(0)
  const restoredA = await runtime.openRecentProject(a.projectId)
  expect(restoredA?.workContext).toEqual(savedA)
  await runtime.close()
  const reopened = await GenerationRuntime.create(userData); runtimes.push(reopened)
  expect(reopened.getWorkspaceBootstrap().workContext).toEqual(savedA)
  expect((await reopened.openRecentProject(b.projectId))?.workContext).toEqual(savedB)
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps an unknown future work context untouched while the Scene remains readable', async () => {
  const { root, runtime, userData, fetch } = await fixture()
  const path = join(root, 'Future.aicanvas')
  const a = await runtime.createProject(path, 'Future')
  await runtime.close()
  const db = new Database(join(path, 'project.db'))
  const future = JSON.stringify({ ...defaultProjectWorkContext(a.projectId), version: 99, futureFact: 'retain' })
  db.prepare('INSERT INTO project_work_context VALUES (?, ?, ?)').run(a.projectId, future, new Date().toISOString())
  db.close()
  const reopened = await GenerationRuntime.create(userData); runtimes.push(reopened)
  expect(reopened.getWorkspaceBootstrap()).toMatchObject({ projectId: a.projectId, workContext: null, scene: { elements: [] } })
  expect(reopened.getWorkspaceBootstrap().workContextProblem).toBeTruthy()
  expect(() => reopened.saveProjectWorkContext(defaultProjectWorkContext(a.projectId))).toThrow()
  const check = new Database(join(path, 'project.db'), { readonly: true })
  expect(check.prepare('SELECT context_json FROM project_work_context').get()).toEqual({ context_json: future }); check.close()
  expect(fetch).not.toHaveBeenCalled()
})
