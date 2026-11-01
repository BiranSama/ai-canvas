import { create } from 'zustand'
import { asksBeforeGenerating } from '../../../shared/provider-settings'

interface CreationSessionState {
  projectId: string | null
  draft: string
  /** 「生图前先问我」 from the settings; null until they are read, and the Agent asks then too. */
  askBeforeGenerating: boolean | null
  bindProject(projectId: string, savedDraft?: string): void
  setDraft(draft: string): void
  setAskBeforeGenerating(ask: boolean): void
  refreshGenerationPreference(): Promise<void>
  completeAcceptedTurn(): void
}

export const useCreationSessionStore = create<CreationSessionState>((set) => ({
  projectId: null,
  draft: '',
  askBeforeGenerating: null,
  bindProject: (projectId, savedDraft) => set((state) => state.projectId === projectId && savedDraft === undefined
    ? state
    : { projectId, draft: savedDraft ?? '' }),
  setDraft: (draft) => set({ draft }),
  setAskBeforeGenerating: (askBeforeGenerating) => set({ askBeforeGenerating }),
  refreshGenerationPreference: async () => {
    try {
      const snapshot = await window.desktop.getProviderSettings()
      set({ askBeforeGenerating: asksBeforeGenerating(snapshot.executionPolicy) })
    } catch {
      set({ askBeforeGenerating: null })
    }
  },
  completeAcceptedTurn: () => set({ draft: '' })
}))

/** Whether a new turn may generate without asking: only when the person turned 「生图前先问我」 off. */
export function generatesWithoutAsking(): boolean {
  return useCreationSessionStore.getState().askBeforeGenerating === false
}
