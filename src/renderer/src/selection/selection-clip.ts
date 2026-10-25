import type { SceneElement } from '../../../domain'
import { maskInLayerSpace, type LayerSpace } from '../../../shared/layer-space'
import { rememberGrayAsset } from '../canvas/asset-pixels'
import { useWorkspaceStore } from '../store/workspace-store'
import { useSelectionStore } from './selection-store'

/*
 * The selection read into the pixels an operation paints, Photoshop's
 * painting within a selection. Each operation records the clip it was
 * limited to as a grayscale asset; one asset serves every operation in the
 * same selection on the same layer, so a hundred strokes store one image.
 */

export type SelectionClip =
  /** Nothing is selected: the operation paints everywhere. */
  | { readonly kind: 'none' }
  /** The selection misses the layer: nothing would change. */
  | { readonly kind: 'outside' }
  /** The pixels for the live operation now, and the asset its record names once imported. */
  | { readonly kind: 'clip'; readonly pixels: Uint8Array<ArrayBuffer>; readonly assetId: Promise<string | null> }

const NONE: SelectionClip = { kind: 'none' }
const OUTSIDE: SelectionClip = { kind: 'outside' }
const MAX_KEPT = 8
const kept = new Map<string, SelectionClip>()

/** spaceKey names the pixels the operation paints (the layer's, or its mask's), so one layer's two spaces keep apart. */
export function selectionClip(element: SceneElement, space: LayerSpace, spaceKey: string): SelectionClip {
  const { mask, version } = useSelectionStore.getState()
  if (mask === null) return NONE
  const transform = element.transform
  const placement = element.type === 'image' ? `${element.crop.x},${element.crop.y},${element.crop.width},${element.crop.height},${element.fit}` : ''
  const key = `${version}|${element.id}|${spaceKey}|${space.width}x${space.height}|${transform.x},${transform.y},${transform.width},${transform.height},${transform.rotation}|${placement}`
  const found = kept.get(key)
  if (found !== undefined) return found
  const pixels = maskInLayerSpace(mask, space)
  let any = false
  let all = true
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index]!
    if (value !== 0) any = true
    if (value !== 255) all = false
    if (any && !all) break
  }
  let clip: SelectionClip
  if (!any) clip = OUTSIDE
  else if (all) clip = NONE
  else {
    const projectId = useWorkspaceStore.getState().scene.projectId
    const assetId = window.desktop.importPixels({ projectId, name: '选区.png', width: space.width, height: space.height, gray: pixels })
      .then((asset) => {
        rememberGrayAsset(asset.id, { width: space.width, height: space.height, data: pixels })
        return asset.id
      })
      .catch(() => null)
    clip = { kind: 'clip', pixels, assetId }
  }
  kept.set(key, clip)
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!)
  return clip
}
