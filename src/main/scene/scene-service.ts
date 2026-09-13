import { CommandBus, type CommandBusCheckpoint, type OperationBatch, type Scene } from '../../domain'
import {
  sceneChangedEventSchema,
  sceneExecuteInputSchema,
  sceneHistoryInputSchema,
  sceneMutationResultSchema,
  operationBatchSchema,
  type SceneAuthorityError,
  type SceneAuthorityState,
  type SceneChangedEvent,
  type SceneExecuteInput,
  type SceneHistoryInput,
  type SceneMutationReceipt,
  type SceneMutationResult
} from '../../shared/scene-authority'
import type { SnapshotReason } from '../storage/project-repository'

export interface SceneServiceOptions {
  readonly save: (scene: Scene, batch: OperationBatch | null, reason: SnapshotReason) => Promise<unknown>
  readonly afterCommit?: (event: SceneChangedEvent) => Promise<void> | void
  readonly now?: () => string
  readonly historyLimit?: number
  readonly history?: Pick<CommandBusCheckpoint, 'undoStack' | 'redoStack'>
}

type SceneListener = (event: SceneChangedEvent) => void

function authorityError(
  code: SceneAuthorityError['code'],
  message: string,
  recoverable = true
): SceneAuthorityError {
  return { code, message, recoverable }
}

export class SceneService {
  #bus: CommandBus
  readonly #save: SceneServiceOptions['save']
  readonly #afterCommit: SceneServiceOptions['afterCommit']
  readonly #listeners = new Set<SceneListener>()
  #sequence = 0
  #mutationChain: Promise<void> = Promise.resolve()

  constructor(scene: Scene, options: SceneServiceOptions) {
    this.#bus = new CommandBus(scene, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit })
    })
    if (options.history !== undefined) {
      this.#bus.restore({ scene, undoStack: options.history.undoStack, redoStack: options.history.redoStack })
    }
    this.#save = options.save
    this.#afterCommit = options.afterCommit
  }

  state(): SceneAuthorityState {
    return {
      scene: this.#bus.getScene(),
      sequence: this.#sequence,
      canUndo: this.#bus.canUndo,
      canRedo: this.#bus.canRedo
    }
  }

  subscribe(listener: SceneListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  execute(input: SceneExecuteInput | unknown, signal?: AbortSignal): Promise<SceneMutationResult> {
    return this.#enqueue(async () => {
      signal?.throwIfAborted()
      const parsed = sceneExecuteInputSchema.parse(input)
      const stale = this.#rejectStale(parsed.expectedSceneRevision)
      if (stale !== null) return stale
      const checkpoint = this.#bus.checkpoint()
      const executed = this.#bus.execute(parsed.batch)
      if (!executed.ok) {
        return this.#failure(authorityError('SCENE_COMMAND_REJECTED', executed.error.message, true))
      }
      return this.#persistMutation(checkpoint, {
        action: 'execute',
        batch: operationBatchSchema.parse(executed.batch),
        affectedBatchId: executed.batch.id
      }, 'autosave', parsed.batch.origin)
    })
  }

  undo(input: SceneHistoryInput | unknown, signal?: AbortSignal): Promise<SceneMutationResult> {
    return this.#enqueue(async () => {
      signal?.throwIfAborted()
      const parsed = sceneHistoryInputSchema.parse(input)
      const stale = this.#rejectStale(parsed.expectedSceneRevision)
      if (stale !== null) return stale
      const checkpoint = this.#bus.checkpoint()
      const latest = checkpoint.undoStack.at(-1)
      if (latest === undefined) {
        return this.#failure(authorityError('SCENE_HISTORY_EMPTY', 'There is no committed scene batch to undo.'))
      }
      if (parsed.batchId !== null && latest.id !== parsed.batchId) {
        return this.#failure(authorityError(
          'SCENE_BATCH_NOT_LATEST',
          `Batch ${parsed.batchId} is not the latest reversible scene batch.`
        ))
      }
      const batch = this.#bus.undo()
      if (batch === null) return this.#failure(authorityError('SCENE_HISTORY_EMPTY', 'There is no committed scene batch to undo.'))
      return this.#persistMutation(checkpoint, {
        action: 'undo',
        batch: null,
        affectedBatchId: batch.id
      }, 'undo', 'undo')
    })
  }

  redo(input: SceneHistoryInput | unknown): Promise<SceneMutationResult> {
    return this.#enqueue(async () => {
      const parsed = sceneHistoryInputSchema.parse(input)
      const stale = this.#rejectStale(parsed.expectedSceneRevision)
      if (stale !== null) return stale
      const checkpoint = this.#bus.checkpoint()
      const latest = checkpoint.redoStack.at(-1)
      if (latest === undefined) {
        return this.#failure(authorityError('SCENE_HISTORY_EMPTY', 'There is no reverted scene batch to redo.'))
      }
      if (parsed.batchId !== null && latest.id !== parsed.batchId) {
        return this.#failure(authorityError(
          'SCENE_BATCH_NOT_LATEST',
          `Batch ${parsed.batchId} is not the latest redo candidate.`
        ))
      }
      const batch = this.#bus.redo()
      if (batch === null) return this.#failure(authorityError('SCENE_HISTORY_EMPTY', 'There is no reverted scene batch to redo.'))
      return this.#persistMutation(checkpoint, {
        action: 'redo',
        batch: null,
        affectedBatchId: batch.id
      }, 'redo', 'redo')
    })
  }

  async flush(): Promise<void> {
    await this.#mutationChain
  }

  #rejectStale(expectedSceneRevision: number): SceneMutationResult | null {
    const current = this.#bus.getScene().revision
    if (current === expectedSceneRevision) return null
    return this.#failure(authorityError(
      'SCENE_REVISION_STALE',
      `The scene changed from revision ${expectedSceneRevision} to ${current}; refresh the projection and re-plan.`,
      true
    ))
  }

  #failure(error: SceneAuthorityError): SceneMutationResult {
    return sceneMutationResultSchema.parse({ ok: false, state: this.state(), error })
  }

  async #persistMutation(
    checkpoint: CommandBusCheckpoint,
    mutation: Omit<SceneMutationReceipt, 'state'>,
    snapshotReason: SnapshotReason,
    eventReason: SceneChangedEvent['reason']
  ): Promise<SceneMutationResult> {
    const scene = this.#bus.getScene()
    try {
      await this.#save(scene, mutation.batch, snapshotReason)
    } catch (error) {
      this.#bus.restore(checkpoint)
      const message = error instanceof Error ? error.message : 'The authoritative scene could not be persisted.'
      return this.#failure(authorityError('SCENE_PERSIST_FAILED', message, true))
    }
    this.#sequence += 1
    const receipt = {
      ...mutation,
      state: this.state()
    }
    const event = sceneChangedEventSchema.parse({
      ...receipt,
      projectId: scene.projectId,
      reason: eventReason
    })
    try {
      await this.#afterCommit?.(event)
    } catch {
      // Projection/index maintenance must never roll back an already durable Scene commit.
    }
    for (const listener of this.#listeners) listener(event)
    return sceneMutationResultSchema.parse({ ok: true, receipt })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation, operation)
    this.#mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}
