import { useWorkspaceStore } from '../store/workspace-store'
import { ArtworkSession } from './artwork-render'

/*
 * Layers drawn as they look, at the canvas's output size and, unless asked,
 * without the canvas colour behind them, for merging, rasterizing and sampling: what the
 * layers look like is what the new pixels hold. They are drawn by the
 * export renderer, so images with effects or adjustments come out at full
 * size, not at the size the screen happens to show them.
 */

export interface LayerRenderOptions {
  /** A layer drawn at full opacity and normal blend, because the result keeps its opacity and blend (Photoshop's merge down). */
  readonly base?: string
  /** Draw these layers even when they are hidden. */
  readonly showHidden?: boolean
  /** Draw the canvas colour first, as part of the picture, so adjustment layers change it as they do on the canvas. */
  readonly canvasBackground?: boolean
  /** Draw this part of the document, in canvas pixels, past the canvas edge too; the whole canvas otherwise. */
  readonly area?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/**
 * Draws the layers once everything they need has been read, so a stand-in
 * never ends up in the pixels; null when they cannot be drawn.
 */
export async function renderLayersAsDrawn(ids: readonly string[], options: LayerRenderOptions = {}): Promise<HTMLCanvasElement | null> {
  const { scene } = useWorkspaceStore.getState()
  let session: ArtworkSession | null = null
  try {
    session = await ArtworkSession.prepare(scene, undefined, { includeHidden: options.showHidden === true, only: ids })
    return session.render({
      width: scene.canvas.outputWidth,
      height: scene.canvas.outputHeight,
      background: options.canvasBackground === true ? 'canvas' : 'none',
      ...(options.area === undefined ? {} : { area: options.area }),
      layers: { ids, ...(options.base === undefined ? {} : { base: options.base }), ...(options.showHidden === undefined ? {} : { showHidden: options.showHidden }) }
    })
  } catch {
    return null
  } finally {
    session?.dispose()
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
