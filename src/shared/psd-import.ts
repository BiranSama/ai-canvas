import type { BlendMode } from '../domain'

/** One pixel layer of a PSD, as a PNG of its own bounds, in document pixels. */
export interface PsdLayerImport {
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
}

export interface PsdGroupImport {
  readonly name: string
  readonly visible: boolean
}

export interface PsdDocumentImport {
  readonly width: number
  readonly height: number
  /** Bottom of the stack first. */
  readonly layers: readonly PsdLayerImport[]
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
