import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ConversationView } from '../../src/renderer/src/components/ConversationView'
import { ProviderSettingsSheet } from '../../src/renderer/src/components/ProviderSettingsSheet'
import { DEFAULT_STARTER_PROMPTS, useStarterPrompts } from '../../src/renderer/src/project/example-project'
import { useCreationSessionStore } from '../../src/renderer/src/store/creation-session-store'
import { useFirstRunStore } from '../../src/renderer/src/store/first-run-store'
import { useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { DEFAULT_PROVIDER_CONFIG } from '../../src/shared/provider-settings'

vi.mock('../../src/renderer/src/canvas/CanvasStage', () => ({ CanvasStage: () => <div /> }))

function conversation(messages: unknown[]): void {
  const projectId = useWorkspaceStore.getState().scene.projectId
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    listGenerationJobs: async () => [],
    getConversationSnapshot: async () => ({ projectId, messages, activities: [], runs: [] }),
    getAgentHarnessSnapshot: async () => null,
    getProjectKnowledge: async () => null
  } })
}

beforeEach(() => {
  localStorage.clear()
  useFirstRunStore.setState({ guideDismissed: false, serviceCardDismissed: false })
  useStarterPrompts.setState({ prompts: {} })
  useCreationSessionStore.setState({ draft: '', references: [], pendingReferences: 0 })
})

it('shows three steps in an empty conversation, fills the draft from an example and points at the places in turn', async () => {
  conversation([])
  const view = render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
  const guide = await screen.findByRole('region', { name: '新手指引' })
  expect(guide).toHaveTextContent('在下面说一句话')
  expect(guide).toHaveTextContent('画布上的「编辑」')
  expect(view.container.querySelector('.conversation-composer')).toHaveClass('is-guided')
  expect(view.container.querySelector('.conversation-preview')).toHaveClass('is-guided')
  expect(view.container.querySelector('.open-editor')).toHaveClass('is-guided')

  fireEvent.click(screen.getByRole('button', { name: DEFAULT_STARTER_PROMPTS[0]! }))
  expect(screen.getByRole('textbox', { name: '对话输入' })).toHaveValue(DEFAULT_STARTER_PROMPTS[0]!)

  fireEvent.click(screen.getByRole('button', { name: '知道了' }))
  expect(screen.queryByRole('region', { name: '新手指引' })).not.toBeInTheDocument()
  expect(view.container.querySelector('.is-guided')).toBeNull()
  expect(screen.getByText('从作品需要的内容开始')).toBeInTheDocument()
  expect(localStorage.getItem('ai-canvas.first-run-guide.dismissed')).toBe('true')
})

it('offers the prompts an example project brings', async () => {
  const projectId = useWorkspaceStore.getState().scene.projectId
  useStarterPrompts.setState({ prompts: { [projectId]: ['把标题换成我的店名', '换成冬天的配色', '主体换成一杯热可可'] } })
  conversation([])
  render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
  expect(await screen.findByRole('group', { name: '试试这样说' })).toHaveTextContent('把标题换成我的店名')
  expect(screen.queryByRole('button', { name: DEFAULT_STARTER_PROMPTS[0]! })).not.toBeInTheDocument()
})

it('is not shown once the conversation has begun', async () => {
  const projectId = useWorkspaceStore.getState().scene.projectId
  conversation([{ id: 'm1', conversationId: 'c1', projectId, role: 'user', kind: 'text', content: '做一张海报', receipt: null, attachments: [], runId: 'run-a', createdAt: '2026-11-01T00:00:00.000Z' }])
  const view = render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
  expect(await screen.findByText('做一张海报')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '新手指引' })).not.toBeInTheDocument()
  expect(view.container.querySelector('.is-guided')).toBeNull()
})

it('comes back from 偏好 after it was put away', async () => {
  useFirstRunStore.getState().dismissGuide()
  useFirstRunStore.getState().dismissServiceCard()
  const [llm, image] = DEFAULT_PROVIDER_CONFIG.providers
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    getProviderSettings: async () => ({ providers: [{ ...llm, configured: true }, { ...image, configured: true }], defaultImageProviderId: 'image-provider', realCallsAuthorized: true, executionPolicy: DEFAULT_PROVIDER_CONFIG.executionPolicy, textHelpers: { vision: null, backup: null, fast: null }, checks: {} }),
    getRuntimeInfo: async () => { throw new Error('not needed') },
    listGenerationProfiles: async () => ({ realCallsAuthorized: true, profiles: [] })
  } })
  render(<ProviderSettingsSheet onClose={() => undefined} />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('button', { name: '偏好' }))
  fireEvent.click(screen.getByRole('button', { name: '重新显示新手指引' }))
  expect(useFirstRunStore.getState()).toMatchObject({ guideDismissed: false, serviceCardDismissed: false })
  expect(localStorage.getItem('ai-canvas.first-run-guide.dismissed')).toBeNull()
  expect(localStorage.getItem('ai-canvas.service-connect.dismissed')).toBeNull()
})
