import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity, ConversationSnapshot } from '../../src/shared/agent'
import { ActionTrace } from '../../src/renderer/src/canvas/ActionTrace'
import { useCanvasViewportStore } from '../../src/renderer/src/canvas/canvas-viewport-store'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'
import { hydrateWorkspaceScene, resetWorkspace, setWorkspaceSceneClientForTests, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { createLocalWorkspaceSceneClient } from '../helpers/local-workspace-scene-client'

function activity(partial: Partial<AgentActivity> & Pick<AgentActivity, 'id' | 'state'>): AgentActivity {
  return {
    projectId: NIGHT_VEIL_IDS.project,
    runId: null,
    kind: 'tool',
    eventType: 'scene_batch',
    label: '更新画布结构',
    progress: null,
    objectLabel: '当前作品',
    actionLabel: '调整元素',
    impactLabel: '影响 1 个元素',
    scopeLabel: null,
    affectedIds: [NIGHT_VEIL_IDS.title],
    operationBatchId: null,
    jobId: null,
    budgetImpact: null,
    recoverable: false,
    undoneAt: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    decision: null,
    ...partial
  }
}

function snapshotWith(activities: readonly AgentActivity[]): ConversationSnapshot {
  return {
    conversationId: 'conv-1',
    projectId: NIGHT_VEIL_IDS.project,
    messages: [],
    runs: [],
    activities
  }
}

function renderTrace(snapshot: ConversationSnapshot): ReturnType<typeof render> {
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { getConversationSnapshot: vi.fn().mockResolvedValue(snapshot) }
  })
  return render(
    <div>
      <div data-island-id="composer" />
      <ActionTrace />
    </div>
  )
}

describe('Prismatic Action Trace', () => {
  beforeEach(() => {
    resetWorkspace()
    setWorkspaceSceneClientForTests(createLocalWorkspaceSceneClient(useWorkspaceStore.getState().scene))
    hydrateWorkspaceScene(createNightVeilScene(), '测试作品', { sequence: 1, canUndo: false, canRedo: false })
    useCanvasViewportStore.getState().publish({ x: 40, y: 20, width: 400, height: 500, zoom: 1 })
  })

  afterEach(() => {
    vi.useRealTimers()
    setWorkspaceSceneClientForTests(null)
  })

  it('draws a transient spectral trace to the affected element after a real activity completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderTrace(snapshotWith([activity({ id: 'act-1', state: 'completed', endedAt: new Date().toISOString() })]))
    const paths = await waitFor(() => {
      const found = document.querySelectorAll('[data-testid="action-trace"] path.action-trace-path')
      expect(found.length).toBe(1)
      return found
    })
    expect(paths.length).toBe(1)

    act(() => {
      vi.advanceTimersByTime(2_600)
    })
    expect(document.querySelector('[data-testid="action-trace"]')).toBeNull()
  })

  it('stays silent without affected objects and for stale activities', async () => {
    renderTrace(snapshotWith([
      activity({ id: 'act-old', state: 'completed', endedAt: new Date(Date.now() - 30_000).toISOString() }),
      activity({ id: 'act-empty', state: 'completed', endedAt: new Date().toISOString(), affectedIds: [] })
    ]))
    await waitFor(() => {
      expect(window.desktop.getConversationSnapshot).toHaveBeenCalled()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('[data-testid="action-trace"]')).toBeNull()
  })

  it('ignores affected ids that no longer exist in the scene', async () => {
    renderTrace(snapshotWith([
      activity({ id: 'act-gone', state: 'completed', endedAt: new Date().toISOString(), affectedIds: ['00000000-0000-4000-8000-000000000000'] })
    ]))
    await waitFor(() => {
      expect(window.desktop.getConversationSnapshot).toHaveBeenCalled()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('[data-testid="action-trace"]')).toBeNull()
  })
})
