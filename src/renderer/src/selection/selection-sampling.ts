import type { SceneElement } from '../../../domain'
import { renderLayersAsDrawn } from '../canvas/layer-render'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * The pixels the magic wand and the object selection read: the picture as
 * shown, background included, or only the selected layer as drawn on the
 * canvas, at the canvas's size. Kept while the scene stays the same, so a
 * second click is quick.
 */

export interface SampledPixels {
  readonly width: number
  readonly height: number
  /** Straight RGBA, row by row. */
  readonly rgba: Uint8ClampedArray
}

function isPicture(element: SceneElement): boolean {
  return element.type === 'image' || element.type === 'text' || (element.type === 'shape' && element.role === 'final')
}

/** What the picture as shown is made of: the picture layers, and sketches kept in the final picture; editing marks are not. */
function inPicture(element: SceneElement): boolean {
  return isPicture(element) || element.type === 'adjustment' || (element.type === 'sketch' && element.finalVisible)
}

let cached: { readonly key: string; readonly pixels: SampledPixels } | null = null

/** The single selected picture layer, which a layer-only sample reads. */
export function sampledLayer(): SceneElement | null {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  if (selectedIds.length !== 1) return null
  const element = scene.elements.find((candidate) => candidate.id === selectedIds[0])
  return element !== undefined && isPicture(element) ? element : null
}

export async function samplePixels(allLayers: boolean): Promise<SampledPixels | null> {
  const { scene } = useWorkspaceStore.getState()
  const layer = allLayers ? null : sampledLayer()
  const ids = layer === null
    ? scene.elements.filter((element) => element.visible && inPicture(element)).map((element) => element.id)
    : [layer.id]
  const key = `${scene.projectId}:${scene.revision}:${layer?.id ?? '*'}`
  if (cached?.key === key) return cached.pixels
  // The whole picture includes its background, as Photoshop's background layer is part of it, drawn first so adjustment layers change it too.
  const drawn = await renderLayersAsDrawn(ids, layer === null ? { canvasBackground: true } : { base: layer.id, showHidden: true })
  if (drawn === null) return null
  const context = drawn.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  const pixels = { width: drawn.width, height: drawn.height, rgba: context.getImageData(0, 0, drawn.width, drawn.height).data }
  cached = { key, pixels }
  return pixels
}
