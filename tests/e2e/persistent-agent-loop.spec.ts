import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentRequest } from '../../src/shared/agent'
import type { AgentEvent, AgentHarnessSnapshot } from '../../src/shared/agent-harness'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function launch(userData: string): Promise<{ readonly app: ElectronApplication; readonly window: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

test('persistent Main loop publishes replayable events and advances queue_next without Renderer execution', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-e2e-persistent-loop-'))
  let running: ElectronApplication | null = null
  try {
    const launched = await launch(userData)
    running = launched.app

    const started = await launched.window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const bootstrap = await renderer.desktop.getWorkspaceBootstrap()
      const sceneSummary: AgentRequest['sceneSummary'] = {
        revision: bootstrap.scene.revision,
        canvas: bootstrap.scene.canvas,
        elementCount: bootstrap.scene.elements.length,
        elements: bootstrap.scene.elements.map((element) => ({
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
      }
      const request = (text: string): AgentRequest => ({
        text,
        sceneSummary,
        selectedIds: [],
        selectedElements: [],
        attachments: [],
        ephemeralAnnotation: null,
        autoGenerate: false,
        activeGenerationJobId: null
      })
      const state = globalThis as typeof globalThis & {
        agentLoopObserved?: AgentEvent[]
        disposeAgentLoopObserver?: () => void
      }
      state.agentLoopObserved = []
      state.disposeAgentLoopObserver = renderer.desktop.onAgentEvent((event) => state.agentLoopObserved?.push(event))
      const first = await renderer.desktop.startAgentRun(request('创建一张 1:1 的极简月夜封面，标题是 MOON TRACE。先不要生成图片。'), 'review')
      return {
        firstRunId: first.id,
        secondRequest: request('创建下一张 1:1 的晨雾山海封面，标题是 PALE HORIZON。先不要生成图片。')
      }
    })
    // A review boundary makes the active first Turn an observable, stable
    // prerequisite. Fast local planning must not decide whether this test queues.
    await expect.poll(async () => launched.window.evaluate(async () => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot()).turns[0]?.status)).toBe('waiting_decision')
    const second = await launched.window.evaluate(async (request) => (globalThis as unknown as { desktop: DesktopApi }).desktop.inputAgentRun(request, 'queue_next'), started.secondRequest)
    const setup = { firstRunId: started.firstRunId, secondRunId: second.id }
    const queueBeforeConfirm = await launched.window.evaluate(async () => (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot())
    expect(queueBeforeConfirm.turns).toHaveLength(1)
    expect(queueBeforeConfirm.turns[0]?.status).toBe('waiting_decision')
    expect(queueBeforeConfirm.queue).toEqual([expect.objectContaining({ messageId: setup.secondRunId, status: 'queued' })])
    await launched.window.evaluate(async (id) => (globalThis as unknown as { desktop: DesktopApi }).desktop.confirmAgentRun(id, 'apply_once'), setup.firstRunId)
    await expect.poll(async () => launched.window.evaluate(async (id) => (await (globalThis as unknown as { desktop: DesktopApi }).desktop.getAgentHarnessSnapshot()).turns.find((turn) => turn.inputMessageId === id)?.status, setup.secondRunId)).toBe('waiting_decision')
    await launched.window.evaluate(async (id) => (globalThis as unknown as { desktop: DesktopApi }).desktop.confirmAgentRun(id, 'apply_once'), setup.secondRunId)

    await expect.poll(async () => launched.window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const snapshot = await renderer.desktop.getAgentHarnessSnapshot()
      const terminal = new Set([
        'interrupted', 'completed', 'completed_with_notes', 'needs_user_review', 'blocked',
        'budget_limited', 'usage_limited', 'failed', 'cancelled'
      ])
      return {
        activeTurnId: snapshot.thread.activeTurnId,
        terminal: snapshot.turns.length === 2 && snapshot.turns.every((turn) => terminal.has(turn.status)),
        queue: snapshot.queue.map((entry) => entry.status)
      }
    }), { timeout: 15_000 }).toEqual({
      activeTurnId: null,
      terminal: true,
      queue: ['completed']
    })

    const evidence = await launched.window.evaluate(async () => {
      const renderer = globalThis as typeof globalThis & { readonly desktop: DesktopApi }
      const snapshot: AgentHarnessSnapshot = await renderer.desktop.getAgentHarnessSnapshot()
      const replay = await renderer.desktop.replayAgentEvents(0, 10_000)
      const lateReplay = replay.length < 2
        ? []
        : await renderer.desktop.replayAgentEvents(replay.at(-2)?.sequence ?? 0, 10_000)
      return {
        snapshot,
        replay,
        lateReplay,
        observed: (globalThis as typeof globalThis & { agentLoopObserved?: AgentEvent[] }).agentLoopObserved ?? [],
        jobs: await renderer.desktop.listGenerationJobs()
      }
    })

    expect(setup.firstRunId).not.toBe(setup.secondRunId)
    expect(evidence.snapshot.turns).toHaveLength(2)
    expect(evidence.snapshot.turns.map((turn) => ({
      status: turn.status,
      code: turn.errorCode,
      message: turn.errorMessage,
      recovery: turn.recoveryAttemptsUsed
    }))).toEqual([
      { status: 'completed', code: null, message: null, recovery: 0 },
      { status: 'completed', code: null, message: null, recovery: 0 }
    ])
    expect(evidence.snapshot.queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: setup.secondRunId, mode: 'queue_next', status: 'completed' })
    ]))
    expect(evidence.snapshot.items.filter((item) => item.type === 'tool_call' && item.status === 'completed')).toHaveLength(2)
    expect(evidence.snapshot.items.filter((item) => item.type === 'tool_call' && item.status === 'failed')).toHaveLength(0)
    expect(evidence.snapshot.items.filter((item) => item.type === 'tool_result' && item.status === 'completed')).toHaveLength(2)
    expect(evidence.snapshot.items.filter((item) => item.type === 'tool_result' && item.status === 'failed')).toHaveLength(0)
    expect(evidence.jobs).toHaveLength(0)

    const sequences = evidence.replay.map((event) => event.sequence)
    await writeFile(test.info().outputPath('queue-lifecycle-main.json'), JSON.stringify({ setup, queueBeforeConfirm, evidence }, null, 2))
    expect(sequences.length).toBeGreaterThan(0)
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(evidence.replay.map((event) => event.type)).toEqual(expect.arrayContaining([
      'queue.queued', 'queue.claimed', 'queue.completed', 'turn.assessed'
    ]))
    expect(evidence.observed.length).toBeGreaterThan(0)
    expect(evidence.lateReplay.map((event) => event.sequence)).toEqual(sequences.slice(-1))

    await launched.window.evaluate(() => {
      const state = globalThis as typeof globalThis & { disposeAgentLoopObserver?: () => void }
      state.disposeAgentLoopObserver?.()
    })
  } finally {
    if (running !== null) await running.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
