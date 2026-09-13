import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationView } from '../../src/renderer/src/components/ConversationView'
import { useEphemeralAnnotationStore as annotations } from '../../src/renderer/src/agent/ephemeral-annotation-store'
import { useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'

vi.mock('../../src/renderer/src/canvas/CanvasStage', () => ({ CanvasStage: () => <div /> }))
afterEach(() => annotations.getState().clear())

function begin(projectId: string): void {
  annotations.getState().begin(projectId, null)
  annotations.getState().addRegion({ id: crypto.randomUUID(), mode: 'edit', points: [{ x: .2, y: .2 }, { x: .5, y: .5 }], closed: true, width: .02 })
}

it('keeps a new annotation when a completed old run job lookup arrives late', async () => {
  const projectId = useWorkspaceStore.getState().scene.projectId
  const pending: Array<(jobs: unknown[]) => void> = []
  const jobs = vi.fn(() => new Promise<unknown[]>((resolve) => pending.push(resolve)))
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    listGenerationJobs: jobs,
    getConversationSnapshot: async () => ({ projectId, messages: [{ id: 'receipt', runId: 'run-a', role: 'assistant', content: '完成', attachments: [], receipt: { jobId: 'job-a', items: [], nextAction: null, undoable: false } }], activities: [], runs: [{ id: 'run-a', status: 'completed', startedAt: null, completedAt: null }] }),
    getAgentHarnessSnapshot: async () => null,
    getProjectKnowledge: async () => null
  } })
  begin(projectId)
  annotations.getState().markSubmitted('run-a', '旧要求')
  render(<ConversationView header={null} />)
  await waitFor(() => expect(jobs).toHaveBeenCalled())
  act(() => { annotations.getState().clear(); begin('project-b') })
  const retained = annotations.getState()
  await act(async () => { pending.forEach((resolve) => resolve([{ id: 'job-a', status: 'completed' }])) })
  expect(annotations.getState()).toMatchObject({ projectId: 'project-b', turnId: retained.turnId, status: 'editing', regions: retained.regions })
})

it('does not mark a replacement annotation failed after an old retry rejects', async () => {
  const projectId = useWorkspaceStore.getState().scene.projectId
  let reject!: (error: Error) => void
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    listGenerationJobs: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
  } })
  begin(projectId)
  annotations.getState().markSubmitted('run-a', '旧要求')
  annotations.getState().linkJob('job-a')
  annotations.getState().markFailed('可重试')
  render(<ConversationView header={null} />)
  fireEvent.click(screen.getByRole('button', { name: '原样重试' }))
  act(() => { annotations.getState().clear(); begin('project-b') })
  const retained = annotations.getState()
  await act(async () => reject(new Error('old retry rejected')))
  expect(annotations.getState()).toMatchObject({ projectId: 'project-b', turnId: retained.turnId, status: 'editing', failureLabel: null, regions: retained.regions })
})

