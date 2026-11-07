import type { AdjustmentSettings, BlendMode } from '../domain'

/** One pixel layer of a PSD, as a PNG of its own bounds, in document pixels. */
export interface PsdLayerImport {
  readonly kind: 'pixels'
  readonly name: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  /** Its own opacity times its group's. */
  readonly opacity: number
  /** Hidden when it or its group is hidden. */
  readonly visible: boolean
  readonly blendMode: BlendMode
  /** Index into PsdDocumentImport.groups, or null outside any group. */
  readonly groupIndex: number | null
  readonly png: Uint8Array<ArrayBuffer>
  /** Its layer mask over the layer's own pixels, as a grayscale PNG, or null without one. */
  readonly mask: { readonly png: Uint8Array<ArrayBuffer>; readonly enabled: boolean } | null
  /** Adjustment layers clipped to it in Photoshop, which change it alone: its own adjustments here, bottom first. */
  readonly adjustments: readonly { readonly settings: AdjustmentSettings; readonly enabled: boolean }[]
}

/** One of Photoshop's adjustment layers that the canvas has, changing everything below it. */
export interface PsdAdjustmentImport {
  readonly kind: 'adjustment'
  readonly name: string
  readonly opacity: number
  readonly visible: boolean
  readonly groupIndex: number | null
  readonly settings: AdjustmentSettings
  /** Its mask over the whole canvas (scaled down for very large documents), as a grayscale PNG, or null without one. */
  readonly mask: { readonly png: Uint8Array<ArrayBuffer>; readonly enabled: boolean } | null
}

export interface PsdGroupImport {
  readonly name: string
  readonly visible: boolean
}

export interface PsdDocumentImport {
  readonly width: number
  readonly height: number
  /** Bottom of the stack first. */
  readonly layers: readonly (PsdLayerImport | PsdAdjustmentImport)[]
  readonly groups: readonly PsdGroupImport[]
  /** Photoshop's own flattened image, only when something could not be carried over as it was. */
  readonly composite: Uint8Array<ArrayBuffer> | null
  /** What changed in the carrying over, for the person to know. */
  readonly approximations: readonly string[]
  /** What was kept, but as a picture rather than as something editable. */
  readonly keptAsPictures: readonly string[]
  /** The bottom layer covers the canvas with no transparency, as Photoshop's 背景 does. */
  readonly opaqueBackground: boolean
}
