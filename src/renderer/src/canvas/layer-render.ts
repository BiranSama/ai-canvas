/*
 * Layers drawn exactly as the stage shows them, at the canvas's output
 * size and without the artboard behind them, for merging and rasterizing:
 * what the layers look like on screen is what the new pixels hold. The
 * stage registers the drawing while it is mounted.
 */

export interface LayerRenderOptions {
  /** A layer drawn at full opacity and normal blend, because the result keeps its opacity and blend (Photoshop's merge down). */
  readonly base?: string
  /** Draw these layers even when they are hidden. */
  readonly showHidden?: boolean
}

/** The drawn layers, 'pending' while one of their pictures is still loading, or null without a stage. */
export type LayerRenderer = (ids: readonly string[], options: LayerRenderOptions) => HTMLCanvasElement | 'pending' | null

let renderer: LayerRenderer | null = null

export function setLayerRenderer(next: LayerRenderer | null): void {
  renderer = next
}

const PENDING_WAIT_MS = 8000

/** Draws the layers once every picture among them has loaded, so a stand-in never ends up in the pixels. */
export async function renderLayersAsDrawn(ids: readonly string[], options: LayerRenderOptions = {}): Promise<HTMLCanvasElement | null> {
  const deadline = performance.now() + PENDING_WAIT_MS
  for (;;) {
    const drawn = renderer?.(ids, options) ?? null
    if (drawn !== 'pending') return drawn
    if (performance.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The smallest rectangle holding every pixel that is not fully transparent, or null for an empty picture. */
export function opaqueBounds(canvas: HTMLCanvasElement): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      bottom = y
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}
