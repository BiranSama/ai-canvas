import { create } from 'zustand'
import type { AgentMode } from '../../../shared/agent-harness'

export type ProviderAutoGenerationState = 'unknown' | 'allowed' | 'blocked' | 'unavailable'

interface CreationSessionState {
  projectId: string | null
  draft: string
  agentMode: AgentMode
  autoGenerateForNextTurn: boolean
  providerAutoGeneration: ProviderAutoGenerationState
  bindProject(projectId: string, savedDraft?: string): void
  setDraft(draft: string): void
  setAgentMode(mode: AgentMode): void
  setAutoGenerateForNextTurn(enabled: boolean): void
  setProviderAutoGenerationAllowed(allowed: boolean): void
  refreshProviderAutoGeneration(): Promise<void>
  completeAcceptedTurn(): void
}

function readStoredAgentMode(): AgentMode {
  try {
    const stored = globalThis.localStorage?.getItem('ai-canvas.agent-mode')
    return stored === 'review' || stored === 'collaboration' || stored === 'auto'
      ? stored
      : 'collaboration'
  } catch {
    return 'collaboration'
  }
}

function persistAgentMode(mode: AgentMode): void {
  try {
    globalThis.localStorage?.setItem('ai-canvas.agent-mode', mode)
  } catch {
    // The in-memory mode remains usable when storage is unavailable.
  }
}

const initialAgentMode = readStoredAgentMode()

export const useCreationSessionStore = create<CreationSessionState>((set, get) => ({
  projectId: null,
  draft: '',
  agentMode: initialAgentMode,
  autoGenerateForNextTurn: false,
  providerAutoGeneration: 'unknown',
  bindProject: (projectId, savedDraft) => set((state) => state.projectId === projectId && savedDraft === undefined
    ? state
    : {
        projectId,
        draft: savedDraft ?? '',
        autoGenerateForNextTurn: false
      }),
  setDraft: (draft) => set({ draft }),
  setAgentMode: (agentMode) => {
    persistAgentMode(agentMode)
    set((state) => ({
      agentMode,
      autoGenerateForNextTurn: agentMode === 'review' ? false : state.autoGenerateForNextTurn
    }))
  },
  setAutoGenerateForNextTurn: (autoGenerateForNextTurn) => set((state) => ({
    autoGenerateForNextTurn: autoGenerateForNextTurn
      && state.agentMode !== 'review'
      && state.providerAutoGeneration === 'allowed'
  })),
  setProviderAutoGenerationAllowed: (allowed) => set((state) => ({
    providerAutoGeneration: allowed ? 'allowed' : 'blocked',
    autoGenerateForNextTurn: allowed ? state.autoGenerateForNextTurn : false
  })),
  refreshProviderAutoGeneration: async () => {
    try {
      const snapshot = await window.desktop.getProviderSettings()
      get().setProviderAutoGenerationAllowed(snapshot.executionPolicy.autoGenerate)
    } catch {
      set({ providerAutoGeneration: 'unavailable', autoGenerateForNextTurn: false })
    }
  },
  completeAcceptedTurn: () => set({ draft: '', autoGenerateForNextTurn: false })
}))

export function autoGenerationTurnCopy(
  mode: AgentMode,
  providerState: ProviderAutoGenerationState
): { readonly enabled: boolean; readonly label: string; readonly title: string } {
  if (providerState === 'unknown') {
    return { enabled: false, label: '读取自动生成权限', title: '正在读取设置中的图片任务权限。' }
  }
  if (providerState === 'unavailable') {
    return { enabled: false, label: '自动生成权限不可用', title: '暂时无法读取设置；本轮不会自动创建图片任务。' }
  }
  if (providerState === 'blocked') {
    return { enabled: false, label: '自动生成未授权', title: '请先在设置中允许 Agent 自动发起图片任务；直接要求生成仍会进入确认。' }
  }
  if (mode === 'review') {
    return { enabled: false, label: '审阅模式逐步确认', title: '审阅模式不会跳过图片任务确认。' }
  }
  return {
    enabled: true,
    label: '本轮继续生成',
    title: '只对当前这一轮生效，仍受确认方式、请求数、图片数与费用上限约束。'
  }
}
