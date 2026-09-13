import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHarnessRepository } from '../../src/main/agent'
import type { AgentHarnessRepositoryError } from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { DEFAULT_REVIEW_BUDGET } from '../../src/shared/agent-harness'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function idFactory(): () => string {
  let value = 7_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s1-'))
  roots.push(root)
  const ids = idFactory()
  const projectDirectory = join(root, 'harness.aicanvas')
  const opened = await ProjectWorkspace.create(projectDirectory, 'Harness project', { idFactory: ids })
  const repository = new AgentHarnessRepository(join(projectDirectory, 'project.db'), {
    idFactory: ids,
    now: () => '2026-08-22T12:00:00.000+08:00'
  })
  let repositoryClosed = false
  let workspaceClosed = false
  const closeRepository = async (): Promise<void> => {
    if (repositoryClosed) return
    repositoryClosed = true
    await repository.close()
  }
  const closeWorkspace = async (): Promise<void> => {
    if (workspaceClosed) return
    workspaceClosed = true
    await opened.workspace.close(true)
  }
  closers.push(async () => {
    await closeRepository().catch(() => undefined)
    await closeWorkspace().catch(() => undefined)
  })
  return { root, ids, opened, repository, projectId: opened.workspace.metadata.id, closeRepository }
}

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop()
    if (close !== undefined) await close()
  }
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S1 agent harness repository', () => {
  it('creates one project thread and enforces a single active turn', async () => {
    const value = await harness()
    const firstThread = await value.repository.ensureThread(value.projectId)
    const secondThread = await value.repository.ensureThread(value.projectId)
    expect(secondThread.id).toBe(firstThread.id)

    const goal = await value.repository.createGoal(firstThread.id, {
      objective: '建立一个本地语义海报',
      completionDefinition: ['画布结构完整', '没有真实网络请求'],
      mode: 'collaboration',
      scope: { canvas: true, elementIds: [], assetIds: [], providerIds: [] },
      permissionProfileId: null,
      budget: DEFAULT_REVIEW_BUDGET,
      prohibitions: ['禁止真实 API']
    })
    const turn = await value.repository.startTurn(firstThread.id, {
      goalId: goal.id,
      inputMessageId: 'message-1',
      sceneRevisionAtStart: 0
    })

    await expect(value.repository.startTurn(firstThread.id, {
      goalId: goal.id,
      inputMessageId: 'message-2',
      sceneRevisionAtStart: 0
    })).rejects.toMatchObject({ code: 'ACTIVE_TURN_EXISTS' } satisfies Partial<AgentHarnessRepositoryError>)

    await value.repository.transitionTurn(turn.id, 'completed')
    const next = await value.repository.startTurn(firstThread.id, {
      goalId: goal.id,
      inputMessageId: 'message-2',
      sceneRevisionAtStart: 1
    })
    expect(next.status).toBe('queued')
  })

  it('persists items with monotonic events and replays strictly after a cursor', async () => {
    const value = await harness()
    const thread = await value.repository.ensureThread(value.projectId)
    const turn = await value.repository.startTurn(thread.id, {
      goalId: null,
      inputMessageId: 'message-1',
      sceneRevisionAtStart: 3
    })
    const item = await value.repository.appendItem(turn.id, {
      type: 'plan',
      status: 'started',
      payloadVersion: 1,
      payload: { summary: '读取场景并形成短计划' }
    })
    await value.repository.transitionItem(item.id, 'completed', { summary: '计划完成' })

    const all = await value.repository.replayEvents(thread.id, 0)
    expect(all.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(all.map((event) => event.type)).toEqual(['turn.started', 'item.started', 'item.completed'])
    await expect(value.repository.replayEvents(thread.id, 1)).resolves.toEqual(all.slice(1))
    expect((await value.repository.getThread(thread.id)).lastSequence).toBe(3)
  })

  it('pauses queued work after interruption and resumes only explicitly', async () => {
    const value = await harness()
    const thread = await value.repository.ensureThread(value.projectId)
    const turn = await value.repository.startTurn(thread.id, {
      goalId: null,
      inputMessageId: 'message-active',
      sceneRevisionAtStart: 0
    })
    await value.repository.enqueue(thread.id, { messageId: 'message-next', mode: 'queue_next' })
    await value.repository.transitionTurn(turn.id, 'interrupted', {
      errorCode: 'USER_INTERRUPTED',
      errorMessage: '用户停止了当前回合。'
    })

    expect(await value.repository.listQueue(thread.id)).toEqual([
      expect.objectContaining({ messageId: 'message-next', status: 'paused' })
    ])
    await value.repository.resumeQueue(thread.id)
    expect(await value.repository.listQueue(thread.id)).toEqual([
      expect.objectContaining({ messageId: 'message-next', status: 'queued' })
    ])
  })

  it('claims queued work only without an active turn and records queue lifecycle events', async () => {
    const value = await harness()
    const thread = await value.repository.ensureThread(value.projectId)
    const entry = await value.repository.enqueue(thread.id, { messageId: 'message-next', mode: 'queue_next' })
    const active = await value.repository.startTurn(thread.id, {
      goalId: null,
      inputMessageId: 'message-active',
      sceneRevisionAtStart: 0
    })
    await expect(value.repository.claimNextQueueEntry(thread.id)).resolves.toBeNull()
    await value.repository.transitionTurn(active.id, 'completed')
    const claimed = await value.repository.claimNextQueueEntry(thread.id)
    expect(claimed).toMatchObject({ id: entry.id, status: 'claimed' })
    await expect(value.repository.completeQueueEntry(entry.id)).resolves.toMatchObject({ status: 'completed' })
    expect((await value.repository.replayEvents(thread.id, 0)).map((event) => event.type)).toEqual(expect.arrayContaining([
      'queue.queued', 'queue.claimed', 'queue.completed'
    ]))
  })

  it('persists budget usage and interrupts unstarted work at a safe checkpoint', async () => {
    const value = await harness()
    const thread = await value.repository.ensureThread(value.projectId)
    const turn = await value.repository.startTurn(thread.id, {
      goalId: null,
      inputMessageId: 'message-active',
      sceneRevisionAtStart: 0
    })
    const plan = await value.repository.appendItem(turn.id, {
      type: 'plan', status: 'started', payloadVersion: 1, payload: { summary: '旧计划' }
    })
    await value.repository.appendItem(turn.id, {
      type: 'user_message', status: 'queued', payloadVersion: 1, payload: { mode: 'correct_current', text: '改成银灰色' }
    })
    await value.repository.incrementTurnUsage(turn.id, { modelTurns: 1, toolCalls: 2, sceneWriteBatches: 1 })
    expect(await value.repository.getTurn(turn.id)).toMatchObject({
      modelTurnsUsed: 1,
      toolCallsUsed: 2,
      sceneWriteBatchesUsed: 1
    })
    expect(await value.repository.cancelPendingItems(turn.id, 'replan')).toBe(1)
    expect(await value.repository.listTurnItems(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: plan.id, status: 'interrupted' }),
      expect.objectContaining({ type: 'user_message', status: 'queued' })
    ]))
  })

  it('recovers running turns as interrupted while preserving a waiting decision', async () => {
    const value = await harness()
    const runningThread = await value.repository.ensureThread(value.projectId)
    const running = await value.repository.startTurn(runningThread.id, {
      goalId: null,
      inputMessageId: 'message-running',
      sceneRevisionAtStart: 0
    })
    await value.repository.transitionTurn(running.id, 'running')
    await value.closeRepository()

    const reopened = new AgentHarnessRepository(join(value.root, 'harness.aicanvas', 'project.db'), {
      idFactory: value.ids,
      now: () => '2026-08-22T12:01:00.000+08:00'
    })
    let reopenedClosed = false
    closers.push(async () => {
      if (reopenedClosed) return
      reopenedClosed = true
      await reopened.close().catch(() => undefined)
    })
    expect(await reopened.recoverInterrupted(value.projectId)).toBe(1)
    expect(await reopened.getTurn(running.id)).toMatchObject({ status: 'interrupted', errorCode: 'APP_INTERRUPTED' })

    const waiting = await reopened.startTurn(runningThread.id, {
      goalId: null,
      inputMessageId: 'message-decision',
      sceneRevisionAtStart: 0
    })
    const decision = await reopened.appendItem(waiting.id, {
      type: 'decision',
      status: 'waiting',
      payloadVersion: 1,
      payload: { title: '选择画面比例' }
    })
    await reopened.transitionTurn(waiting.id, 'waiting_decision')
    expect(await reopened.recoverInterrupted(value.projectId)).toBe(0)
    expect(await reopened.getTurn(waiting.id)).toMatchObject({ status: 'waiting_decision' })
    const snapshot = await reopened.getSnapshot(runningThread.id)
    expect(snapshot.thread).toMatchObject({ activeTurnId: waiting.id })
    expect(snapshot.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: waiting.id, status: 'waiting_decision' })
    ]))
    expect(snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: decision.id, status: 'waiting', type: 'decision' })
    ]))
  })
})
