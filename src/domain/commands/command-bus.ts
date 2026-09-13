import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { ZodError } from 'zod'
import { sceneSchema, type Scene } from '../scene/schema'
import { applySceneCommand } from './apply-command'
import { CommandDomainError, type CommandErrorDetail } from './errors'
import { commandBatchInputSchema, type CommandBatchInput } from './schema'

enablePatches()

export interface OperationBatch {
  readonly id: string
  readonly origin: 'user' | 'agent' | 'system'
  readonly summary: string
  readonly committedAt: string
  readonly revisionBefore: number
  readonly revisionAfter: number
  readonly patches: readonly Patch[]
  readonly inversePatches: readonly Patch[]
}

export type CommandExecutionResult =
  | { readonly ok: true; readonly scene: Scene; readonly batch: OperationBatch }
  | { readonly ok: false; readonly scene: Scene; readonly error: CommandErrorDetail }

export interface CommandBusOptions {
  readonly now?: () => string
  readonly historyLimit?: number
}

export interface CommandBusCheckpoint {
  readonly scene: Scene
  readonly undoStack: readonly OperationBatch[]
  readonly redoStack: readonly OperationBatch[]
}

function toCommandError(error: unknown): CommandErrorDetail {
  if (error instanceof CommandDomainError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues === undefined ? {} : { issues: error.issues })
    }
  }
  if (error instanceof ZodError) {
    return {
      code: 'INVALID_BATCH',
      message: 'Command batch failed schema validation.',
      issues: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    }
  }
  return { code: 'INVALID_SCENE', message: 'Command batch would produce an invalid scene.' }
}

export class CommandBus {
  #scene: Scene
  readonly #undoStack: OperationBatch[] = []
  readonly #redoStack: OperationBatch[] = []
  readonly #now: () => string
  readonly #historyLimit: number

  constructor(scene: Scene, options: CommandBusOptions = {}) {
    this.#scene = sceneSchema.parse(scene)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#historyLimit = options.historyLimit ?? 200
  }

  getScene(): Scene {
    return this.#scene
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0
  }

  get undoDepth(): number {
    return this.#undoStack.length
  }

  get redoDepth(): number {
    return this.#redoStack.length
  }

  checkpoint(): CommandBusCheckpoint {
    return {
      scene: this.#scene,
      undoStack: [...this.#undoStack],
      redoStack: [...this.#redoStack]
    }
  }

  restore(checkpoint: CommandBusCheckpoint): void {
    this.#scene = sceneSchema.parse(checkpoint.scene)
    this.#undoStack.splice(0, this.#undoStack.length, ...checkpoint.undoStack)
    this.#redoStack.splice(0, this.#redoStack.length, ...checkpoint.redoStack)
  }

  execute(input: CommandBatchInput | unknown): CommandExecutionResult {
    try {
      const batchInput = commandBatchInputSchema.parse(input)
      const revisionBefore = this.#scene.revision
      const committedAt = this.#now()
      const [contentScene, patches, inversePatches] = produceWithPatches(this.#scene, (draft) => {
        for (const command of batchInput.commands) applySceneCommand(draft, command)
      })
      const nextScene = sceneSchema.parse({
        ...contentScene,
        revision: revisionBefore + 1,
        updatedAt: committedAt
      })
      const batch: OperationBatch = {
        id: batchInput.id,
        origin: batchInput.origin,
        summary: batchInput.summary,
        committedAt,
        revisionBefore,
        revisionAfter: nextScene.revision,
        patches,
        inversePatches
      }

      this.#scene = nextScene
      this.#undoStack.push(batch)
      if (this.#undoStack.length > this.#historyLimit) this.#undoStack.shift()
      this.#redoStack.length = 0
      return { ok: true, scene: this.#scene, batch }
    } catch (error) {
      return { ok: false, scene: this.#scene, error: toCommandError(error) }
    }
  }

  undo(): OperationBatch | null {
    const batch = this.#undoStack.pop()
    if (batch === undefined) return null
    const reverted = applyPatches(this.#scene, batch.inversePatches)
    this.#scene = sceneSchema.parse({
      ...reverted,
      revision: this.#scene.revision + 1,
      updatedAt: this.#now()
    })
    this.#redoStack.push(batch)
    return batch
  }

  redo(): OperationBatch | null {
    const batch = this.#redoStack.pop()
    if (batch === undefined) return null
    const restored = applyPatches(this.#scene, batch.patches)
    this.#scene = sceneSchema.parse({
      ...restored,
      revision: this.#scene.revision + 1,
      updatedAt: this.#now()
    })
    this.#undoStack.push(batch)
    return batch
  }
}
