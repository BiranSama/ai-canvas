import { create } from 'zustand'
import { decodeMask, encodeMask, isMaskEmpty, type GrayMask, type MaskCombine } from '../../../shared/mask-raster'
import { noteSelectionStep, registerSelectionHistory, useWorkspaceStore } from '../store/workspace-store'

/*
 * The pixel selection, as in Photoshop: a grayscale mask the size of the
 * canvas, 0 outside to 255 inside, or null when nothing is selected. It is
 * not saved with the project. Every change is a history step that Ctrl+Z
 * reaches in turn with the scene's own steps; old selections are kept
 * run-length encoded, which a selection of a few shapes shrinks to little.
 */

export interface SelectionSettings {
  /** The options bar's mode; Shift, Alt and both pick add, subtract and intersect for one gesture. */
  readonly mode: MaskCombine
  /** Feather for new marquee and lasso shapes, in canvas pixels. */
  readonly feather: number
  readonly antialias: boolean
  readonly wandTolerance: number
  readonly wandContiguous: boolean
  /** The magic wand and object selection read the whole picture, or only the selected layer. */
  readonly sampleAllLayers: boolean
}

export const DEFAULT_SELECTION_SETTINGS: SelectionSettings = {
  mode: 'replace',
  feather: 0,
  antialias: true,
  wandTolerance: 32,
  wandContiguous: true,
  sampleAllLayers: true
}

interface SelectionState {
  readonly mask: GrayMask | null
  /** Counts every change, for whatever is drawn from the selection. */
  readonly version: number
  readonly settings: SelectionSettings
  setSettings(changes: Partial<SelectionSettings>): void
}

export const useSelectionStore = create<SelectionState>()((set) => ({
  mask: null,
  version: 0,
  settings: DEFAULT_SELECTION_SETTINGS,
  setSettings: (changes) => set((state) => ({ settings: { ...state.settings, ...changes } }))
}))

interface Snapshot {
  readonly width: number
  readonly height: number
  readonly runs: Uint32Array | null
}

const MAX_SELECTION_STEPS = 60
const undoStack: { readonly before: Snapshot; readonly after: Snapshot }[] = []
const redoStack: { readonly before: Snapshot; readonly after: Snapshot }[] = []
/** The last selection that was dropped, for Ctrl+Shift+D. */
let lastDropped: Snapshot | null = null

function snapshot(mask: GrayMask | null): Snapshot {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return mask === null ? { width: outputWidth, height: outputHeight, runs: null } : { width: mask.width, height: mask.height, runs: encodeMask(mask) }
}

function restore(state: Snapshot): GrayMask | null {
  return state.runs === null ? null : decodeMask(state.width, state.height, state.runs)
}

function apply(mask: GrayMask | null): void {
  useSelectionStore.setState((state) => ({ mask, version: state.version + 1 }))
}

export function currentSelection(): GrayMask | null {
  return useSelectionStore.getState().mask
}

export function hasSelection(): boolean {
  return useSelectionStore.getState().mask !== null
}

/**
 * Sets the selection as one history step. An empty mask means nothing
 * selected. Unchanged selections add no step.
 */
export function setSelectionMask(next: GrayMask | null): void {
  const mask = next === null || isMaskEmpty(next) ? null : next
  const previous = useSelectionStore.getState().mask
  if (mask === null && previous === null) return
  const before = snapshot(previous)
  const after = snapshot(mask)
  if (previous !== null && mask === null) lastDropped = before
  undoStack.push({ before, after })
  if (undoStack.length > MAX_SELECTION_STEPS) undoStack.shift()
  redoStack.length = 0
  apply(mask)
  noteSelectionStep()
}

/** Photoshop's Ctrl+Shift+D: the selection dropped last, back. */
export function reselect(): boolean {
  if (lastDropped === null || lastDropped.runs === null || useSelectionStore.getState().mask !== null) return false
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  if (lastDropped.width !== outputWidth || lastDropped.height !== outputHeight) return false
  setSelectionMask(restore(lastDropped))
  return true
}

registerSelectionHistory({
  undo: () => {
    const step = undoStack.pop()
    if (step === undefined) return false
    redoStack.push(step)
    const current = useSelectionStore.getState().mask
    if (current !== null && step.before.runs === null) lastDropped = step.after
    apply(restore(step.before))
    return true
  },
  redo: () => {
    const step = redoStack.pop()
    if (step === undefined) return false
    undoStack.push(step)
    apply(restore(step.after))
    return true
  }
})

/** Another project or another canvas size: the selection and its steps no longer apply. */
function forget(): void {
  undoStack.length = 0
  redoStack.length = 0
  lastDropped = null
  if (useSelectionStore.getState().mask !== null) apply(null)
}

let watched = (() => {
  const { scene } = useWorkspaceStore.getState()
  return { projectId: scene.projectId, width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
})()
useWorkspaceStore.subscribe((state) => {
  const next = { projectId: state.scene.projectId, width: state.scene.canvas.outputWidth, height: state.scene.canvas.outputHeight }
  if (next.projectId === watched.projectId && next.width === watched.width && next.height === watched.height) return
  watched = next
  forget()
})

/*
 * What a selection tool is drawing right now, for the marching ants to
 * show before it becomes the selection: a shape in canvas pixels, and how
 * far the selection is being dragged. Kept out of React so a drag redraws
 * only the ants.
 */
export type SelectionDraft =
  | { readonly kind: 'rect' | 'ellipse'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: 'polygon'; readonly points: readonly number[]; readonly closed: boolean; readonly cursor: readonly [number, number] | null }

let draft: SelectionDraft | null = null
let moveOffset: { readonly dx: number; readonly dy: number } | null = null
const draftListeners = new Set<() => void>()

export function selectionDraft(): SelectionDraft | null {
  return draft
}

export function selectionMoveOffset(): { readonly dx: number; readonly dy: number } | null {
  return moveOffset
}

export function setSelectionDraft(next: SelectionDraft | null, offset: { readonly dx: number; readonly dy: number } | null = null): void {
  draft = next
  moveOffset = offset
  for (const listener of draftListeners) listener()
}

export function subscribeSelectionDraft(listener: () => void): () => void {
  draftListeners.add(listener)
  return () => draftListeners.delete(listener)
}
