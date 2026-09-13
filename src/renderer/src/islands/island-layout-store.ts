import { create } from 'zustand'
import type { GlassIslandId, GlassIslandLayout, IslandRect } from './island-layout'

interface IslandLayoutState {
  readonly layouts: Partial<Record<GlassIslandId, GlassIslandLayout>>
  readonly utilities: readonly IslandRect[]
  readonly publishUtilities: (rects: readonly IslandRect[]) => void
  readonly publish: (id: GlassIslandId, layout: GlassIslandLayout) => void
}

// Committed island geometry, published on mount and on each committed change.
// Transient drag frames never enter this store, so subscribers (for example the
// canvas fit rect) only reflow when an island actually settles.
export const useIslandLayoutStore = create<IslandLayoutState>()((set) => ({
  layouts: {},
  utilities: [],
  publishUtilities: (utilities) => set(state => JSON.stringify(state.utilities) === JSON.stringify(utilities) ? state : { utilities }),
  publish: (id, layout) => set((state) => ({ layouts: { ...state.layouts, [id]: layout } }))
}))
