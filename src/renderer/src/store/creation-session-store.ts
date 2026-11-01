import { create } from 'zustand'
import { asksBeforeGenerating } from '../../../shared/provider-settings'

/** A picture the person attached from this computer: a reference for the Agent, not a layer on the canvas. */
export interface ReferenceAttachment {
  readonly assetId: string
  readonly name: string
}

export const MAX_REFERENCES = 4

interface CreationSessionState {
  projectId: string | null
  draft: string
  /** Pictures attached to the draft; like its text, they stay while the person moves between views. */
  references: readonly ReferenceAttachment[]
  /** Attached pictures still being added; a message waits for them. */
  pendingReferences: number
  /** 「生图前先问我」 from the settings; null until they are read, and the Agent asks then too. */
  askBeforeGenerating: boolean | null
  bindProject(projectId: string, savedDraft?: string): void
  setDraft(draft: string): void
  beginReference(): void
  /** Adds a picture once it is in, unless the project changed meanwhile. */
  finishReference(projectId: string, reference: ReferenceAttachment | null): void
  removeReference(assetId: string): void
  setAskBeforeGenerating(ask: boolean): void
  refreshGenerationPreference(): Promise<void>
  completeAcceptedTurn(): void
}

export const useCreationSessionStore = create<CreationSessionState>((set) => ({
  projectId: null,
  draft: '',
  references: [],
  pendingReferences: 0,
  askBeforeGenerating: null,
  bindProject: (projectId, savedDraft) => set((state) => state.projectId === projectId && savedDraft === undefined
    ? state
    : { projectId, draft: savedDraft ?? '', ...(state.projectId === projectId ? {} : { references: [], pendingReferences: 0 }) }),
  setDraft: (draft) => set({ draft }),
  beginReference: () => set((state) => ({ pendingReferences: state.pendingReferences + 1 })),
  finishReference: (projectId, reference) => set((state) => state.projectId !== projectId
    ? state
    : {
        pendingReferences: Math.max(0, state.pendingReferences - 1),
        references: reference === null ? state.references : [...state.references, reference].slice(0, MAX_REFERENCES)
      }),
  removeReference: (assetId) => set((state) => ({ references: state.references.filter((reference) => reference.assetId !== assetId) })),
  setAskBeforeGenerating: (askBeforeGenerating) => set({ askBeforeGenerating }),
  refreshGenerationPreference: async () => {
    try {
      const snapshot = await window.desktop.getProviderSettings()
      set({ askBeforeGenerating: asksBeforeGenerating(snapshot.executionPolicy) })
    } catch {
      set({ askBeforeGenerating: null })
    }
  },
  completeAcceptedTurn: () => set({ draft: '', references: [] })
}))

/** Whether a new turn may generate without asking: only when the person turned 「生图前先问我」 off. */
export function generatesWithoutAsking(): boolean {
  return useCreationSessionStore.getState().askBeforeGenerating === false
}
