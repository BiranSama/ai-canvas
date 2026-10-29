import { createMask, featherMask, invertMask } from '../../../shared/mask-raster'
import { useWorkspaceStore } from '../store/workspace-store'
import { currentSelection, reselect, setSelectionMask } from './selection-store'

/*
 * Photoshop's Select menu: Ctrl+A, Ctrl+D, Ctrl+Shift+D, Ctrl+Shift+I and
 * Shift+F6. Each is one history step.
 */

function canvasSize(): { readonly width: number; readonly height: number } {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return { width: outputWidth, height: outputHeight }
}

export function selectAll(): void {
  const { width, height } = canvasSize()
  setSelectionMask(createMask(width, height, 255))
}

/** Ctrl+D: drops the selection; false when there was none, so the key can deselect layers instead. */
export function deselect(): boolean {
  if (currentSelection() === null) return false
  setSelectionMask(null)
  return true
}

export function reselectLast(): boolean {
  return reselect()
}

/** Ctrl+Shift+I: everything that was not selected; with nothing selected, Photoshop does nothing. */
export function inverseSelection(): boolean {
  const mask = currentSelection()
  if (mask === null) return false
  setSelectionMask(invertMask(mask))
  return true
}

export function featherSelection(radius: number): boolean {
  const mask = currentSelection()
  if (mask === null || radius <= 0) return false
  setSelectionMask(featherMask(mask, radius))
  return true
}
