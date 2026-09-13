import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../src/domain'
import {
  AgentToolCallRepository,
  AgentToolExecutorShadow,
  ConversationRepository
} from '../../src/main/agent'
import type { AgentToolExecutorError } from '../../src/main/agent'
import { SceneService } from '../../src/main/scene'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { AgentRequest } from '../../src/shared/agent'
import { makeImage, makeText } from '../fixtures/scene-fixtures'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function ids(start = 31_000): () => string {
  let value = start
  return () => `31000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

async function setup(sceneFactory?: (base: Scene) => Scene) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s2-'))
  roots.push(root)
  const idFactory = ids()
  const directory = join(root, 'tool-shadow.aicanvas')
  const opened = await ProjectWorkspace.create(directory, 'Tool shadow', { idFactory })
  const scene = sceneFactory?.(opened.scene) ?? { ...opened.scene, elements: [makeText(0)] }
  const databasePath = join(directory, 'project.db')
  const conversation = new ConversationRepository(databasePath, {
    idFactory,
    now: () => '2026-08-22T12:00:00.000+08:00'
  })
  const request: AgentRequest = {
    text: '调整标题',
    sceneSummary: {
      revision: scene.revision,
      canvas: {
        aspectWidth: scene.canvas.aspectWidth,
        aspectHeight: scene.canvas.aspectHeight,
        outputWidth: scene.canvas.outputWidth,
        outputHeight: scene.canvas.outputHeight,
        globalStyle: scene.canvas.globalStyle
      },
      elementCount: scene.elements.length,
      elements: scene.elements.map((element) => ({
        id: element.id,
        type: element.type,
        name: element.name,
        description: element.description,
        semanticRole: element.semanticRole,
        groupId: element.groupId,
        locked: element.locked,
        visible: element.visible,
        transform: element.transform
      }))
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    ephemeralAnnotation: null,
    autoGenerate: false,
    activeGenerationJobId: null
  }
  const run = await conversation.createRun(opened.workspace.metadata.id, request, 8)
  let nowMs = Date.parse('2026-08-22T04:00:00.000Z')
  let tokenOrdinal = 0
  const repository = new AgentToolCallRepository(databasePath, {
    idFactory,
    now: () => new Date(nowMs).toISOString()
  })
  const executor = new AgentToolExecutorShadow({
    repository,
    idFactory,
    nowMs: () => nowMs,
    tokenFactory: () => `${String(++tokenOrdinal).padStart(2, '0')}${'t'.repeat(41)}`,
    tokenTtlMs: 15_000
  })
  let closed = false
  closers.push(async () => {
    if (closed) return
    closed = true
    await executor.close().catch(() => undefined)
    await conversation.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  return {
    root, directory, opened, scene, databasePath, conversation, repository, executor,
    runId: run.run.id, projectId: opened.workspace.metadata.id,
    sessionA: '31000000-0000-4000-8000-000000000091',
    sessionB: '31000000-0000-4000-8000-000000000092',
    advance: (milliseconds: number) => { nowMs += milliseconds }
  }
}

function input(value: Awaited<ReturnType<typeof setup>>, overrides: Partial<{
  readonly expectedSceneRevision: number
  readonly scope: { canvas: boolean; elementIds: string[] }
  readonly commands: [{ kind: 'element.update'; elementId: string; changes: Record<string, unknown> }]
}> = {}) {
  const target = value.scene.elements[0]!
  return {
    projectId: value.projectId,
    legacyRunId: value.runId,
    ordinal: 0,
    mode: 'collaboration' as const,
    explicitTurnAuthorization: true,
    rendererSessionId: value.sessionA,
    scene: value.scene,
    tool: {
      idempotencyKey: `run:${value.runId}:tool:0:scene.apply_batch:v1`,
      expectedSceneRevision: overrides.expectedSceneRevision ?? value.scene.revision,
      scope: overrides.scope ?? { canvas: true, elementIds: [] },
      summary: '调整标题透明度',
      commands: overrides.commands ?? [{ kind: 'element.update' as const, elementId: target.id, changes: { opacity: 0.72 } }]
    }
  }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S2 Main tool executor shadow', () => {
  it('executes the authorized Agent batch directly through Main SceneService and replays without a second write', async () => {
    const value = await setup()
    const service = new SceneService(value.scene, {
      save: (scene, batch, reason) => value.opened.workspace.saveScene(scene, reason, batch)
    })
    const preparedInput = input(value)
    const mainInput = {
      projectId: preparedInput.projectId,
      legacyRunId: preparedInput.legacyRunId,
      ordinal: preparedInput.ordinal,
      mode: preparedInput.mode,
      explicitTurnAuthorization: preparedInput.explicitTurnAuthorization,
      scene: preparedInput.scene,
      tool: preparedInput.tool
    }
    const first = await value.executor.executeSceneBatchMain({
      ...mainInput,
      executeBatch: (batch, expectedSceneRevision) => service.execute({ expectedSceneRevision, batch })
    })

    expect(first).toMatchObject({ replayed: false, outcome: { ok: true, batchId: expect.any(String) } })
    expect(service.state()).toMatchObject({ sequence: 1, canUndo: true, scene: { revision: 1 } })
    expect(service.state().scene.elements[0]).toMatchObject({ opacity: 0.72 })

    const replay = await value.executor.executeSceneBatchMain({
      ...mainInput,
      executeBatch: (batch, expectedSceneRevision) => service.execute({ expectedSceneRevision, batch })
    })
    expect(replay).toMatchObject({ replayed: true, outcome: first.outcome })
    expect(service.state().sequence).toBe(1)
  })

  it('previews, issues a session-bound token, reconciles the exact batch and replays duplicate idempotency', async () => {
    const value = await setup()
    const prepared = await value.executor.prepareSceneBatch(input(value))
    expect(prepared).toMatchObject({
      state: 'prepared',
      grant: {
        definition: { name: 'scene.apply_batch', version: 1, risk: 'local_reversible' },
        preview: { expectedSceneRevision: 0, resultingSceneRevision: 1, undoable: true }
      }
    })
    if (prepared.state !== 'prepared') throw new Error('Expected a prepared tool call.')
    const executed = new CommandBus(value.scene, { now: () => '2026-08-22T12:00:01.000+08:00' }).execute(prepared.grant.batch)
    if (!executed.ok) throw new Error(executed.error.message)
    let commits = 0
    const receipt = await value.executor.commitSceneBatch({
      executionToken: prepared.grant.executionToken,
      rendererSessionId: value.sessionA,
      authoritativeScene: value.scene,
      submittedScene: executed.scene,
      batch: executed.batch,
      commitScene: async (scene, batch) => {
        commits += 1
        await value.opened.workspace.saveScene(scene, 'autosave', batch)
      }
    })
    expect(receipt).toMatchObject({ replayed: false, outcome: { ok: true, batchId: executed.batch.id } })
    expect(commits).toBe(1)
    const replay = await value.executor.prepareSceneBatch(input(value))
    expect(replay).toMatchObject({ state: 'completed', outcome: receipt.outcome })
    expect(commits).toBe(1)
  })

  it('rejects stale revisions and scope escapes before issuing a token', async () => {
    const stale = await setup()
    await expect(stale.executor.prepareSceneBatch(input(stale, { expectedSceneRevision: 3 })))
      .rejects.toMatchObject({ code: 'SCENE_REVISION_STALE', recoverable: true } satisfies Partial<AgentToolExecutorError>)

    const scoped = await setup()
    await expect(scoped.executor.prepareSceneBatch(input(scoped, {
      scope: { canvas: false, elementIds: [] }
    }))).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' } satisfies Partial<AgentToolExecutorError>)
  })

  it('rejects locked and protect-masked objects even when they are inside scope', async () => {
    const locked = await setup((base) => ({ ...base, elements: [{ ...makeText(0), locked: true }] }))
    await expect(locked.executor.prepareSceneBatch(input(locked)))
      .rejects.toMatchObject({ code: 'SCENE_ELEMENT_LOCKED' } satisfies Partial<AgentToolExecutorError>)

    const protectedValue = await setup((base) => {
      const image = makeImage(0)
      const protectMask: SceneElement = {
        id: '31000000-0000-4000-8000-000000000093', version: ELEMENT_SCHEMA_VERSION, type: 'mask', name: '保护主体',
        description: '', transform: { ...image.transform }, zIndex: 1, opacity: 0.6, visible: true, locked: false,
        groupId: null, semanticRole: 'protection', referencePolicy: 'exclude', mode: 'protect', targetElementId: image.id,
        paths: [{
          id: '31000000-0000-4000-8000-000000000094',
          points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.8 }], closed: true
        }], feather: 0.05
      }
      return { ...base, elements: [image, protectMask] }
    })
    await expect(protectedValue.executor.prepareSceneBatch(input(protectedValue)))
      .rejects.toMatchObject({ code: 'SCENE_ELEMENT_PROTECTED' } satisfies Partial<AgentToolExecutorError>)
  })

  it('invalidates a prepared token across renderer sessions and after expiration', async () => {
    const session = await setup()
    const prepared = await session.executor.prepareSceneBatch(input(session))
    if (prepared.state !== 'prepared') throw new Error('Expected a prepared tool call.')
    const executed = new CommandBus(session.scene).execute(prepared.grant.batch)
    if (!executed.ok) throw new Error(executed.error.message)
    await expect(session.executor.commitSceneBatch({
      executionToken: prepared.grant.executionToken,
      rendererSessionId: session.sessionB,
      authoritativeScene: session.scene,
      submittedScene: executed.scene,
      batch: executed.batch,
      commitScene: async () => undefined
    })).rejects.toMatchObject({ code: 'TOOL_TOKEN_SESSION_MISMATCH' } satisfies Partial<AgentToolExecutorError>)

    session.advance(15_001)
    await expect(session.executor.commitSceneBatch({
      executionToken: prepared.grant.executionToken,
      rendererSessionId: session.sessionA,
      authoritativeScene: session.scene,
      submittedScene: executed.scene,
      batch: executed.batch,
      commitScene: async () => undefined
    })).rejects.toMatchObject({ code: 'TOOL_TOKEN_EXPIRED' } satisfies Partial<AgentToolExecutorError>)
  })

  it('rejects preview/commit drift and never calls the persistence boundary', async () => {
    const value = await setup()
    const prepared = await value.executor.prepareSceneBatch(input(value))
    if (prepared.state !== 'prepared') throw new Error('Expected a prepared tool call.')
    const executed = new CommandBus(value.scene).execute(prepared.grant.batch)
    if (!executed.ok) throw new Error(executed.error.message)
    let commits = 0
    await expect(value.executor.commitSceneBatch({
      executionToken: prepared.grant.executionToken,
      rendererSessionId: value.sessionA,
      authoritativeScene: value.scene,
      submittedScene: { ...executed.scene, canvas: { ...executed.scene.canvas, backgroundColor: '#FF0000' } },
      batch: executed.batch,
      commitScene: async () => { commits += 1 }
    })).rejects.toMatchObject({ code: 'TOOL_COMMIT_MISMATCH' } satisfies Partial<AgentToolExecutorError>)
    expect(commits).toBe(0)
  })
})
