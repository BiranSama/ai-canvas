import { create } from 'zustand'
import type { AdjustmentSettings, LayerAdjustment, SceneElement } from '../../../domain'

/*
 * An adjustment being changed but not yet recorded: a dialog open on an
 * image layer, or a slider being dragged on an adjustment layer. The canvas
 * draws it at once; only 确定 or letting go of the slider records a step.
 */

export type AdjustmentPreview =
  /** One of an image layer's own adjustments, or a new one (not yet in its list) with the selection it is limited to. */
  | {
      readonly kind: 'layer'
      readonly elementId: string
      readonly adjustment: LayerAdjustment
      /** Off while the dialog's 预览 is unticked: the layer is shown without this adjustment. */
      readonly shown: boolean
      /** The selection a new adjustment is limited to, in the layer's pixels, until its asset is known. */
      readonly clip: { readonly id: string; readonly pixels: Uint8Array } | null
    }
  /** An adjustment layer's settings. */
  | { readonly kind: 'adjustment-layer'; readonly elementId: string; readonly settings: AdjustmentSettings }

interface AdjustmentPreviewState {
  readonly preview: AdjustmentPreview | null
  show(preview: AdjustmentPreview): void
  clear(elementId?: string): void
}

export const useAdjustmentPreview = create<AdjustmentPreviewState>()((set) => ({
  preview: null,
  show: (preview) => set({ preview }),
  clear: (elementId) => set((state) => elementId === undefined || state.preview?.elementId === elementId ? { preview: null } : state)
}))

type ImageElement = Extract<SceneElement, { type: 'image' }>

/** The image layer as it is shown with the preview: the adjustment changed, added, or left out. */
export function withLayerPreview(element: ImageElement, preview: AdjustmentPreview | null): ImageElement {
  if (preview?.kind !== 'layer' || preview.elementId !== element.id) return element
  const list = element.adjustments ?? []
  const index = list.findIndex((adjustment) => adjustment.id === preview.adjustment.id)
  const next = !preview.shown
    ? list.filter((adjustment) => adjustment.id !== preview.adjustment.id)
    : index < 0 ? [...list, preview.adjustment] : list.map((adjustment, at) => at === index ? preview.adjustment : adjustment)
  return { ...element, adjustments: next }
}

/** The adjustment layer's settings as shown. */
export function adjustmentLayerSettings(element: Extract<SceneElement, { type: 'adjustment' }>, preview: AdjustmentPreview | null): AdjustmentSettings {
  return preview?.kind === 'adjustment-layer' && preview.elementId === element.id ? preview.settings : element.settings
}
