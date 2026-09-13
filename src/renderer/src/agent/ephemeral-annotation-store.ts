import { create } from 'zustand'
import type { EphemeralAnnotation, EphemeralAnnotationRegion } from '../../../shared/agent'

export type EphemeralAnnotationTool = 'paint' | 'lasso' | 'rect' | 'erase'
export type EphemeralAnnotationStatus = 'idle' | 'editing' | 'submitted' | 'failed'

interface EphemeralAnnotationState {
  projectId: string | null
  turnId: string | null
  runId: string | null
  jobId: string | null
  targetElementId: string | null
  status: EphemeralAnnotationStatus
  tool: EphemeralAnnotationTool
  mode: EphemeralAnnotationRegion['mode']
  regions: EphemeralAnnotationRegion[]
  originalRequirement: string
  failureLabel: string | null
  begin(projectId: string, targetElementId: string | null): void
  setTool(tool: EphemeralAnnotationTool): void
  setMode(mode: EphemeralAnnotationRegion['mode']): void
  addRegion(region: EphemeralAnnotationRegion): void
  removeRegion(id: string): void
  markSubmitted(runId: string, requirement: string): void
  linkJob(jobId: string): void
  markJobSubmitted(jobId: string): void
  markFailed(label: string): void
  resumeEditing(): void
  clear(): void
}

const EMPTY = {
  projectId: null,
  turnId: null,
  runId: null,
  jobId: null,
  targetElementId: null,
  status: 'idle' as const,
  tool: 'lasso' as const,
  mode: 'edit' as const,
  regions: [],
  originalRequirement: '',
  failureLabel: null
}

export const useEphemeralAnnotationStore = create<EphemeralAnnotationState>((set, get) => ({
  ...EMPTY,
  begin: (projectId, targetElementId) => {
    const current = get()
    if (current.projectId === projectId && current.targetElementId === targetElementId && current.status !== 'idle') {
      set({ status: 'editing', runId: null, jobId: null, failureLabel: null })
      return
    }
    set({ ...EMPTY, projectId, targetElementId, turnId: crypto.randomUUID(), status: 'editing' })
  },
  setTool: (tool) => set({ tool }),
  setMode: (mode) => set({ mode }),
  addRegion: (region) => set((state) => ({
    regions: [...state.regions, region],
    status: 'editing',
    runId: null,
    jobId: null,
    failureLabel: null
  })),
  removeRegion: (id) => set((state) => ({
    regions: state.regions.filter((region) => region.id !== id),
    status: 'editing',
    runId: null,
    jobId: null,
    failureLabel: null
  })),
  markSubmitted: (runId, originalRequirement) => set({ status: 'submitted', runId, jobId: null, originalRequirement, failureLabel: null }),
  linkJob: (jobId) => set({ jobId }),
  markJobSubmitted: (jobId) => set({ status: 'submitted', jobId, failureLabel: null }),
  markFailed: (failureLabel) => set({ status: 'failed', failureLabel }),
  resumeEditing: () => set({ status: 'editing', runId: null, jobId: null, failureLabel: null }),
  clear: () => set({ ...EMPTY })
}))

export function currentEphemeralAnnotation(): EphemeralAnnotation | null {
  const state = useEphemeralAnnotationStore.getState()
  const first = state.regions[0]
  if (first === undefined) return null
  return {
    ...first,
    id: state.turnId ?? crypto.randomUUID(),
    targetElementId: state.targetElementId,
    regions: [...state.regions]
  }
}

export function clearEphemeralAnnotation(): void {
  useEphemeralAnnotationStore.getState().clear()
}
