import { create } from 'zustand'
import { generationWorkContextSchema, type GenerationWorkContext } from '../../../shared/project-work-context'

interface GenerationDraftState extends GenerationWorkContext {
  projectId: string | null
  bindProject(projectId: string, saved?: GenerationWorkContext, ratio?: string): void
  updateDraft(patch: Partial<GenerationWorkContext>, expectedProjectId?: string): void
}

export const useGenerationDraftStore = create<GenerationDraftState>((set) => ({
  ...generationWorkContextSchema.parse({}),
  projectId: null,
  bindProject: (projectId, saved, ratio = '4:5') => set((state) => state.projectId === projectId && saved === undefined
    ? state
    : { ...generationWorkContextSchema.parse(saved ?? { ratioInput: ratio }), projectId }),
  updateDraft: (patch, expectedProjectId) => set((state) => expectedProjectId !== undefined && state.projectId !== expectedProjectId
    ? state
    : patch)
}))
