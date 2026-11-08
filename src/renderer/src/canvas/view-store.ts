import { create } from 'zustand'
import type { Guide } from '../../../domain'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's 视图 menu: rulers (Ctrl+R), guides shown (Ctrl+;), the grid
 * (Ctrl+'), and snapping (Ctrl+Shift+;). These are how the person looks at
 * the canvas, kept between sessions on this computer, not part of the
 * picture; the guides themselves are on the canvas and saved with it.
 */

interface ViewState {
  readonly rulers: boolean
  readonly guides: boolean
  readonly grid: boolean
  readonly snap: boolean
  /** Canvas pixels between grid lines, and the parts each is divided into. */
  readonly gridSpacing: number
  readonly gridDivisions: number
  toggle(key: 'rulers' | 'guides' | 'grid' | 'snap'): void
  setGrid(spacing: number, divisions: number): void
}

const STORAGE_KEY = 'ai-canvas.view'

function stored(): Partial<Pick<ViewState, 'rulers' | 'guides' | 'grid' | 'snap' | 'gridSpacing' | 'gridDivisions'>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? {} : JSON.parse(raw) as Partial<ViewState>
  } catch {
    return {}
  }
}

function save(state: ViewState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rulers: state.rulers, guides: state.guides, grid: state.grid, snap: state.snap, gridSpacing: state.gridSpacing, gridDivisions: state.gridDivisions }))
  } catch {
    // Kept for this session only.
  }
}

const initial = stored()

export const useView = create<ViewState>((set, get) => ({
  rulers: initial.rulers ?? false,
  guides: initial.guides ?? true,
  grid: initial.grid ?? false,
  snap: initial.snap ?? true,
  gridSpacing: typeof initial.gridSpacing === 'number' && initial.gridSpacing >= 2 ? initial.gridSpacing : 100,
  gridDivisions: typeof initial.gridDivisions === 'number' && initial.gridDivisions >= 1 ? initial.gridDivisions : 4,
  toggle: (key) => {
    set({ [key]: !get()[key] } as Partial<ViewState>)
    save(get())
  },
  setGrid: (spacing, divisions) => {
    set({ gridSpacing: Math.max(2, Math.min(4096, Math.round(spacing))), gridDivisions: Math.max(1, Math.min(32, Math.round(divisions))) })
    save(get())
  }
}))

/** The lines things snap to along an axis, in canvas pixels: the canvas's edges and middle, the shown guides, and the shown grid near a value. */
export function snapLines(axis: 'x' | 'y', near?: number): number[] {
  const { scene } = useWorkspaceStore.getState()
  const size = axis === 'x' ? scene.canvas.outputWidth : scene.canvas.outputHeight
  const view = useView.getState()
  const lines = [0, size / 2, size]
  if (view.guides) for (const guide of scene.canvas.guides ?? []) if (guide.axis === axis) lines.push(guide.position)
  if (view.grid && near !== undefined) {
    const step = view.gridSpacing / view.gridDivisions
    lines.push(Math.floor(near / step) * step, Math.ceil(near / step) * step)
  }
  return lines
}

/** A value moved onto the nearest snap line within the threshold (canvas pixels), when snapping is on. */
export function snapValue(value: number, axis: 'x' | 'y', threshold: number): number {
  if (!useView.getState().snap) return value
  let best = value
  let distance = threshold
  for (const line of snapLines(axis, value)) {
    const gap = Math.abs(line - value)
    if (gap <= distance) {
      distance = gap
      best = line
    }
  }
  return best
}

/** The guides and grid lines as zero-width boxes, for the snapping that lines up layers' edges and middles. */
export function snapGuideRects(near: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): { x: number; y: number; width: number; height: number }[] {
  const { scene } = useWorkspaceStore.getState()
  const view = useView.getState()
  const width = scene.canvas.outputWidth
  const height = scene.canvas.outputHeight
  const vertical = (x: number) => ({ x, y: 0, width: 0, height })
  const horizontal = (y: number) => ({ x: 0, y, width, height: 0 })
  const out: { x: number; y: number; width: number; height: number }[] = []
  if (view.guides) for (const guide of scene.canvas.guides ?? []) out.push(guide.axis === 'x' ? vertical(guide.position) : horizontal(guide.position))
  if (view.grid) {
    const step = view.gridSpacing / view.gridDivisions
    for (const x of [near.x, near.x + near.width / 2, near.x + near.width]) out.push(vertical(Math.floor(x / step) * step), vertical(Math.ceil(x / step) * step))
    for (const y of [near.y, near.y + near.height / 2, near.y + near.height]) out.push(horizontal(Math.floor(y / step) * step), horizontal(Math.ceil(y / step) * step))
  }
  return out
}

export type { Guide }
