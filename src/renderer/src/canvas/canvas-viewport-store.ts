import { create } from 'zustand'

export interface CanvasViewportRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly zoom: number
}

interface CanvasViewportState {
  readonly artboard: CanvasViewportRect | null
  readonly publish: (rect: CanvasViewportRect) => void
}

// The mounted CanvasStage publishes its artboard geometry (in stage-space
// pixels) so overlays such as the Prismatic Action Trace can align with real
// canvas objects without duplicating the fit math.
export const useCanvasViewportStore = create<CanvasViewportState>()((set) => ({
  artboard: null,
  publish: (artboard) => set({ artboard })
}))
