import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { GenerationJobRepository, GenerationWorkflowCoordinator, GenerationWorkflowRepository } from '../../src/main/generation'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import { AgentContextRepository, AgentHarnessRepository } from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { AssetStore } from '../../src/main/storage/asset-store'
import { SceneService } from '../../src/main/scene'
import { DEFAULT_AUTO_BUDGET } from '../../src/shared/agent-harness'
import { generationRequestSchema } from '../../src/shared/generation'
import { defaultProjectWorkContext } from '../../src/shared/project-work-context'
import { deserializeSceneSnapshot } from '../../src/domain'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()?.()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  // Retain this run's synthetic databases for copy/recovery evidence. Native
  // Windows file deletion is not part of the product's copy acceptance gate.
  for (const path of roots.splice(0)) await writeFile(join(path, 'fixture-evidence.json'), JSON.stringify({ purpose: 'C06 isolated copy and source recovery evidence', retained: true }))
})
async function root() { const path = await mkdtemp(join(tmpdir(), 'copy-')); roots.push(path); return path }
function request(prompt: string) { return generationRequestSchema.parse({ prompt, negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 128, outputHeight: 128, count: 1,
  providerId: 'mock', model: 'mock-balanced', references: [], parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 }, sourceMessageId: null, parentResultId: null }) }
function facts(path: string) {
  const db = new Database(path, { readonly: true })
  try { return {
    snapshots: db.prepare('SELECT rowid, id, scene_revision, reason, scene_json FROM scene_snapshots ORDER BY rowid').all() as Array<{ rowid: number; id: string; scene_revision: number; reason: string; scene_json: string }>,
    batches: db.prepare('SELECT rowid, id, revision_before, revision_after FROM operation_batches ORDER BY rowid').all(),
    assets: db.prepare('SELECT id, relative_path, content_hash FROM assets ORDER BY id').all(),
    results: db.prepare('SELECT id, asset_id, parent_result_id, favorite FROM generation_results ORDER BY id').all(),
    fk: db.pragma('foreign_key_check')
  } } finally { db.close() }
}

it('copies real local results, lineage, memory and ordered Undo/Redo into an independent editable project', async () => {
  const path = await root()
  const network = vi.fn(async () => { throw new Error('COPY_NETWORK_BLOCKED') }); vi.stubGlobal('fetch', network)
  const runtime = await GenerationRuntime.create(join(path, 'user-data')); closers.push(() => runtime.close())
  const sourcePath = join(path, 'A.aicanvas'), copyPath = join(path, 'B.aicanvas')
  const a = await runtime.createProject(sourcePath, 'A')
  const first = await runtime.enqueue(request('山海封面'))
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === first.id)?.status).toBe('completed')
  const firstResult = (await runtime.listJobs())[0]!.results[0]!
  const nextRequest = request('只改变光线，保留主体')
  const second = await runtime.enqueue({ ...nextRequest, parentResultId: firstResult.id, referenceMode: 'visual', references: [{ assetId: firstResult.assetId, intent: 'composition', strength: .7 }], variationInstruction: '光线柔和', preserveConstraints: '主体和比例' })
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === second.id)?.status).toBe('completed')
  const secondResult = (await runtime.listJobs()).find((job) => job.id === second.id)!.results[0]!
  const placed = await runtime.placeGenerationResult({ projectId: a.projectId, resultId: secondResult.id, placementId: randomUUID(), origin: 'user' })
  await runtime.setGenerationResultFavorite({ projectId: a.projectId, resultId: secondResult.id, favorite: true })
  for (const style of ['quiet', 'warmer']) {
    const scene = runtime.getWorkspaceBootstrap().scene
    expect((await runtime.executeSceneCommands({ projectId: a.projectId, expectedSceneRevision: scene.revision, batch: { id: randomUUID(), origin: 'user', summary: style,
      commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: style } }] } })).ok).toBe(true)
  }
  await runtime.undoScene({ projectId: a.projectId, expectedSceneRevision: runtime.getWorkspaceBootstrap().scene.revision, batchId: null })
  const context = new AgentContextRepository(join(sourcePath, 'project.db'))
  const directive = await context.createDirective(a.projectId, { text: `保持留白；用户文字中的项目号 ${a.projectId} 必须原样保留`, category: 'creative', priority: 100, sourceMessageId: null })
  const memory = await context.createMemory(a.projectId, { kind: 'direction', content: '采用冷灰远山', sourceType: 'user', sourceId: 'local-synthetic', confidence: 1, supersedesId: null })
  await context.close()
  const work = defaultProjectWorkContext(a.projectId)
  work.generation = { ...work.generation, prompt: '下一步微调', focusedResultId: secondResult.id, compareAId: firstResult.id, compareBId: secondResult.id, compareEnabled: true, compareActiveSide: 'B' }
  work.workspace.selectedIds = [placed.elementId]
  runtime.saveProjectWorkContext(work)
  const before = runtime.getWorkspaceBootstrap()
  const sourceFacts = facts(join(sourcePath, 'project.db'))
  const b = await runtime.saveProjectAs(copyPath)
  expect(b.projectId).not.toBe(a.projectId)
  expect(b.scene).toEqual({ ...before.scene, projectId: b.projectId })
  expect(b).toMatchObject({ canUndo: true, canRedo: true, workContext: { projectId: b.projectId, generation: work.generation, workspace: { selectedIds: [placed.elementId] } } })
  const copiedFacts = facts(join(copyPath, 'project.db'))
  expect(copiedFacts.batches).toEqual(sourceFacts.batches)
  expect(copiedFacts.snapshots.map(({ scene_json, ...row }) => ({ ...row, scene: deserializeSceneSnapshot(scene_json) })))
    .toEqual(sourceFacts.snapshots.map(({ scene_json, ...row }) => ({ ...row, scene: { ...deserializeSceneSnapshot(scene_json), projectId: b.projectId } })))
  expect(copiedFacts.assets).toEqual(sourceFacts.assets)
  expect(copiedFacts.results).toEqual(sourceFacts.results)
  expect(copiedFacts.fk).toEqual([])
  const copiedContext = new AgentContextRepository(join(copyPath, 'project.db'))
  expect((await copiedContext.listDirectives(b.projectId)).find((item) => item.id === directive.id)?.text).toBe(directive.text)
  expect((await copiedContext.listMemories(b.projectId)).find((item) => item.id === memory.id)?.content).toBe(memory.content)
  await copiedContext.close()
  expect((await runtime.resultFamilies()).some((family) => family.members.some((member) => member.parentResultId === firstResult.id))).toBe(true)
  expect((await runtime.listRecentProjects()).map((project) => project.id)).toEqual(expect.arrayContaining([a.projectId, b.projectId]))
  await expect(runtime.retry(second.id)).rejects.toMatchObject({ code: 'PROJECT_COPY_REQUIRES_NEW_REQUEST' })
  const redo = await runtime.redoScene({ projectId: b.projectId, expectedSceneRevision: b.scene.revision, batchId: null })
  expect(redo.ok && redo.receipt.state.scene.canvas.globalStyle).toBe('warmer')
  expect(redo.ok && redo.receipt.state.scene.projectId).toBe(b.projectId)
  expect(facts(join(sourcePath, 'project.db'))).toEqual(sourceFacts)
  await runtime.close()
  const reopened = await GenerationRuntime.create(join(path, 'user-data')); closers.push(() => reopened.close())
  expect(reopened.getWorkspaceBootstrap()).toMatchObject({ projectId: b.projectId, canUndo: true })
  const undo = await reopened.undoScene({ projectId: b.projectId, expectedSceneRevision: reopened.getWorkspaceBootstrap().scene.revision, batchId: null })
  expect(undo.ok && undo.receipt.state.scene.projectId).toBe(b.projectId)
  const fresh = await reopened.enqueue(request('副本的新创作'))
  await expect.poll(async () => (await reopened.listJobs()).find((job) => job.id === fresh.id)?.status).toBe('completed')
  expect((await reopened.listJobs()).find((job) => job.id === fresh.id)?.copiedFromProjectId).toBeNull()
  expect(facts(join(sourcePath, 'project.db'))).toEqual(sourceFacts)
  expect(network).not.toHaveBeenCalled()
})

it('detaches queued, accepted and unknown work and erases tokens and grants while preserving source facts', async () => {
  const path = await root()
  const source = await ProjectWorkspace.create(join(path, 'source.aicanvas'), 'Synthetic source')
  const databasePath = join(source.workspace.directory, 'project.db')
  const jobs = new GenerationJobRepository(databasePath), workflows = new GenerationWorkflowRepository(databasePath), harness = new AgentHarnessRepository(databasePath)
  const projectId = source.workspace.metadata.id
  const thread = await harness.ensureThread(projectId)
  const goal = await harness.createGoal(thread.id, { objective: '保留的创作任务', completionDefinition: ['保留图片'], mode: 'auto',
    scope: { canvas: true, elementIds: [], assetIds: [], providerIds: ['mock'] }, permissionProfileId: 'source-only', budget: DEFAULT_AUTO_BUDGET, prohibitions: [] })
  const turn = await harness.startTurn(thread.id, { goalId: goal.id, inputMessageId: null, sceneRevisionAtStart: 0, taskRelation: 'temporary_try' })
  const call = await harness.appendItem(turn.id, { type: 'tool_call', status: 'started', payloadVersion: 1, payload: { scene: source.scene, note: projectId } })
  const coordinator = new GenerationWorkflowCoordinator({ repository: workflows, queue: { enqueue: (request) => jobs.createJob({ projectId, request }),
    listJobs: () => jobs.listJobs(projectId), cancel: (id) => jobs.requestCancel(id) } })
  const created = []
  for (const [index, status] of ['queued', 'accepted', 'unknown'].entries()) {
    const result = await coordinator.create({ projectId, request: request(status), capabilities: new MockImageProvider(join(path, 'mock-staging')).capabilities, profileId: 'local-sketch', tier: 'local-sketch',
      operation: 'text', sourceSceneRevision: 0, idempotencyKey: `source-${index}`, limits: { maxJobs: 1, maxImages: 1, maxCostCny: 0, maxWallTimeMs: 120000, noImprovementLimit: 1 }, estimatedCostCny: 0 })
    created.push(result)
    await workflows.subscribe({ projectId, threadId: thread.id, turnId: turn.id, intentId: result.intent.id, jobId: result.job.id, jobStatus: 'queued' })
  }
  const db = new Database(databasePath)
  db.prepare("UPDATE generation_jobs SET status = 'generating', stage = 'generating', external_task_id = 'accepted-source-task', submission_state = 'accepted', execution_identity_id = 'source-binding' WHERE id = ?").run(created[1]!.job.id)
  db.prepare("UPDATE generation_workflow_intents SET status = 'external_unknown', job_id = NULL WHERE id = ?").run(created[2]!.intent.id)
  db.prepare("UPDATE generation_jobs SET status = 'interrupted', stage = 'interrupted', submission_state = 'may_have_sent' WHERE id = ?").run(created[2]!.job.id)
  db.prepare("UPDATE agent_turns_v2 SET status = 'waiting_job', write_lease_id = 'synthetic-lease' WHERE id = ?").run(turn.id)
  db.prepare('INSERT INTO agent_generation_limits VALUES (?, ?, ?, ?, ?, ?)').run(turn.id, projectId, thread.id, JSON.stringify(DEFAULT_AUTO_BUDGET), call.id, new Date().toISOString())
  const toolId = randomUUID(), now = new Date().toISOString()
  db.prepare(`INSERT INTO agent_tool_calls_v2 (id, project_id, thread_id, turn_id, ordinal, tool_name, definition_version, risk, status, idempotency_key, scope_json, arguments_json,
    permission_json, approval_json, execution_token_hash, renderer_session_hash, token_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'scene.apply_batch', 1, 'persistent_reversible', 'prepared', 'source-call', ?, ?, ?, ?, 'synthetic-token-hash', 'synthetic-session-hash', ?, ?, ?)`)
    .run(toolId, projectId, thread.id, turn.id, JSON.stringify({ canvas: true, elementIds: [] }), JSON.stringify({ scene: source.scene }), JSON.stringify({ id: 'source-only', version: 1, label: 'Synthetic', permissions: [], allowedTools: [], allowExternal: true, allowDangerous: false, maxCostCny: 10 }),
      JSON.stringify({ effect: 'allow', source: 'explicit_turn_request', code: 'SYNTHETIC_APPROVED', explanation: '原项目批准' }), now, now, now)
  db.close()
  await jobs.close(); await workflows.close(); await harness.close()
  const copied = await source.workspace.saveAs(join(path, 'copy.aicanvas'))
  const copiedPath = copied.workspace.directory, copyId = copied.workspace.metadata.id
  await copied.workspace.close()
  const inspect = new Database(join(copiedPath, 'project.db'), { readonly: true })
  expect(inspect.prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE status IN ('queued','preparing','generating','downloading')").get()).toEqual({ count: 0 })
  expect(inspect.prepare('SELECT COUNT(*) AS count FROM agent_generation_limits').get()).toEqual({ count: 0 })
  expect(inspect.prepare("SELECT COUNT(*) AS count FROM generation_subscriptions WHERE status = 'waiting'").get()).toEqual({ count: 0 })
  expect(inspect.prepare('SELECT active_turn_id, active_goal_id FROM agent_threads').get()).toEqual({ active_turn_id: null, active_goal_id: null })
  expect(inspect.prepare('SELECT status, write_lease_id, temporary_state FROM agent_turns_v2').get()).toEqual({ status: 'interrupted', write_lease_id: null, temporary_state: 'rejected' })
  expect(inspect.prepare('SELECT status, execution_token_hash, renderer_session_hash, token_expires_at FROM agent_tool_calls_v2').get()).toEqual({ status: 'expired', execution_token_hash: null, renderer_session_hash: null, token_expires_at: null })
  const payload = JSON.parse((inspect.prepare('SELECT payload_json FROM agent_items WHERE id = ?').get(call.id) as { payload_json: string }).payload_json)
  expect(payload.scene.projectId).toBe(copyId); expect(payload.note).toBe(projectId)
  const manifest = JSON.parse((inspect.prepare('SELECT manifest_json FROM project_copy_records').get() as { manifest_json: string }).manifest_json)
  expect(manifest.sourceJobs).toContainEqual(expect.objectContaining({ status: 'generating', external_task_id: 'accepted-source-task' }))
  expect(manifest.sourceTurnLimits).toHaveLength(1)
  expect(JSON.stringify(manifest)).not.toContain('synthetic-token-hash')
  expect(inspect.pragma('foreign_key_check')).toEqual([])
  inspect.close()
  const sourceDb = new Database(databasePath, { readonly: true })
  expect(sourceDb.prepare('SELECT status FROM generation_jobs WHERE id = ?').get(created[1]!.job.id)).toEqual({ status: 'generating' })
  expect(sourceDb.prepare('SELECT status FROM agent_turns_v2').get()).toEqual({ status: 'waiting_job' })
  sourceDb.close()
  const network = vi.fn(async () => { throw new Error('COPY_NO_POST_GET_OR_DOWNLOAD') }); vi.stubGlobal('fetch', network)
  const generate = vi.spyOn(MockImageProvider.prototype, 'generate')
  const runtime = await GenerationRuntime.create(join(path, 'copy-runtime')); closers.push(() => runtime.close())
  await runtime.openProject(copiedPath)
  await runtime.close()
  const reopened = await GenerationRuntime.create(join(path, 'copy-runtime')); closers.push(() => reopened.close())
  expect((await reopened.listJobs()).every((job) => job.copiedFromProjectId === projectId && job.executionIdentityId === null)).toBe(true)
  await expect(reopened.retry(created[0]!.job.id)).rejects.toMatchObject({ code: 'PROJECT_COPY_REQUIRES_NEW_REQUEST' })
  expect(generate).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
})

it.each(['history', 'asset'])('rolls back an invalid %s copy and keeps the source open and its bytes intact', async (kind) => {
  const path = await root()
  const source = await ProjectWorkspace.create(join(path, 'source.aicanvas'), 'Source')
  const image = join(path, 'synthetic.png')
  await writeFile(image, await sharp({ create: { width: 128, height: 128, channels: 4, background: '#c3d4e5' } }).png().toBuffer())
  const asset = await source.workspace.assets.importImage({ sourcePath: image, sourceType: 'imported' })
  if (kind === 'history') {
    const db = new Database(join(source.workspace.directory, 'project.db'))
    db.prepare("UPDATE scene_snapshots SET scene_json = 'broken-history'").run(); db.close()
  } else await writeFile(source.workspace.assets.resolveOriginal(asset), 'corrupted-source-asset')
  const before = await readFile(source.workspace.assets.resolveOriginal(asset))
  await expect(source.workspace.saveAs(join(path, 'copy.aicanvas'))).rejects.toThrow()
  expect(await readFile(source.workspace.assets.resolveOriginal(asset))).toEqual(before)
  expect((await source.workspace.repository.getProject()).id).toBe(source.workspace.metadata.id)
  await expect(readFile(join(path, 'copy.aicanvas', 'project.db'))).rejects.toMatchObject({ code: 'ENOENT' })
  await source.workspace.close()
})

it.each(['prepare', 'publish'])('recovers the source after a %s failure and permits the next valid edit and copy', async (phase) => {
  const path = await root()
  const runtime = await GenerationRuntime.create(join(path, 'runtime')); closers.push(() => runtime.close())
  const a = await runtime.createProject(join(path, 'A.aicanvas'), 'A')
  if (phase === 'prepare') vi.spyOn(SceneService.prototype, 'flush').mockRejectedValueOnce(new Error('SYNTHETIC_COPY_FAILED'))
  else vi.spyOn(ProjectWorkspace, 'open').mockRejectedValueOnce(new Error('SYNTHETIC_COPY_FAILED'))
  await expect(runtime.saveProjectAs(join(path, 'failed.aicanvas'))).rejects.toThrow('SYNTHETIC_COPY_FAILED')
  await expect(readFile(join(path, 'failed.aicanvas', 'project.db'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(a.scene)
  const changed = await runtime.executeSceneCommands({ projectId: a.projectId, expectedSceneRevision: a.scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: '故障后继续', commands: [{ kind: 'scene.set-canvas', canvas: { ...a.scene.canvas, globalStyle: 'still editable' } }] } })
  expect(changed.ok).toBe(true)
  const b = await runtime.saveProjectAs(join(path, 'B.aicanvas'))
  expect(b.projectId).not.toBe(a.projectId)
  expect(b.scene.canvas.globalStyle).toBe('still editable')
})

it('migrates a synthetic version-13 project with a backup before creating the independent copy', async () => {
  const path = await root()
  const sourcePath = join(path, 'old.aicanvas')
  const initial = await ProjectWorkspace.create(sourcePath, 'Old')
  const sourceId = initial.workspace.metadata.id
  initial.workspace.repository.saveWorkContext(defaultProjectWorkContext(sourceId))
  await initial.workspace.close()
  const db = new Database(join(sourcePath, 'project.db'))
  db.exec('ALTER TABLE generation_jobs DROP COLUMN cost_json; ALTER TABLE generation_jobs DROP COLUMN copied_from_project_id; DROP TABLE project_copy_records; DELETE FROM schema_migrations WHERE version >= 14;')
  db.close()
  const reopened = await ProjectWorkspace.open(sourcePath)
  const migration = reopened.workspace.repository.migrationResult
  expect(migration).toMatchObject({ fromVersion: 13, toVersion: 15 })
  expect(migration.backupPath).not.toBeNull()
  const backup = new Database(migration.backupPath!, { readonly: true })
  expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 })
  backup.close()
  const copied = await reopened.workspace.saveAs(join(path, 'new.aicanvas'))
  expect(copied.scene.projectId).not.toBe(sourceId)
  expect(copied.workspace.repository.getWorkContext(copied.scene.projectId)?.projectId).toBe(copied.scene.projectId)
  await copied.workspace.close()
})

it('drains an owned import before copying and rejects concurrent open, create and save-as operations', async () => {
  const path = await root()
  const runtime = await GenerationRuntime.create(join(path, 'runtime')); closers.push(() => runtime.close())
  const a = await runtime.createProject(join(path, 'A.aicanvas'), 'A')
  const other = await ProjectWorkspace.create(join(path, 'C.aicanvas'), 'C'); await other.workspace.close()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const importImage = AssetStore.prototype.importImage
  vi.spyOn(AssetStore.prototype, 'importImage').mockImplementationOnce(async function (this: AssetStore, input) { started(); await gate; return importImage.call(this, input) })
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#abc' } }).png().toBuffer()
  const importing = runtime.importAsset({ projectId: a.projectId, name: 'incoming.png', mimeType: 'image/png', bytes: png })
  await entered
  const copying = runtime.saveProjectAs(join(path, 'B.aicanvas'))
  await expect(runtime.openProject(join(path, 'C.aicanvas'))).rejects.toThrow('PROJECT_OPERATION_BUSY')
  await expect(runtime.createProject(join(path, 'unexpected.aicanvas'), 'Unexpected')).rejects.toThrow('PROJECT_OPERATION_BUSY')
  await expect(runtime.saveProjectAs(join(path, 'unexpected-copy.aicanvas'))).rejects.toThrow('PROJECT_OPERATION_BUSY')
  release()
  const asset = await importing
  const b = await copying
  expect(b.projectId).not.toBe(a.projectId)
  expect(await runtime.readAssetDataUrl(asset.id, false, b.projectId)).toMatch(/^data:image\/png;base64,/)
  expect(runtime.getWorkspaceBootstrap().projectId).toBe(b.projectId)
  expect(facts(join(path, 'A.aicanvas', 'project.db')).assets).toEqual(facts(join(path, 'B.aicanvas', 'project.db')).assets)
  await expect(readFile(join(path, 'unexpected.aicanvas', 'project.db'))).rejects.toMatchObject({ code: 'ENOENT' })
})
