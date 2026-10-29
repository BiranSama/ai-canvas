import type { SceneElement } from '../domain'

/**
 * Every asset a layer draws from: its image, the clips its paint records,
 * its mask and the mask's clips, and a text layer's rendered result.
 */
export function elementAssetIds(element: SceneElement): string[] {
  const ids: string[] = []
  if (element.type === 'image') {
    ids.push(element.assetId)
    for (const op of element.paint ?? []) if (op.clip !== undefined) ids.push(op.clip)
  }
  if (element.type === 'image' || element.type === 'text' || element.type === 'shape') {
    const mask = element.mask
    if (mask !== null && mask !== undefined) {
      ids.push(mask.assetId)
      for (const op of mask.paint ?? []) if (op.clip !== undefined) ids.push(op.clip)
    }
  }
  return ids
}
