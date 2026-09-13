import Database from 'better-sqlite3'
import { copyFile, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import { SceneService } from '../../src/main/scene/scene-service'
import { runMigrations } from '../../src/main/storage/migrations'
import { ProjectSession, ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { IDS } from '../fixtures/scene-fixtures'

const roots: string[] = []
sharp.cache(false)

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-storage-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function idFactory(): () => string {
  let value = 100
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

describe('project storage', () => {
  it('migrates an existing database transactionally and preserves a backup', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'project.db')
    const legacy = new Database(databasePath)
    legacy.exec('CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker(value) VALUES (\'keep\');')
    legacy.close()

    const result = runMigrations(databasePath)

    expect(result).toMatchObject({ fromVersion: 0, toVersion: 15 })
    expect(result.backupPath).not.toBeNull()
    await expect(stat(result.backupPath ?? '')).resolves.toMatchObject({ size: expect.any(Number) })
    const migrated = new Database(databasePath)
    const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    migrated.close()
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'scene_snapshots', 'generation_jobs', 'generation_results', 'conversations', 'agent_runs',
        'agent_threads', 'agent_turns_v2', 'agent_items', 'agent_events', 'agent_queue_entries',
        'agent_tool_calls_v2', 'agent_context_manifests', 'agent_context_entries',
        'project_directives', 'project_memory_entries', 'project_memory_candidates',
        'agent_outbound_context_records', 'generation_workflow_intents', 'agent_budget_reservations',
        'generation_subscriptions', 'generation_result_records'
      ])
    )
  })

  it('rejects a future database version without deleting the original data', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'future.db')
    const future = new Database(databasePath)
    future.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (99, '2099-01-01T00:00:00.000Z');
      CREATE TABLE future_data(value TEXT NOT NULL);
      INSERT INTO future_data(value) VALUES ('preserve-me');
    `)
    future.close()

    expect(() => runMigrations(databasePath)).toThrow(/newer than supported/)
    const unchanged = new Database(databasePath, { readonly: true })
    const row = unchanged.prepare('SELECT value FROM future_data').get() as { value: string }
    unchanged.close()
    expect(row.value).toBe('preserve-me')
  })

  it('upgrades v8 task storage additively and maps legacy queue semantics without rewriting old turns', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'version-eight.db')
    const versionEight = new Database(databasePath)
    versionEight.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (8, '2026-08-29T00:00:00.000Z');
      CREATE TABLE generation_jobs(id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE agent_turns_v2 (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL,
        goal_id TEXT,
        input_message_id TEXT,
        status TEXT NOT NULL,
        scene_revision_at_start INTEGER NOT NULL,
        context_manifest_id TEXT,
        write_lease_id TEXT,
        model_turns_used INTEGER NOT NULL DEFAULT 0,
        tool_calls_used INTEGER NOT NULL DEFAULT 0,
        scene_write_batches_used INTEGER NOT NULL DEFAULT 0,
        recovery_attempts_used INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO agent_turns_v2(
        id, thread_id, input_message_id, status, scene_revision_at_start, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000008001',
        '00000000-0000-4000-8000-000000008002',
        'legacy-run', 'completed', 3,
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
      CREATE TABLE agent_queue_entries (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_queue_entries(
        id, thread_id, message_id, mode, position, status, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000008003',
        '00000000-0000-4000-8000-000000008002',
        'queued-run', 'queue_next', 0, 'queued',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
      CREATE TABLE agent_items(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE agent_outbound_context_records (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        manifest_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_id TEXT,
        model TEXT,
        policy TEXT NOT NULL,
        data_types_json TEXT NOT NULL,
        image_asset_ids_json TEXT NOT NULL,
        text_bytes INTEGER NOT NULL,
        image_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    versionEight.close()

    expect(runMigrations(databasePath)).toMatchObject({ fromVersion: 8, toVersion: 15 })
    const migrated = new Database(databasePath, { readonly: true })
    const turn = migrated.prepare('SELECT task_id, task_relation, dispatch_mode, temporary_state FROM agent_turns_v2').get() as Record<string, unknown>
    const queue = migrated.prepare('SELECT task_relation, dispatch_mode FROM agent_queue_entries').get() as Record<string, unknown>
    migrated.close()
    expect(turn).toEqual({ task_id: null, task_relation: null, dispatch_mode: null, temporary_state: null })
    expect(queue).toEqual({ task_relation: 'continue_current', dispatch_mode: 'queue_after_current' })
    await expect(stat(join(root, 'project.pre-migration-v8.bak.db'))).resolves.toBeDefined()
  })

  it('upgrades an existing v1 database through generation and conversation storage with a recoverable backup', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'version-one.db')
    const versionOne = new Database(databasePath)
    versionOne.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-09T00:00:00.000Z');
      CREATE TABLE projects(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE assets(id TEXT PRIMARY KEY NOT NULL);
    `)
    versionOne.close()

    const result = runMigrations(databasePath)

    expect(result).toMatchObject({ fromVersion: 1, toVersion: 15 })
    expect(result.backupPath).toBe(join(root, 'project.pre-migration-v1.bak.db'))
    await expect(stat(result.backupPath ?? '')).resolves.toBeDefined()
    const migrated = new Database(databasePath, { readonly: true })
    const generationTables = migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('generation_jobs', 'generation_results')
      ORDER BY name
    `).all()
    migrated.close()
    expect(generationTables).toHaveLength(2)
  })

  it('keeps a failed legacy migration on the original version without overwriting its data', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'migration-failure.db')
    const versionOne = new Database(databasePath)
    versionOne.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-09T00:00:00.000Z');
      CREATE TABLE projects(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE assets(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE generation_jobs(conflicting_column TEXT NOT NULL);
      INSERT INTO generation_jobs(conflicting_column) VALUES ('preserve-me');
    `)
    versionOne.close()

    expect(() => runMigrations(databasePath)).toThrow()
    const unchanged = new Database(databasePath, { readonly: true })
    const version = unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    const marker = unchanged.prepare('SELECT conflicting_column FROM generation_jobs').get() as { conflicting_column: string }
    unchanged.close()
    expect(version.version).toBe(1)
    expect(marker.conflicting_column).toBe('preserve-me')
    await expect(stat(join(root, 'project.pre-migration-v1.bak.db'))).resolves.toBeDefined()
  })

  it('upgrades v9 outbound audit rows additively and keeps legacy byte and approval fields unknown', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'version-nine.db')
    const versionNine = new Database(databasePath)
    versionNine.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (9, '2026-09-01T00:00:00.000Z');
      CREATE TABLE generation_jobs(id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE agent_items(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE agent_outbound_context_records (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        manifest_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_id TEXT,
        model TEXT,
        policy TEXT NOT NULL,
        data_types_json TEXT NOT NULL,
        image_asset_ids_json TEXT NOT NULL,
        text_bytes INTEGER NOT NULL,
        image_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_outbound_context_records(
        id, project_id, thread_id, turn_id, manifest_id, tool_call_id, provider_id, model,
        policy, data_types_json, image_asset_ids_json, text_bytes, image_count, status,
        reason, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000009001',
        '00000000-0000-4000-8000-000000009002',
        '00000000-0000-4000-8000-000000009003',
        '00000000-0000-4000-8000-000000009004',
        '00000000-0000-4000-8000-000000009005',
        NULL, 'image-provider', 'image-model', 'minimal', '["user_text"]', '[]', 12, 0,
        'sent', 'legacy row', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `)
    versionNine.close()

    expect(runMigrations(databasePath)).toMatchObject({ fromVersion: 9, toVersion: 15 })
    const migrated = new Database(databasePath, { readonly: true })
    const row = migrated.prepare(`
      SELECT text_bytes, image_count, image_bytes, approval_id, request_correlation_id
      FROM agent_outbound_context_records
    `).get() as Record<string, unknown>
    migrated.close()
    expect(row).toEqual({
      text_bytes: 12,
      image_count: 0,
      image_bytes: null,
      approval_id: null,
      request_correlation_id: null
    })
    await expect(stat(join(root, 'project.pre-migration-v9.bak.db'))).resolves.toBeDefined()
  })

  it('keeps a failed v10 outbound audit migration on v9 with the original rows intact', async () => {
    const root = await makeRoot()
    const databasePath = join(root, 'version-nine-conflict.db')
    const versionNine = new Database(databasePath)
    versionNine.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (9, '2026-09-01T00:00:00.000Z');
      CREATE TABLE agent_items(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE agent_outbound_context_records (
        id TEXT PRIMARY KEY NOT NULL,
        image_bytes INTEGER,
        reason TEXT NOT NULL
      );
      INSERT INTO agent_outbound_context_records(id, image_bytes, reason)
      VALUES ('00000000-0000-4000-8000-000000009901', 77, 'preserve-v9-row');
    `)
    versionNine.close()

    expect(() => runMigrations(databasePath)).toThrow()
    const unchanged = new Database(databasePath, { readonly: true })
    const version = unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    const row = unchanged.prepare('SELECT image_bytes, reason FROM agent_outbound_context_records').get() as Record<string, unknown>
    unchanged.close()
    expect(version.version).toBe(9)
    expect(row).toEqual({ image_bytes: 77, reason: 'preserve-v9-row' })
    await expect(stat(join(root, 'project.pre-migration-v9.bak.db'))).resolves.toBeDefined()
  })

  it('opens a legacy v1 project package, saves a copy, reopens it and recovers after an unclean close', async () => {
    const root = await makeRoot()
    const sourceDirectory = join(root, 'legacy-v1.aicanvas')
    const copyDirectory = join(root, 'legacy-v1-copy.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(sourceDirectory, '旧版作品', { idFactory: ids })
    await created.workspace.close(true)

    const legacy = new Database(join(sourceDirectory, 'project.db'))
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      DROP TABLE project_copy_records;
      DROP TABLE project_work_context;
      DROP TABLE agent_generation_limits;
      DROP TABLE agent_outbound_context_records;
      DROP TABLE generation_result_records;
      DROP TABLE generation_subscriptions;
      DROP TABLE agent_budget_reservations;
      DROP TABLE generation_workflow_intents;
      DROP TABLE agent_context_compactions;
      DROP TABLE agent_context_entries;
      DROP TABLE agent_context_manifests;
      DROP TABLE project_memory_candidates;
      DROP TABLE project_memory_entries;
      DROP TABLE project_directives;
      DROP TABLE agent_project_context_settings;
      DROP TABLE agent_tool_calls_v2;
      DROP TABLE agent_queue_entries;
      DROP TABLE agent_events;
      DROP TABLE agent_items;
      DROP TABLE agent_turns_v2;
      DROP TABLE agent_goals;
      DROP TABLE agent_threads;
      DROP TABLE agent_decisions;
      DROP TABLE agent_activity_events;
      DROP TABLE agent_activities;
      DROP TABLE agent_tool_calls;
      DROP TABLE agent_runs;
      DROP TABLE conversation_messages;
      DROP TABLE conversations;
      DROP TABLE generation_results;
      DROP TABLE generation_jobs;
      DELETE FROM schema_migrations WHERE version > 1;
    `)
    legacy.close()

    const opened = await ProjectWorkspace.open(sourceDirectory, { idFactory: ids })
    expect(opened.workspace.repository.migrationResult).toMatchObject({ fromVersion: 1, toVersion: 15 })
    const session = new ProjectSession(opened.workspace, opened.scene, 1)
    const changed = session.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '更新旧版副本画布',
      commands: [{
        kind: 'scene.set-canvas',
        canvas: { ...opened.scene.canvas, aspectWidth: 3, aspectHeight: 2, outputWidth: 1200, outputHeight: 800 }
      }]
    })
    expect(changed.ok).toBe(true)
    await session.flush()
    const copy = await opened.workspace.saveAs(copyDirectory)
    expect(copy.scene.canvas).toMatchObject({ aspectWidth: 3, aspectHeight: 2, outputWidth: 1200, outputHeight: 800 })
    await copy.workspace.close(false)

    const recovered = await ProjectWorkspace.open(copyDirectory, { idFactory: ids })
    expect(recovered.recovered).toBe(true)
    expect(recovered.scene.canvas).toMatchObject({ aspectWidth: 3, aspectHeight: 2, outputWidth: 1200, outputHeight: 800 })
    await recovered.workspace.close(true)
    await expect(stat(join(sourceDirectory, 'project.db'))).resolves.toBeDefined()
    await expect(stat(join(copyDirectory, 'project.db'))).resolves.toBeDefined()
  })

  it('creates, autosaves, closes and reopens a project without scene drift', async () => {
    const root = await makeRoot()
    const projectDirectory = join(root, 'night-veil.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(projectDirectory, '香水海报', {
      idFactory: ids,
      now: () => '2026-08-10T00:00:00.000Z'
    })
    const session = new ProjectSession(created.workspace, created.scene, 1)
    const result = session.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '创建标题',
      commands: [
        {
          kind: 'element.add',
          element: {
            id: IDS.text,
            version: ELEMENT_SCHEMA_VERSION,
            type: 'text',
            name: '主标题',
            description: '',
            transform: { x: 0.1, y: 0.08, width: 0.8, height: 0.12, rotation: 0 },
            zIndex: 0,
            opacity: 1,
            visible: true,
            locked: false,
            groupId: null,
            semanticRole: 'title',
            referencePolicy: 'include',
            content: 'NIGHT VEIL',
            orientation: 'horizontal',
            align: 'center',
            wrapping: 'none',
            letterSpacing: 18,
            lineHeight: 1.2,
            accuracy: 'strict',
            styleDescription: '银色金属字',
            renderStrategy: 'standard',
            resultAssetId: null
          }
        }
      ]
    })
    expect(result.ok).toBe(true)
    const secondResult = session.execute({
      id: IDS.batch2,
      origin: 'user',
      summary: '调整输出尺寸',
      commands: [
        {
          kind: 'scene.set-canvas',
          canvas: { ...session.commandBus.getScene().canvas, outputWidth: 2048, outputHeight: 2560 }
        }
      ]
    })
    expect(secondResult.ok).toBe(true)
    await session.close(true)

    const reopened = await ProjectWorkspace.open(projectDirectory, {
      idFactory: ids,
      now: () => '2026-08-10T00:00:05.000Z'
    })
    expect(reopened.recovered).toBe(false)
    expect(reopened.scene.elements[0]).toMatchObject({ type: 'text', content: 'NIGHT VEIL' })
    await reopened.workspace.close(true)

    const database = new Database(join(projectDirectory, 'project.db'), { readonly: true })
    const operationCount = database.prepare('SELECT COUNT(*) AS count FROM operation_batches').get() as { count: number }
    database.close()
    expect(operationCount.count).toBe(2)
  })

  it('reconstructs committed undo and redo history after a full project reopen', async () => {
    const root = await makeRoot()
    const projectDirectory = join(root, 'history-restart.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(projectDirectory, '历史恢复', {
      idFactory: ids,
      now: () => '2026-08-24T12:00:00.000Z'
    })
    const first = new SceneService(created.scene, {
      now: () => '2026-08-24T12:00:01.000Z',
      save: (scene, batch, reason) => created.workspace.saveScene(scene, reason, batch)
    })
    const firstMutation = await first.execute({
      expectedSceneRevision: 0,
      batch: {
        id: IDS.batch1,
        origin: 'user',
        summary: '切换横向画布',
        commands: [{
          kind: 'scene.set-canvas',
          canvas: { ...created.scene.canvas, aspectWidth: 3, aspectHeight: 2, outputWidth: 1500, outputHeight: 1000 }
        }]
      }
    })
    expect(firstMutation.ok).toBe(true)
    const secondMutation = await first.execute({
      expectedSceneRevision: 1,
      batch: {
        id: IDS.batch2,
        origin: 'agent',
        summary: '提高输出尺寸',
        commands: [{
          kind: 'scene.set-canvas',
          canvas: { ...first.state().scene.canvas, outputWidth: 2100, outputHeight: 1400 }
        }]
      }
    })
    expect(secondMutation.ok).toBe(true)
    const undone = await first.undo({ expectedSceneRevision: 2, batchId: IDS.batch2 })
    expect(undone.ok).toBe(true)
    await created.workspace.close(true)

    const reopened = await ProjectWorkspace.open(projectDirectory, {
      idFactory: ids,
      now: () => '2026-08-24T12:00:05.000Z'
    })
    expect(reopened.history.undoStack.map((batch) => batch.id)).toEqual([IDS.batch1])
    expect(reopened.history.redoStack.map((batch) => batch.id)).toEqual([IDS.batch2])
    const restored = new SceneService(reopened.scene, {
      history: reopened.history,
      now: () => '2026-08-24T12:00:06.000Z',
      save: (scene, batch, reason) => reopened.workspace.saveScene(scene, reason, batch)
    })
    expect(restored.state()).toMatchObject({ canUndo: true, canRedo: true, scene: { revision: 3 } })

    const redone = await restored.redo({ expectedSceneRevision: 3, batchId: IDS.batch2 })
    expect(redone).toMatchObject({ ok: true, receipt: { state: { scene: { revision: 4, canvas: { outputWidth: 2100 } } } } })
    const undoSecond = await restored.undo({ expectedSceneRevision: 4, batchId: IDS.batch2 })
    expect(undoSecond).toMatchObject({ ok: true, receipt: { state: { scene: { revision: 5, canvas: { outputWidth: 1500 } } } } })
    const undoFirst = await restored.undo({ expectedSceneRevision: 5, batchId: IDS.batch1 })
    expect(undoFirst).toMatchObject({ ok: true, receipt: { state: { scene: { revision: 6, canvas: { aspectWidth: 4, aspectHeight: 5 } } } } })
    await reopened.workspace.close(true)
  })

  it('detects an unclean shutdown and restores the latest committed snapshot', async () => {
    const root = await makeRoot()
    const projectDirectory = join(root, 'recovery.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(projectDirectory, '恢复测试', { idFactory: ids })
    const session = new ProjectSession(created.workspace, created.scene, 1)
    session.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '调整画布',
      commands: [
        {
          kind: 'scene.set-canvas',
          canvas: { ...created.scene.canvas, aspectWidth: 16, aspectHeight: 9, outputWidth: 1600, outputHeight: 900 }
        }
      ]
    })
    await session.close(false)

    const reopened = await ProjectWorkspace.open(projectDirectory, { idFactory: ids })
    expect(reopened.recovered).toBe(true)
    expect(reopened.scene.canvas).toMatchObject({ aspectWidth: 16, aspectHeight: 9, outputWidth: 1600, outputHeight: 900 })
    await reopened.workspace.close(true)
  })

  it('imports immutable assets, deduplicates by hash, creates thumbnails and detects missing files', async () => {
    const root = await makeRoot()
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width: 64, height: 80, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 0.8 } } })
      .png()
      .toFile(sourcePath)
    const ids = idFactory()
    const created = await ProjectWorkspace.create(join(root, 'assets.aicanvas'), '素材测试', { idFactory: ids })

    const first = await created.workspace.assets.importImage({ sourcePath })
    const second = await created.workspace.assets.importImage({ sourcePath })
    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ width: 64, height: 80, format: 'png', hasAlpha: true, status: 'available' })
    await expect(stat(created.workspace.assets.resolveOriginal(first))).resolves.toMatchObject({ size: expect.any(Number) })
    await expect(stat(created.workspace.assets.resolveThumbnail(first))).resolves.toMatchObject({ size: expect.any(Number) })

    await unlink(created.workspace.assets.resolveOriginal(first))
    const missing = await created.workspace.assets.detectMissingAssets()
    expect(missing).toEqual([expect.objectContaining({ id: first.id, status: 'missing' })])

    const relinkSource = join(root, 'relink.png')
    await copyFile(sourcePath, relinkSource)
    const relinked = await created.workspace.assets.importImage({ sourcePath: relinkSource })
    expect(relinked).toMatchObject({ id: first.id, status: 'available' })
    await expect(stat(created.workspace.assets.resolveOriginal(relinked))).resolves.toBeDefined()
    await created.workspace.close(true)
  })

  it('falls back to an older immutable snapshot when the latest snapshot is corrupt', async () => {
    const root = await makeRoot()
    const projectDirectory = join(root, 'snapshot-fallback.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(projectDirectory, '快照回退', { idFactory: ids })
    await created.workspace.close(true)
    const database = new Database(join(projectDirectory, 'project.db'))
    const project = database.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }
    database.prepare(`
      INSERT INTO scene_snapshots(id, project_id, scene_revision, scene_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ids(), project.id, 999, '{broken-json', 'autosave', '2099-01-01T00:00:00.000Z')
    database.close()

    const reopened = await ProjectWorkspace.open(projectDirectory, { idFactory: ids })
    expect(reopened.recoveredFromOlderSnapshot).toBe(true)
    expect(reopened.scene.revision).toBe(0)
    await reopened.workspace.close(true)
  })

  it('save-as creates an independent project copy and switches to it', async () => {
    const root = await makeRoot()
    const sourceDirectory = join(root, 'source.aicanvas')
    const targetDirectory = join(root, 'copy.aicanvas')
    const ids = idFactory()
    const created = await ProjectWorkspace.create(sourceDirectory, '源项目', { idFactory: ids })
    const copy = await created.workspace.saveAs(targetDirectory)

    expect(copy.workspace.directory).toBe(targetDirectory)
    expect((await copy.workspace.repository.getProject()).projectPath).toBe(targetDirectory)
    await expect(stat(join(sourceDirectory, 'project.db'))).resolves.toBeDefined()
    await expect(stat(join(targetDirectory, 'project.db'))).resolves.toBeDefined()
    await copy.workspace.close(true)
  })

  it('keeps image bytes out of the database', async () => {
    const root = await makeRoot()
    const sourcePath = join(root, 'source.webp')
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#416FBB' } }).webp().toFile(sourcePath)
    const created = await ProjectWorkspace.create(join(root, 'binary-boundary.aicanvas'), '二进制边界', { idFactory: idFactory() })
    const asset = await created.workspace.assets.importImage({ sourcePath })
    await created.workspace.close(true)

    const databaseBytes = await readFile(join(root, 'binary-boundary.aicanvas', 'project.db'))
    const originalBytes = await readFile(join(root, 'binary-boundary.aicanvas', asset.relativePath))
    expect(databaseBytes.includes(originalBytes)).toBe(false)
    expect(asset.relativePath).not.toContain('source.webp')
  })
})
