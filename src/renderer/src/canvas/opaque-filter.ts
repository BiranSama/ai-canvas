import type { FilterFunction } from 'konva/lib/Node'

/**
 * A filter for a cached group: every pixel the group covers at all becomes
 * opaque, keeping its colour. A clipping stack is worked out over its base
 * made opaque this way and cut back to the base's coverage at the end, so
 * what is clipped to the base keeps the base's transparency (Photoshop's
 * clipping, W3C source-atop) instead of adding to it.
 */
export const opaqueWhereCovered: FilterFunction = (image) => {
  const data = image.data
  for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) data[index] = 255
}
