export interface ImageSize {
  readonly width: number
  readonly height: number
}

export interface FreeSizeRule {
  /** Both edges are rounded to this multiple. */
  readonly multipleOf: number
  readonly minPixels: number
  readonly maxPixels: number
  readonly maxEdge?: number
  readonly minEdge?: number
  /** Long edge divided by short edge. */
  readonly maxAspect: number
}

export function formatImageSize(size: ImageSize): string {
  return `${size.width}x${size.height}`
}

/**
 * Fits a requested size into a provider's free-size rule while keeping its
 * aspect ratio as closely as the rule allows. A size that already satisfies the
 * rule is only rounded to the required multiple.
 */
export function fitFreeImageSize(requested: ImageSize, aspect: ImageSize, rule: FreeSizeRule): ImageSize {
  const rawRatio = aspect.width > 0 && aspect.height > 0 ? aspect.width / aspect.height : requested.width / requested.height
  const ratio = Math.min(rule.maxAspect, Math.max(1 / rule.maxAspect, rawRatio))
  const requestedPixels = Math.max(1, requested.width * requested.height)
  const pixels = Math.min(rule.maxPixels, Math.max(rule.minPixels, requestedPixels))
  let width = Math.sqrt(pixels * ratio)
  let height = width / ratio
  const longEdge = Math.max(width, height)
  if (rule.maxEdge !== undefined && longEdge > rule.maxEdge) {
    const scale = rule.maxEdge / longEdge
    width *= scale
    height *= scale
  }
  const step = rule.multipleOf
  let fittedWidth = Math.max(step, Math.round(width / step) * step)
  let fittedHeight = Math.max(step, Math.round(height / step) * step)
  if (rule.minEdge !== undefined) {
    fittedWidth = Math.max(fittedWidth, Math.ceil(rule.minEdge / step) * step)
    fittedHeight = Math.max(fittedHeight, Math.ceil(rule.minEdge / step) * step)
  }
  if (rule.maxEdge !== undefined) {
    fittedWidth = Math.min(fittedWidth, Math.floor(rule.maxEdge / step) * step)
    fittedHeight = Math.min(fittedHeight, Math.floor(rule.maxEdge / step) * step)
  }
  // Rounding can step just outside the aspect limit or the pixel range; walk
  // the edges back in, one grid step at a time.
  while (Math.max(fittedWidth, fittedHeight) / Math.min(fittedWidth, fittedHeight) > rule.maxAspect) {
    if (fittedWidth > fittedHeight) fittedWidth -= step
    else fittedHeight -= step
  }
  while (fittedWidth * fittedHeight > rule.maxPixels) {
    if (fittedWidth >= fittedHeight) fittedWidth -= step
    else fittedHeight -= step
  }
  while (fittedWidth * fittedHeight < rule.minPixels) {
    if (fittedWidth <= fittedHeight) fittedWidth += step
    else fittedHeight += step
  }
  return { width: fittedWidth, height: fittedHeight }
}

/** Picks the preset whose aspect ratio is closest to the requested one. */
export function nearestPresetSize(aspect: ImageSize, presets: readonly ImageSize[]): ImageSize {
  const target = Math.log(aspect.width / aspect.height)
  let best = presets[0]
  if (best === undefined) throw new Error('A preset size list cannot be empty.')
  for (const preset of presets) {
    if (Math.abs(Math.log(preset.width / preset.height) - target) < Math.abs(Math.log(best.width / best.height) - target)) best = preset
  }
  return best
}
