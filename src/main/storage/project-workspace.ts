import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { CommandBus, createScene, SCENE_SCHEMA_VERSION, type OperationBatch, type Scene } from '../../domain'
import { AssetStore } from './asset-store'
import { ProjectRepository, type LoadedSceneHistory, type ProjectMetadata, type SnapshotReason } from './project-repository'

const PROJECT_DATABASE = 'project.db'

export interface OpenProjectResult {
  readonly workspace: ProjectWorkspace
  readonly scene: Scene
  readonly history: LoadedSceneHistory
  readonly recovered: boolean
  readonly recoveredFromOlderSnapshot: boolean
}

export interface ProjectWorkspaceOptions {
  readonly idFactory?: () => string
  readonly now?: () => string
}

async function assertAvailableDirectory(targetDirectory: string): Promise<void> {
  try {
    const existing = await stat(targetDirectory)
    if (!existing.isDirectory()) throw new Error('Project target exists and is not a directory.')
    const entries = await readdir(targetDirectory)
    if (entries.length > 0) throw new Error('Project target directory must be empty.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class ProjectWorkspace {
  readonly directory: string
  readonly metadata: ProjectMetadata
  readonly repository: ProjectRepository
  readonly assets: AssetStore
  readonly #now: () => string
  readonly #idFactory: () => string

  private constructor(
    directory: string,
    metadata: ProjectMetadata,
    repository: ProjectRepository,
    options: ProjectWorkspaceOptions
  ) {
    this.directory = directory
    this.metadata = metadata
    this.repository = repository
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    this.assets = new AssetStore(directory, metadata.id, repository, {
      idFactory: this.#idFactory,
      now: this.#now
    })
  }

  static async create(directory: string, name: string, options: ProjectWorkspaceOptions = {}): Promise<OpenProjectResult> {
    const absoluteDirectory = resolve(directory)
    await assertAvailableDirectory(absoluteDirectory)
    await mkdir(join(absoluteDirectory, 'assets', 'original'), { recursive: true })
    await mkdir(join(absoluteDirectory, 'assets', 'thumbnails'), { recursive: true })
    const now = options.now?.() ?? new Date().toISOString()
    const idFactory = options.idFactory ?? randomUUID
    const projectId = idFactory()
    const scene = createScene({ id: idFactory(), projectId, now })
    const repository = new ProjectRepository(join(absoluteDirectory, PROJECT_DATABASE), idFactory)
    const metadata: ProjectMetadata = {
      id: projectId,
      name: name.trim() || basename(absoluteDirectory),
      projectPath: absoluteDirectory,
      schemaVersion: scene.schemaVersion,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      cleanShutdown: false
    }
    await repository.initialize(metadata, scene)
    const workspace = new ProjectWorkspace(absoluteDirectory, metadata, repository, options)
    return {
      workspace,
      scene,
      history: { undoStack: [], redoStack: [] },
      recovered: false,
      recoveredFromOlderSnapshot: false
    }
  }

  static async open(directory: string, options: ProjectWorkspaceOptions = {}): Promise<OpenProjectResult> {
    const absoluteDirectory = resolve(directory)
    const repository = new ProjectRepository(join(absoluteDirectory, PROJECT_DATABASE), options.idFactory)
    const now = options.now?.() ?? new Date().toISOString()
    const metadata = await repository.getProject()
    if (metadata.schemaVersion > SCENE_SCHEMA_VERSION) {
      await repository.close()
      throw new Error(`Project scene version ${metadata.schemaVersion} is newer than supported version ${SCENE_SCHEMA_VERSION}.`)
    }
    const recovered = await repository.markSessionStarted(now)
    if (metadata.projectPath !== absoluteDirectory) await repository.updateProjectPath(absoluteDirectory, now)
    let loaded: Awaited<ReturnType<ProjectRepository['loadLatestValidScene']>>
    try {
      loaded = await repository.loadLatestValidScene()
    } catch (error) {
      await repository.close()
      throw error
    }
    const workspace = new ProjectWorkspace(
      absoluteDirectory,
      { ...metadata, projectPath: absoluteDirectory, lastOpenedAt: now, cleanShutdown: false },
      repository,
      options
    )
    return {
      workspace,
      scene: loaded.scene,
      history: await repository.loadSceneHistory(loaded.snapshotId),
      recovered,
      recoveredFromOlderSnapshot: !loaded.latestSnapshotWasValid
    }
  }

  async saveScene(scene: Scene, reason: SnapshotReason = 'explicit', batch: OperationBatch | null = null): Promise<string> {
    return this.repository.saveScene(scene, reason, batch, this.#now())
  }

  async saveAs(targetDirectory: string): Promise<OpenProjectResult> {
    const absoluteTarget = resolve(targetDirectory)
    if (absoluteTarget.toLowerCase() === this.directory.toLowerCase()
      || absoluteTarget.toLowerCase().startsWith(`${this.directory.toLowerCase()}${sep}`)) throw new Error('副本目录不能位于源项目内部。')
    await assertAvailableDirectory(absoluteTarget)
    const temporaryTarget = join(dirname(absoluteTarget), `.${basename(absoluteTarget)}.saving-${this.#idFactory()}`)
    const parent = resolve(dirname(absoluteTarget))
    if (!resolve(temporaryTarget).toLowerCase().startsWith(`${parent.toLowerCase()}${sep}`)) throw new Error('副本暂存目录越界。')
    await mkdir(parent, { recursive: true })
    await mkdir(temporaryTarget)
    let published = false
    let targetRepository: ProjectRepository | null = null
    try {
      await this.repository.markSessionClosed(this.#now())
      await this.repository.backupTo(join(temporaryTarget, PROJECT_DATABASE))
      await cp(join(this.directory, 'assets'), join(temporaryTarget, 'assets'), { recursive: true })
      targetRepository = new ProjectRepository(join(temporaryTarget, PROJECT_DATABASE), this.#idFactory)
      const projectId = this.#idFactory()
      targetRepository.reidentifyCopy(projectId, absoluteTarget, basename(absoluteTarget).replace(/\.aicanvas$/i, ''), this.#now())
      const latest = await targetRepository.loadLatestValidScene()
      await targetRepository.loadSceneHistory(latest.snapshotId, 200, true)
      const targetAssets = new AssetStore(temporaryTarget, projectId, targetRepository)
      const containedBytes = async (directory: string, path: string): Promise<Buffer> => {
        const actual = await realpath(path)
        const root = await realpath(directory)
        if (!actual.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) throw new Error('副本素材引用超出了项目目录。')
        return readFile(actual)
      }
      for (const asset of await targetRepository.listAssets()) {
        if (asset.status !== 'available') continue
        const original = await containedBytes(temporaryTarget, targetAssets.resolveOriginal(asset))
        if (createHash('sha256').update(original).digest('hex') !== asset.contentHash) throw new Error('副本素材校验失败，原项目保持可用。')
        const sourceThumbnail = await containedBytes(this.directory, this.assets.resolveThumbnail(asset))
        const targetThumbnail = await containedBytes(temporaryTarget, targetAssets.resolveThumbnail(asset))
        if (!sourceThumbnail.equals(targetThumbnail)) throw new Error('副本预览图校验失败。')
      }
      await targetRepository.close()
      targetRepository = null
      await rename(temporaryTarget, absoluteTarget)
      published = true
      const opened = await ProjectWorkspace.open(absoluteTarget, { idFactory: this.#idFactory, now: this.#now })
      await this.repository.close()
      return opened
    } catch (error) {
      await targetRepository?.close().catch(() => undefined)
      const taskOwnedTarget = published ? absoluteTarget : temporaryTarget
      if (!resolve(taskOwnedTarget).toLowerCase().startsWith(`${parent.toLowerCase()}${sep}`)) throw new Error('副本回退目录越界。', { cause: error })
      await rm(taskOwnedTarget, { recursive: true, force: true })
      await this.repository.markSessionStarted(this.#now()).catch(() => undefined)
      throw error
    }
  }

  async close(cleanShutdown = true): Promise<void> {
    if (cleanShutdown) await this.repository.markSessionClosed(this.#now())
    await this.repository.close()
  }
}

export class ProjectSession {
  readonly commandBus: CommandBus
  readonly #workspace: ProjectWorkspace
  readonly #autosave: AutosaveCoordinator

  constructor(workspace: ProjectWorkspace, scene: Scene, delayMs = 250) {
    this.#workspace = workspace
    this.commandBus = new CommandBus(scene)
    this.#autosave = new AutosaveCoordinator(
      (nextScene, batch, reason) => workspace.saveScene(nextScene, reason, batch),
      delayMs
    )
  }

  execute(input: Parameters<CommandBus['execute']>[0]): ReturnType<CommandBus['execute']> {
    const result = this.commandBus.execute(input)
    if (result.ok) this.#autosave.schedule(result.scene, result.batch, 'autosave')
    return result
  }

  undo(): OperationBatch | null {
    const batch = this.commandBus.undo()
    if (batch !== null) this.#autosave.schedule(this.commandBus.getScene(), null, 'undo')
    return batch
  }

  redo(): OperationBatch | null {
    const batch = this.commandBus.redo()
    if (batch !== null) this.#autosave.schedule(this.commandBus.getScene(), null, 'redo')
    return batch
  }

  async flush(): Promise<void> {
    await this.#autosave.flush()
  }

  async close(cleanShutdown = true): Promise<void> {
    await this.flush()
    await this.#workspace.close(cleanShutdown)
  }
}

type SaveScene = (scene: Scene, batch: OperationBatch | null, reason: SnapshotReason) => Promise<unknown>

export class AutosaveCoordinator {
  readonly #save: SaveScene
  readonly #delayMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #pending: Array<{
    readonly scene: Scene
    readonly batch: OperationBatch | null
    readonly reason: SnapshotReason
  }> = []
  #flushPromise: Promise<void> | null = null

  constructor(save: SaveScene, delayMs = 250) {
    this.#save = save
    this.#delayMs = delayMs
  }

  schedule(scene: Scene, batch: OperationBatch | null, reason: SnapshotReason): void {
    this.#pending.push({ scene, batch, reason })
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#delayMs)
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#flushPromise !== null) return this.#flushPromise
    this.#flushPromise = (async () => {
      while (this.#pending.length > 0) {
        const pending = this.#pending[0]
        if (pending === undefined) return
        await this.#save(pending.scene, pending.batch, pending.reason)
        this.#pending.shift()
      }
    })()
    try {
      await this.#flushPromise
    } finally {
      this.#flushPromise = null
    }
  }
}
