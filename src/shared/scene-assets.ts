import type { SceneElement } from '../domain'

/**
 * Every asset a layer draws from: its image, the clips its paint and
 * adjustments record, its mask and the mask's clips.
 */
export function elementAssetIds(element: SceneElement): string[] {
  const ids: string[] = []
  if (element.type === 'image') {
    ids.push(element.assetId)
    for (const op of element.paint ?? []) if (op.clip !== undefined) ids.push(op.clip)
    for (const adjustment of element.adjustments ?? []) if (adjustment.clip !== undefined) ids.push(adjustment.clip)
  }
  if (element.type === 'image' || element.type === 'text' || element.type === 'shape' || element.type === 'adjustment') {
    const mask = element.mask
    if (mask !== null && mask !== undefined) {
      ids.push(mask.assetId)
      for (const op of mask.paint ?? []) if (op.clip !== undefined) ids.push(op.clip)
    }
  }
  return ids
}
