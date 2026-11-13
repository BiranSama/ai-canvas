import { create } from 'zustand'
import type { CanvasResizeStrategy } from '../../../domain'

/** Asks the toolbar's canvas size panel to open, with a way of fitting the content chosen: Ctrl+Alt+C, Photoshop's 画布大小. */
export const useCanvasSizePanel = create<{ readonly request: { readonly strategy: CanvasResizeStrategy; readonly at: number } | null; open(strategy: CanvasResizeStrategy): void }>((set) => ({
  request: null,
  open: (strategy) => set({ request: { strategy, at: Date.now() } })
}))
