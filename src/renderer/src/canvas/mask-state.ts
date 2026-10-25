import { create } from 'zustand'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Which layer mask the painting tools work on, and how a mask is shown, as
 * in Photoshop: a click on the mask's thumbnail edits it, Alt+click shows
 * it alone in gray, and \ lays it over the layer in red.
 */

export type MaskView = 'normal' | 'alone' | 'overlay'

interface MaskState {
  /** The layer whose mask the painting tools paint on, or null for its pixels. */
  readonly editing: string | null
  readonly view: { readonly elementId: string; readonly mode: Exclude<MaskView, 'normal'> } | null
  editMask(elementId: string | null): void
  setView(elementId: string, mode: MaskView): void
}

export const useMaskState = create<MaskState>()((set) => ({
  editing: null,
  view: null,
  editMask: (editing) => set({ editing }),
  setView: (elementId, mode) => set({ view: mode === 'normal' ? null : { elementId, mode } })
}))

/**
 * Runs work on the picture as it really is: a mask shown alone or in red
 * is set aside while the canvas redraws for it, then brought back.
 */
export async function withMaskViewSetAside<T>(work: () => T | Promise<T>): Promise<T> {
  const view = useMaskState.getState().view
  if (view === null) return work()
  useMaskState.setState({ view: null })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  try {
    return await work()
  } finally {
    if (useMaskState.getState().view === null) useMaskState.setState({ view })
  }
}

export function maskViewOf(elementId: string): MaskView {
  const view = useMaskState.getState().view
  return view?.elementId === elementId ? view.mode : 'normal'
}

// The mask stays the target only while its layer is the one selected and still has a mask.
useWorkspaceStore.subscribe((state) => {
  const { editing, view } = useMaskState.getState()
  const holds = (id: string | null): boolean => {
    if (id === null) return true
    const element = state.scene.elements.find((candidate) => candidate.id === id)
    return element !== undefined && 'mask' in element && element.mask !== null && element.mask !== undefined
  }
  const editingHolds = holds(editing) && (editing === null || (state.selectedIds.length === 1 && state.selectedIds[0] === editing))
  const viewHolds = holds(view?.elementId ?? null)
  if (!editingHolds || !viewHolds) useMaskState.setState({ editing: editingHolds ? editing : null, view: viewHolds ? view : null })
})
