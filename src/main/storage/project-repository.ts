import { randomUUID } from 'node:crypto'
import type { OperationBatch } from '../../domain'
import {
  deserializeSceneSnapshot,
  SCENE_SCHEMA_VERSION,
  serializeSceneSnapshot,
  type Scene
} from '../../domain'
import { operationBatchSchema } from '../../shared/scene-authority'
import { projectWorkContextSchema, type ProjectWorkContext } from '../../shared/project-work-context'
import { reidentifyProjectCopy, type ProjectCopyManifest } from './project-copy'
import { openDatabase, executeSynchronous, type AssetRow, type DatabaseConnection, type ProjectRow } from './database'

export type SnapshotReason = 'initial' | 'explicit' | 'autosave' | 'recovery' | 'undo' | 'redo'

export interface ProjectMetadata {
  readonly id: string
  readonly name: string
  readonly projectPath: string
  readonly schemaVersion: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastOpenedAt: string
  readonly cleanShutdown: boolean
}

export interface LoadedScene {
  readonly scene: Scene
  readonly snapshotId: string
  readonly latestSnapshotWasValid: boolean
}

export interface LoadedSceneHistory {
  readonly undoStack: readonly OperationBatch[]
  readonly redoStack: readonly OperationBatch[]
}

export interface AssetMetadata {
  readonly id: string
  readonly projectId: string
  readonly relativePath: string
  readonly thumbnailRelativePath: string
  readonly contentHash: string
  readonly width: number
  readonly height: number
  readonly format: 'png' | 'jpeg' | 'webp'
  readonly hasAlpha: boolean
  readonly sourceType: 'imported' | 'generated' | 'reference'
  readonly sourceId: string | null
  readonly status: 'available' | 'missing'
  readonly createdAt: string
}

function mapProject(row: ProjectRow): ProjectMetadata {
  return {
    id: row.id,
    name: row.name,
    projectPath: row.project_path,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    cleanShutdown: row.clean_shutdown === 1
  }
}

function mapAsset(row: AssetRow): AssetMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    thumbnailRelativePath: row.thumbnail_relative_path,
    contentHash: row.content_hash,
    width: row.width,
    height: row.height,
    format: row.format,
    hasAlpha: row.has_alpha === 1,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    createdAt: row.created_at
  }
}

export class ProjectRepository {
  readonly #connection: DatabaseConnection
  readonly #idFactory: () => string

  constructor(databasePath: string, idFactory: () => string = randomUUID) {
    this.#connection = openDatabase(databasePath)
    this.#idFactory = idFactory
  }

  get migrationResult(): DatabaseConnection['migration'] {
    return this.#connection.migration
  }

  reidentifyCopy(projectId: string, path: string, name: string, copiedAt: string): ProjectCopyManifest {
    return reidentifyProjectCopy(this.#connection.sqlite, projectId, path, name, copiedAt)
  }

  getWorkContext(projectId: string): ProjectWorkContext | null {
    const row = this.#connection.sqlite.prepare('SELECT context_json FROM project_work_context WHERE project_id = ?')
      .get(projectId) as { context_json: string } | undefined
    if (row === undefined) return null
    const context = projectWorkContextSchema.parse(JSON.parse(row.context_json))
    if (context.projectId !== projectId) throw new Error('工作上下文的作品身份不匹配。')
    return context
  }

  saveWorkContext(context: ProjectWorkContext): void {
    const parsed = projectWorkContextSchema.parse(context)
    // Preserve unknown/corrupted context bytes instead of replacing them with
    // defaults. Scene and localized results remain readable independently.
    this.getWorkContext(parsed.projectId)
    this.#connection.sqlite.prepare(`INSERT INTO project_work_context(project_id, context_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET context_json = excluded.context_json, updated_at = excluded.updated_at`)
      .run(parsed.projectId, JSON.stringify(parsed), new Date().toISOString())
  }

  async initialize(metadata: ProjectMetadata, scene: Scene): Promise<void> {
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction
        .insertInto('projects')
        .values({
          id: metadata.id,
          name: metadata.name,
          project_path: metadata.projectPath,
          schema_version: SCENE_SCHEMA_VERSION,
          created_at: metadata.createdAt,
          updated_at: metadata.updatedAt,
          last_opened_at: metadata.lastOpenedAt,
          clean_shutdown: 0
        })
        )
      executeSynchronous(this.#connection, transaction
        .insertInto('scene_snapshots')
        .values({
          id: this.#idFactory(),
          project_id: metadata.id,
          scene_revision: scene.revision,
          scene_json: serializeSceneSnapshot(scene),
          reason: 'initial',
          created_at: metadata.createdAt
        })
        )
    })()
  }

  async getProject(): Promise<ProjectMetadata> {
    const row = await this.#connection.kysely.selectFrom('projects').selectAll().executeTakeFirst()
    if (row === undefined) throw new Error('Project metadata is missing.')
    return mapProject(row)
  }

  async markSessionStarted(now: string): Promise<boolean> {
    const project = await this.getProject()
    await this.#connection.kysely
      .updateTable('projects')
      .set({ clean_shutdown: 0, last_opened_at: now, updated_at: now })
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
    return !project.cleanShutdown
  }

  async markSessionClosed(now: string): Promise<void> {
    const project = await this.getProject()
    await this.#connection.kysely
      .updateTable('projects')
      .set({ clean_shutdown: 1, updated_at: now })
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
  }

  async updateProjectPath(projectPath: string, now: string): Promise<void> {
    const project = await this.getProject()
    await this.#connection.kysely
      .updateTable('projects')
      .set({ project_path: projectPath, updated_at: now })
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
  }

  async updateProjectName(name: string, now: string): Promise<void> {
    const project = await this.getProject()
    await this.#connection.kysely
      .updateTable('projects')
      .set({ name: name.trim() || project.name, updated_at: now })
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
  }

  async saveScene(scene: Scene, reason: SnapshotReason, batch: OperationBatch | null, now: string): Promise<string> {
    const project = await this.getProject()
    const snapshotId = this.#idFactory()
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      if (batch !== null) {
        executeSynchronous(this.#connection, transaction
          .insertInto('operation_batches')
          .values({
            id: batch.id,
            project_id: project.id,
            origin: batch.origin,
            summary: batch.summary,
            revision_before: batch.revisionBefore,
            revision_after: batch.revisionAfter,
            patches_json: JSON.stringify(batch.patches),
            inverse_patches_json: JSON.stringify(batch.inversePatches),
            committed_at: batch.committedAt
          })
          )
      }
      executeSynchronous(this.#connection, transaction
        .insertInto('scene_snapshots')
        .values({
          id: snapshotId,
          project_id: project.id,
          scene_revision: scene.revision,
          scene_json: serializeSceneSnapshot(scene),
          reason,
          created_at: now
        })
        )
      executeSynchronous(this.#connection, transaction
        .updateTable('projects')
        .set({ updated_at: now, schema_version: scene.schemaVersion })
        .where('id', '=', project.id)
        )
    })()
    return snapshotId
  }

  async loadLatestValidScene(): Promise<LoadedScene> {
    const rows = await this.#connection.kysely
      .selectFrom('scene_snapshots')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('scene_revision', 'desc')
      .execute()
    for (const [index, row] of rows.entries()) {
      try {
        return {
          scene: deserializeSceneSnapshot(row.scene_json),
          snapshotId: row.id,
          latestSnapshotWasValid: index === 0
        }
      } catch {
        // Try the next immutable snapshot; the invalid row remains for diagnostics.
      }
    }
    throw new Error('No valid scene snapshot is available for recovery.')
  }

  async loadSceneHistory(snapshotId: string, historyLimit = 200, strict = false): Promise<LoadedSceneHistory> {
    const project = await this.getProject()
    const snapshots = this.#connection.sqlite.prepare(`
      SELECT id, scene_revision AS sceneRevision, reason
      FROM scene_snapshots
      WHERE project_id = ?
      ORDER BY rowid ASC
    `).all(project.id) as Array<{
      id: string
      sceneRevision: number
      reason: SnapshotReason
    }>
    const targetIndex = snapshots.findIndex((snapshot) => snapshot.id === snapshotId)
    if (targetIndex < 0) { if (strict) throw new Error('副本缺少历史基准。'); return { undoStack: [], redoStack: [] } }

    const rows = this.#connection.sqlite.prepare(`
      SELECT id, origin, summary, committed_at AS committedAt,
             revision_before AS revisionBefore, revision_after AS revisionAfter,
             patches_json AS patchesJson, inverse_patches_json AS inversePatchesJson
      FROM operation_batches
      WHERE project_id = ?
      ORDER BY rowid ASC
    `).all(project.id) as Array<{
      id: string
      origin: OperationBatch['origin']
      summary: string
      committedAt: string
      revisionBefore: number
      revisionAfter: number
      patchesJson: string
      inversePatchesJson: string
    }>

    try {
      const batches = rows.map((row) => operationBatchSchema.parse({
        id: row.id,
        origin: row.origin,
        summary: row.summary,
        committedAt: row.committedAt,
        revisionBefore: row.revisionBefore,
        revisionAfter: row.revisionAfter,
        patches: JSON.parse(row.patchesJson),
        inversePatches: JSON.parse(row.inversePatchesJson)
      }))
      const batchByRevision = new Map(batches.map((batch) => [batch.revisionAfter, batch]))
      const undoStack: OperationBatch[] = []
      const redoStack: OperationBatch[] = []

      for (const snapshot of snapshots.slice(0, targetIndex + 1)) {
        if (snapshot.reason === 'initial') {
          undoStack.length = 0
          redoStack.length = 0
          continue
        }
        if (snapshot.reason === 'undo') {
          const batch = undoStack.pop()
          if (batch === undefined) { if (strict) throw new Error('副本撤销历史不完整。'); return { undoStack: [], redoStack: [] } }
          redoStack.push(batch)
          continue
        }
        if (snapshot.reason === 'redo') {
          const batch = redoStack.pop()
          if (batch === undefined) { if (strict) throw new Error('副本重做历史不完整。'); return { undoStack: [], redoStack: [] } }
          undoStack.push(batch)
          continue
        }
        const batch = batchByRevision.get(snapshot.sceneRevision)
        if (batch !== undefined) {
          undoStack.push(batch)
          redoStack.length = 0
        }
      }

      return {
        undoStack: undoStack.slice(-historyLimit),
        redoStack: redoStack.slice(-historyLimit)
      }
    } catch (error) {
      // A damaged audit batch must never prevent the latest valid Scene from opening.
      if (strict) throw error
      return { undoStack: [], redoStack: [] }
    }
  }

  async findAssetByHash(projectId: string, contentHash: string): Promise<AssetMetadata | null> {
    const row = await this.#connection.kysely
      .selectFrom('assets')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('content_hash', '=', contentHash)
      .executeTakeFirst()
    return row === undefined ? null : mapAsset(row)
  }

  async insertAsset(asset: AssetMetadata): Promise<void> {
    await this.#connection.kysely
      .insertInto('assets')
      .values({
        id: asset.id,
        project_id: asset.projectId,
        relative_path: asset.relativePath,
        thumbnail_relative_path: asset.thumbnailRelativePath,
        content_hash: asset.contentHash,
        width: asset.width,
        height: asset.height,
        format: asset.format,
        has_alpha: asset.hasAlpha ? 1 : 0,
        source_type: asset.sourceType,
        source_id: asset.sourceId,
        status: asset.status,
        created_at: asset.createdAt
      })
      .executeTakeFirstOrThrow()
  }

  async listAssets(): Promise<readonly AssetMetadata[]> {
    const rows = await this.#connection.kysely
      .selectFrom('assets')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map(mapAsset)
  }

  async updateAssetStatus(assetId: string, status: AssetMetadata['status']): Promise<void> {
    await this.#connection.kysely
      .updateTable('assets')
      .set({ status })
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow()
  }

  async backupTo(destinationDatabasePath: string): Promise<void> {
    this.#connection.sqlite.pragma('wal_checkpoint(FULL)')
    await this.#connection.sqlite.backup(destinationDatabasePath)
  }

  async close(): Promise<void> {
    await this.#connection.kysely.destroy()
  }
}
