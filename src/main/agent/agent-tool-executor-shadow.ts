import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CommandBus,
  commandBatchInputSchema,
  sceneSchema,
  type OperationBatch,
  type Scene,
  type SceneCommand
} from '../../domain'
import { agentToolOutcomeSchema } from '../../shared/agent'
import type { AgentMode } from '../../shared/agent-harness'
import type { SceneMutationResult } from '../../shared/scene-authority'
import {
  agentPermissionProfileSchema,
  agentSceneExecutionGrantSchema,
  agentSceneToolCommitReceiptSchema,
  agentSceneToolPreviewSchema,
  sceneApplyBatchToolInputSchema,
  type AgentPermissionProfile,
  type AgentSceneToolCommitReceipt,
  type AgentSceneToolPrepareResult,
  type AgentToolScope,
  type SceneApplyBatchToolInput
} from '../../shared/agent-tools'
import type { AgentToolCallRecord, AgentToolCallRepository, StoredToolPreview } from './agent-tool-call-repository'
import { AgentToolPolicy, ownerFullPermissionProfile } from './agent-tool-policy'
import { STATIC_AGENT_TOOL_REGISTRY } from './agent-tool-registry'
import type { AgentToolRegistry } from './agent-tool-registry'

export type AgentToolExecutorErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_NOT_AVAILABLE'
  | 'TOOL_IDEMPOTENCY_CONFLICT'
  | 'TOOL_PERMISSION_DENIED'
  | 'TOOL_APPROVAL_REQUIRED'
  | 'TOOL_SCOPE_DENIED'
  | 'SCENE_REVISION_STALE'
  | 'SCENE_ELEMENT_LOCKED'
  | 'SCENE_ELEMENT_PROTECTED'
  | 'TOOL_PREVIEW_FAILED'
  | 'TOOL_TOKEN_INVALID'
  | 'TOOL_TOKEN_EXPIRED'
  | 'TOOL_TOKEN_SESSION_MISMATCH'
  | 'TOOL_TOKEN_USED'
  | 'TOOL_COMMIT_MISMATCH'
  | 'TOOL_COMMIT_FAILED'

export class AgentToolExecutorError extends Error {
  readonly code: AgentToolExecutorErrorCode
  readonly recoverable: boolean

  constructor(code: AgentToolExecutorErrorCode, message: string, recoverable = false) {
    super(message)
    this.name = 'AgentToolExecutorError'
    this.code = code
    this.recoverable = recoverable
  }
}

export interface PrepareSceneBatchInput {
  readonly projectId: string
  readonly threadId?: string | null
  readonly turnId?: string | null
  readonly legacyRunId: string
  readonly ordinal: number
  readonly mode: AgentMode
  readonly explicitTurnAuthorization: boolean
  readonly permissionProfile?: AgentPermissionProfile
  readonly rendererSessionId: string
  readonly scene: Scene
  readonly tool: SceneApplyBatchToolInput
  readonly definitionName?: string
}

export interface CommitSceneBatchInput {
  readonly executionToken: string
  readonly rendererSessionId: string
  readonly authoritativeScene: Scene
  readonly submittedScene: Scene
  readonly batch: OperationBatch
  readonly commitScene: (scene: Scene, batch: OperationBatch) => Promise<void>
}

export interface ExecuteSceneBatchMainInput extends Omit<PrepareSceneBatchInput, 'rendererSessionId'> {
  readonly executeBatch: (
    batch: ReturnType<typeof commandBatchInputSchema.parse>,
    expectedSceneRevision: number
  ) => Promise<SceneMutationResult>
}

interface InternalPreview extends StoredToolPreview {
  readonly publicPreview: ReturnType<typeof agentSceneToolPreviewSchema.parse>
  readonly batchInput: ReturnType<typeof commandBatchInputSchema.parse>
  readonly patches: OperationBatch['patches']
  readonly inversePatches: OperationBatch['inversePatches']
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sceneDigest(sceneValue: Scene): string {
  const scene = sceneSchema.parse(sceneValue)
  return digest({
    schemaVersion: scene.schemaVersion,
    id: scene.id,
    projectId: scene.projectId,
    revision: scene.revision,
    canvas: scene.canvas,
    elements: scene.elements,
    relations: scene.relations,
    creativeContext: scene.creativeContext,
    createdAt: scene.createdAt
  })
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function commandTargetIds(scene: Scene, command: SceneCommand): readonly string[] {
  if (command.kind === 'element.update' || command.kind === 'element.set-image' || command.kind === 'element.remove' || command.kind === 'element.reorder') {
    return [command.elementId]
  }
  if (command.kind === 'element.group') return command.elementIds
  if (command.kind === 'element.ungroup') {
    const group = scene.elements.find((element) => element.id === command.groupId)
    return group?.type === 'group' ? [command.groupId, ...group.childIds] : [command.groupId]
  }
  if (command.kind === 'relation.add') {
    return [command.relation.sourceElementId, command.relation.targetElementId]
  }
  if (command.kind === 'relation.remove') {
    const relation = scene.relations.find((candidate) => candidate.id === command.relationId)
    return relation === undefined ? [] : [relation.sourceElementId, relation.targetElementId]
  }
  return []
}

function isCanvasCommand(command: SceneCommand): boolean {
  return command.kind === 'scene.set-canvas' || command.kind === 'scene.set-creative-context' || command.kind === 'element.add'
}

function validateScope(scene: Scene, scope: AgentToolScope, commands: readonly SceneCommand[]): void {
  const allowed = new Set(scope.elementIds)
  for (const command of commands) {
    if (isCanvasCommand(command) && !scope.canvas) {
      throw new AgentToolExecutorError('TOOL_SCOPE_DENIED', `${command.kind} requires canvas scope.`, true)
    }
    if (!scope.canvas) {
      const outside = commandTargetIds(scene, command).filter((id) => !allowed.has(id))
      if (outside.length > 0) {
        throw new AgentToolExecutorError(
          'TOOL_SCOPE_DENIED',
          `The scene batch targets ${outside.length} element(s) outside the current turn scope.`,
          true
        )
      }
    }
  }
}

function validateLocksAndProtection(scene: Scene, commands: readonly SceneCommand[]): void {
  const elements = new Map(scene.elements.map((element) => [element.id, element]))
  const protectedIds = new Set<string>()
  for (const element of scene.elements) {
    if (element.type === 'mask' && element.mode === 'protect') {
      protectedIds.add(element.id)
      protectedIds.add(element.targetElementId)
    }
  }
  for (const command of commands) {
    for (const id of commandTargetIds(scene, command)) {
      if (elements.get(id)?.locked === true) {
        throw new AgentToolExecutorError('SCENE_ELEMENT_LOCKED', `Element ${id} is locked and cannot be changed by the Agent.`, true)
      }
      if (protectedIds.has(id)) {
        throw new AgentToolExecutorError(
          'SCENE_ELEMENT_PROTECTED',
          `Element ${id} is protected for this scene and cannot be changed automatically.`,
          true
        )
      }
    }
  }
}

function isBroadSceneMutation(commands: readonly SceneCommand[]): boolean {
  return commands.length > 20 || commands.some((command) => [
    'scene.set-canvas', 'scene.set-creative-context', 'element.remove', 'element.reorder',
    'element.group', 'element.ungroup'
  ].includes(command.kind))
}

function affectedElementIds(before: Scene, after: Scene): string[] {
  const beforeElements = new Map(before.elements.map((element) => [element.id, element]))
  const afterElements = new Map(after.elements.map((element) => [element.id, element]))
  const ids = new Set([...beforeElements.keys(), ...afterElements.keys()])
  return [...ids].filter((id) => JSON.stringify(beforeElements.get(id)) !== JSON.stringify(afterElements.get(id)))
}

function assertSameArguments(existing: AgentToolCallRecord, input: SceneApplyBatchToolInput): void {
  if (digest(existing.arguments) !== digest(input)) {
    throw new AgentToolExecutorError(
      'TOOL_IDEMPOTENCY_CONFLICT',
      'The idempotency key is already associated with different tool arguments.'
    )
  }
}

function internalPreview(record: AgentToolCallRecord): InternalPreview {
  const preview = record.preview as InternalPreview | null
  if (preview === null) throw new AgentToolExecutorError('TOOL_COMMIT_MISMATCH', 'The prepared tool call has no preview record.')
  return preview
}

export class AgentToolExecutorShadow {
  readonly #repository: AgentToolCallRepository
  readonly #registry: AgentToolRegistry
  readonly #policy: AgentToolPolicy
  readonly #nowMs: () => number
  readonly #idFactory: () => string
  readonly #tokenFactory: () => string
  readonly #tokenTtlMs: number

  constructor(options: {
    readonly repository: AgentToolCallRepository
    readonly registry?: AgentToolRegistry
    readonly policy?: AgentToolPolicy
    readonly nowMs?: () => number
    readonly idFactory?: () => string
    readonly tokenFactory?: () => string
    readonly tokenTtlMs?: number
  }) {
    this.#repository = options.repository
    this.#registry = options.registry ?? STATIC_AGENT_TOOL_REGISTRY
    this.#policy = options.policy ?? new AgentToolPolicy()
    this.#nowMs = options.nowMs ?? Date.now
    this.#idFactory = options.idFactory ?? randomUUID
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
    this.#tokenTtlMs = Math.max(1_000, Math.floor(options.tokenTtlMs ?? 15_000))
  }

  initialize(projectId: string): Promise<ReturnType<AgentToolCallRepository['recoverInterrupted']> extends Promise<infer T> ? T : never> {
    return this.#repository.recoverInterrupted(projectId)
  }

  registrySnapshot(): readonly ReturnType<AgentToolRegistry['require']>[] {
    return this.#registry.list()
  }

  async prepareSceneBatch(input: PrepareSceneBatchInput): Promise<AgentSceneToolPrepareResult> {
    const definitionName = input.definitionName ?? 'scene.apply_batch'
    const definition = this.#registry.get(definitionName)
    if (definition === null) throw new AgentToolExecutorError('TOOL_NOT_FOUND', `${definitionName} is not registered.`)
    if (definition.implementation !== 'available') {
      throw new AgentToolExecutorError('TOOL_NOT_AVAILABLE', `${definitionName} is not available in the current tool registry.`)
    }
    const scene = sceneSchema.parse(input.scene)
    const tool = sceneApplyBatchToolInputSchema.parse(input.tool)
    const profile = agentPermissionProfileSchema.parse(input.permissionProfile ?? ownerFullPermissionProfile())
    const existing = await this.#repository.findByIdempotency(input.projectId, tool.idempotencyKey)
    if (existing !== null) {
      assertSameArguments(existing, tool)
      if (existing.status === 'completed' && existing.result !== null) {
        return { state: 'completed', toolCallId: existing.id, outcome: existing.result }
      }
      if (existing.status === 'committing') {
        if (existing.operationBatchId !== null && await this.#repository.hasOperationBatch(existing.operationBatchId) && existing.result !== null) {
          const completed = await this.#repository.markCompleted(existing.id)
          return { state: 'completed', toolCallId: completed.id, outcome: completed.result! }
        }
        throw new AgentToolExecutorError('TOOL_TOKEN_USED', 'This tool call already crossed the commit boundary.', true)
      }
      if (!['prepared', 'expired'].includes(existing.status)) {
        throw new AgentToolExecutorError(
          'TOOL_TOKEN_USED',
          existing.errorMessage ?? 'This idempotent tool call has already reached a terminal state.',
          existing.recoverable
        )
      }
      const token = this.#tokenFactory()
      const expiresAt = new Date(this.#nowMs() + this.#tokenTtlMs).toISOString()
      const refreshed = await this.#repository.refreshPreparedToken(
        existing.id, tokenHash(token), tokenHash(input.rendererSessionId), expiresAt
      )
      const preview = internalPreview(refreshed)
      return {
        state: 'prepared',
        grant: agentSceneExecutionGrantSchema.parse({
          toolCallId: refreshed.id,
          executionToken: token,
          expiresAt,
          definition,
          batch: preview.batchInput,
          preview: preview.publicPreview
        })
      }
    }
    if (scene.revision !== tool.expectedSceneRevision) {
      throw new AgentToolExecutorError(
        'SCENE_REVISION_STALE',
        `The plan expected scene revision ${tool.expectedSceneRevision}, but revision ${scene.revision} is current.`,
        true
      )
    }
    validateScope(scene, tool.scope, tool.commands)
    validateLocksAndProtection(scene, tool.commands)
    const approval = this.#policy.evaluate({
      definition,
      mode: input.mode,
      profile,
      broadSceneMutation: isBroadSceneMutation(tool.commands),
      explicitTurnAuthorization: input.explicitTurnAuthorization
    })
    if (approval.effect === 'deny') {
      throw new AgentToolExecutorError('TOOL_PERMISSION_DENIED', approval.explanation)
    }
    if (approval.effect === 'ask') {
      throw new AgentToolExecutorError('TOOL_APPROVAL_REQUIRED', approval.explanation, true)
    }
    const batchInput = commandBatchInputSchema.parse({
      id: this.#idFactory(), origin: 'agent', summary: tool.summary, commands: tool.commands
    })
    const previewBus = new CommandBus(scene, { now: () => new Date(this.#nowMs()).toISOString() })
    const executed = previewBus.execute(batchInput)
    if (!executed.ok) {
      const code = executed.error.code === 'ELEMENT_LOCKED' ? 'SCENE_ELEMENT_LOCKED' : 'TOOL_PREVIEW_FAILED'
      throw new AgentToolExecutorError(code, executed.error.message, true)
    }
    const publicPreview = agentSceneToolPreviewSchema.parse({
      expectedSceneRevision: tool.expectedSceneRevision,
      resultingSceneRevision: executed.scene.revision,
      affectedElementIds: affectedElementIds(scene, executed.scene),
      operationCount: tool.commands.length,
      risk: definition.risk,
      approval,
      undoable: true
    })
    const preview: InternalPreview = {
      publicPreview,
      batchInput,
      resultSceneDigest: sceneDigest(executed.scene),
      patches: executed.batch.patches,
      inversePatches: executed.batch.inversePatches
    }
    const token = this.#tokenFactory()
    const expiresAt = new Date(this.#nowMs() + this.#tokenTtlMs).toISOString()
    const call = await this.#repository.createPrepared({
      projectId: input.projectId,
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      legacyRunId: input.legacyRunId,
      ordinal: input.ordinal,
      definition,
      idempotencyKey: tool.idempotencyKey,
      expectedSceneRevision: tool.expectedSceneRevision,
      scope: tool.scope,
      arguments: tool,
      permission: profile,
      approval,
      preview,
      executionTokenHash: tokenHash(token),
      rendererSessionHash: tokenHash(input.rendererSessionId),
      tokenExpiresAt: expiresAt,
      operationBatchId: batchInput.id,
      sceneRevisionAfter: executed.scene.revision
    })
    return {
      state: 'prepared',
      grant: agentSceneExecutionGrantSchema.parse({
        toolCallId: call.id,
        executionToken: token,
        expiresAt,
        definition,
        batch: batchInput,
        preview: publicPreview
      })
    }
  }

  async commitSceneBatch(input: CommitSceneBatchInput): Promise<AgentSceneToolCommitReceipt> {
    const tokenDigest = tokenHash(input.executionToken)
    const call = await this.#repository.findByTokenHash(tokenDigest)
    if (call === null) throw new AgentToolExecutorError('TOOL_TOKEN_INVALID', 'The scene execution token is invalid or no longer active.')
    if (call.status !== 'prepared') throw new AgentToolExecutorError('TOOL_TOKEN_USED', 'The scene execution token has already been used.')
    if (call.rendererSessionHash !== tokenHash(input.rendererSessionId)) {
      throw new AgentToolExecutorError('TOOL_TOKEN_SESSION_MISMATCH', 'The scene execution token belongs to a different renderer session.')
    }
    if (call.tokenExpiresAt === null || Date.parse(call.tokenExpiresAt) <= this.#nowMs()) {
      await this.#repository.markFailed(call.id, 'TOOL_TOKEN_EXPIRED', 'The scene execution token expired before commit.', true)
      throw new AgentToolExecutorError('TOOL_TOKEN_EXPIRED', 'The scene execution token expired before commit.', true)
    }
    const authoritativeScene = sceneSchema.parse(input.authoritativeScene)
    const submittedScene = sceneSchema.parse(input.submittedScene)
    const preview = internalPreview(call)
    if (authoritativeScene.revision !== call.expectedSceneRevision) {
      await this.#repository.markFailed(call.id, 'SCENE_REVISION_STALE', 'The scene changed after preview and before commit.', true)
      throw new AgentToolExecutorError('SCENE_REVISION_STALE', 'The scene changed after preview and before commit.', true)
    }
    const batchMatches = input.batch.id === preview.batchInput.id
      && input.batch.origin === 'agent'
      && input.batch.summary === preview.batchInput.summary
      && input.batch.revisionBefore === call.expectedSceneRevision
      && input.batch.revisionAfter === call.sceneRevisionAfter
      && digest(input.batch.patches) === digest(preview.patches)
      && digest(input.batch.inversePatches) === digest(preview.inversePatches)
    const sceneMatches = submittedScene.projectId === call.projectId
      && submittedScene.revision === call.sceneRevisionAfter
      && sceneDigest(submittedScene) === preview.resultSceneDigest
    if (!batchMatches || !sceneMatches) {
      await this.#repository.markFailed(call.id, 'TOOL_COMMIT_MISMATCH', 'Renderer output did not match the Main preview.', false)
      throw new AgentToolExecutorError('TOOL_COMMIT_MISMATCH', 'Renderer output did not match the Main preview.')
    }
    const outcome = agentToolOutcomeSchema.parse({
      toolIndex: call.ordinal,
      ok: true,
      batchId: input.batch.id,
      sceneRevisionBefore: input.batch.revisionBefore,
      sceneRevisionAfter: input.batch.revisionAfter,
      jobId: null,
      affectedElementIds: preview.publicPreview.affectedElementIds,
      message: '画布已通过 Main 工具执行器校验并保存。'
    })
    await this.#repository.markCommitting(call.id, outcome)
    try {
      await input.commitScene(submittedScene, input.batch)
    } catch (error) {
      if (await this.#repository.hasOperationBatch(input.batch.id)) {
        await this.#repository.markCompleted(call.id)
        return agentSceneToolCommitReceiptSchema.parse({ toolCallId: call.id, outcome, replayed: true })
      }
      const message = error instanceof Error ? error.message : 'The scene batch could not be persisted.'
      await this.#repository.markFailed(call.id, 'TOOL_COMMIT_FAILED', message, true)
      throw new AgentToolExecutorError('TOOL_COMMIT_FAILED', message, true)
    }
    await this.#repository.markCompleted(call.id)
    return agentSceneToolCommitReceiptSchema.parse({ toolCallId: call.id, outcome, replayed: false })
  }

  async executeSceneBatchMain(input: ExecuteSceneBatchMainInput): Promise<AgentSceneToolCommitReceipt> {
    const prepared = await this.prepareSceneBatch({
      ...input,
      rendererSessionId: 'main-scene-authority'
    })
    if (prepared.state === 'completed') {
      return agentSceneToolCommitReceiptSchema.parse({
        toolCallId: prepared.toolCallId,
        outcome: prepared.outcome,
        replayed: true
      })
    }
    const call = await this.#repository.get(prepared.grant.toolCallId)
    const preview = internalPreview(call)
    if (call.sceneRevisionAfter === null || call.expectedSceneRevision === null) {
      await this.#repository.markFailed(call.id, 'TOOL_COMMIT_MISMATCH', 'The prepared tool call has incomplete revision metadata.', false)
      throw new AgentToolExecutorError('TOOL_COMMIT_MISMATCH', 'The prepared tool call has incomplete revision metadata.')
    }
    const outcome = agentToolOutcomeSchema.parse({
      toolIndex: call.ordinal,
      ok: true,
      batchId: preview.batchInput.id,
      sceneRevisionBefore: call.expectedSceneRevision,
      sceneRevisionAfter: call.sceneRevisionAfter,
      jobId: null,
      affectedElementIds: preview.publicPreview.affectedElementIds,
      message: '画布已由 Main SceneService 原子执行并保存。'
    })
    await this.#repository.markCommitting(call.id, outcome)
    try {
      const result = await input.executeBatch(preview.batchInput, call.expectedSceneRevision)
      if (!result.ok) {
        await this.#repository.markFailed(call.id, result.error.code, result.error.message, result.error.recoverable)
        throw new AgentToolExecutorError(
          result.error.code === 'SCENE_REVISION_STALE' ? 'SCENE_REVISION_STALE' : 'TOOL_COMMIT_FAILED',
          result.error.message,
          result.error.recoverable
        )
      }
      const committedBatch = result.receipt.batch
      const committedScene = result.receipt.state.scene
      const matches = committedBatch !== null
        && committedBatch.id === preview.batchInput.id
        && committedBatch.origin === 'agent'
        && committedBatch.revisionBefore === call.expectedSceneRevision
        && committedBatch.revisionAfter === call.sceneRevisionAfter
        && digest(committedBatch.patches) === digest(preview.patches)
        && digest(committedBatch.inversePatches) === digest(preview.inversePatches)
        && sceneDigest(committedScene) === preview.resultSceneDigest
      if (!matches) {
        await this.#repository.markFailed(
          call.id,
          'TOOL_COMMIT_MISMATCH',
          'Main SceneService output did not match the authorized tool preview.',
          false
        )
        throw new AgentToolExecutorError(
          'TOOL_COMMIT_MISMATCH',
          'Main SceneService output did not match the authorized tool preview.'
        )
      }
    } catch (error) {
      if (await this.#repository.hasOperationBatch(preview.batchInput.id)) {
        await this.#repository.markCompleted(call.id)
        return agentSceneToolCommitReceiptSchema.parse({ toolCallId: call.id, outcome, replayed: true })
      }
      if (error instanceof AgentToolExecutorError) throw error
      const message = error instanceof Error ? error.message : 'The Main SceneService could not execute the scene batch.'
      await this.#repository.markFailed(call.id, 'TOOL_COMMIT_FAILED', message, true)
      throw new AgentToolExecutorError('TOOL_COMMIT_FAILED', message, true)
    }
    await this.#repository.markCompleted(call.id)
    return agentSceneToolCommitReceiptSchema.parse({ toolCallId: call.id, outcome, replayed: false })
  }

  async abortPreparedSceneBatch(executionToken: string, rendererSessionId: string, code: string, message: string): Promise<void> {
    const call = await this.#repository.findByTokenHash(tokenHash(executionToken))
    if (call === null) return
    if (call.rendererSessionHash !== tokenHash(rendererSessionId)) {
      throw new AgentToolExecutorError('TOOL_TOKEN_SESSION_MISMATCH', 'The scene execution token belongs to a different renderer session.')
    }
    if (call.status === 'prepared') await this.#repository.markFailed(call.id, code, message, true)
  }

  close(): Promise<void> {
    return this.#repository.close()
  }
}
