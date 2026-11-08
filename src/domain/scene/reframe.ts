import type { SceneCommand } from '../commands/schema'
import { storedAspect } from './adapt-layout'
import { simplifyAspectRatio } from './aspect-ratio'
import type { Canvas, Guide, Scene, SceneElement } from './schema'

/*
 * Photoshop's crop and 画布大小: the canvas gets a new frame over the
 * picture and every layer stays where it is in pixels. Layers that fall
 * outside are kept, off the canvas (Photoshop's crop without 删除裁剪的像素);
 * guides move with the picture, and locked layers stay locked. An
 * adjustment layer always covers the whole canvas and its mask is in the
 * canvas's pixels, so the mask has to be cut or grown to the new frame: the
 * caller makes those assets and adds their updates (see maskRemaps).
 */

/** The new canvas, in the old canvas's pixels: its top-left corner and its size. */
export interface CanvasFrame {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** An adjustment layer's mask to cut or grow to the frame (grown by repeating its outermost pixels). */
export interface MaskRemap {
  readonly elementId: string
  readonly assetId: string
  /** The old canvas, which the mask asset covers whatever its own size. */
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** The new frame in the old canvas's pixels. */
  readonly frame: CanvasFrame
}

/** The remap's frame in the mask asset's own pixels. */
export function maskFrame(remap: MaskRemap, maskWidth: number, maskHeight: number): CanvasFrame {
  const sx = maskWidth / remap.canvasWidth
  const sy = maskHeight / remap.canvasHeight
  return { left: remap.frame.left * sx, top: remap.frame.top * sy, width: remap.frame.width * sx, height: remap.frame.height * sy }
}

export interface Reframe {
  readonly canvas: Canvas
  readonly commands: readonly SceneCommand[]
  readonly maskRemaps: readonly MaskRemap[]
}

const MIN_SIDE = 64
const MAX_SIDE = 16384

export function clampCanvasSide(value: number): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(value)))
}

/** The canvas in a new frame: its output size is the frame's and its ratio follows. */
export function reframedCanvas(canvas: Canvas, frame: CanvasFrame): Canvas {
  const width = clampCanvasSide(frame.width)
  const height = clampCanvasSide(frame.height)
  const ratio = aspectNear(width, height)
  const guides = (canvas.guides ?? []).map((guide): Guide => ({ axis: guide.axis, position: round(guide.position - (guide.axis === 'x' ? frame.left : frame.top)) }))
  return {
    ...canvas,
    aspectWidth: ratio.width,
    aspectHeight: ratio.height,
    outputWidth: width,
    outputHeight: height,
    ...(canvas.guides === undefined ? {} : { guides })
  }
}

/** The ratio closest to width:height with both terms at most 100, as the canvas stores it (past 100:1 either way, 100:1 or 1:100). */
export function aspectNear(width: number, height: number): { readonly width: number; readonly height: number } {
  const stored = storedAspect(width, height)
  return simplifyAspectRatio(stored.aspectWidth, stored.aspectHeight)
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function moved(element: SceneElement, from: Canvas, to: { readonly width: number; readonly height: number }, frame: CanvasFrame): SceneElement['transform'] {
  const t = element.transform
  return {
    x: round((t.x * from.outputWidth - frame.left) / to.width),
    y: round((t.y * from.outputHeight - frame.top) / to.height),
    width: round(t.width * from.outputWidth / to.width),
    height: round(t.height * from.outputHeight / to.height),
    rotation: t.rotation
  }
}

/**
 * The commands that put the scene in a new frame, in one batch, and the
 * adjustment masks the caller must remap before running them.
 */
export function reframeScene(scene: Scene, frame: CanvasFrame): Reframe {
  const canvas = reframedCanvas(scene.canvas, frame)
  const size = { width: canvas.outputWidth, height: canvas.outputHeight }
  // The frame as it will be, after the size is rounded and clamped.
  const exact: CanvasFrame = { left: frame.left, top: frame.top, width: size.width, height: size.height }
  const commands: SceneCommand[] = [{ kind: 'scene.set-canvas', canvas }]
  const maskRemaps: MaskRemap[] = []
  for (const element of scene.elements) {
    if (element.type === 'adjustment') {
      const mask = element.mask
      if (mask !== null && mask !== undefined) {
        maskRemaps.push({ elementId: element.id, assetId: mask.assetId, canvasWidth: scene.canvas.outputWidth, canvasHeight: scene.canvas.outputHeight, frame: exact })
      }
      continue
    }
    // A mask's outline is in its own box, which moves with it.
    const update: SceneCommand = { kind: 'element.update', elementId: element.id, changes: { transform: moved(element, scene.canvas, size, exact) } }
    // A locked layer keeps its lock: unlocked for the move and locked again, in the same step.
    if (element.locked) {
      commands.push({ kind: 'element.update', elementId: element.id, changes: { locked: false } }, update, { kind: 'element.update', elementId: element.id, changes: { locked: true } })
    } else {
      commands.push(update)
    }
  }
  return { canvas, commands, maskRemaps }
}

/** Where an anchor puts the old canvas in a new one of this size: Photoshop's 画布大小 定位. */
export type CanvasAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'

export const CANVAS_ANCHORS: readonly CanvasAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']

export function anchoredFrame(canvas: Pick<Canvas, 'outputWidth' | 'outputHeight'>, width: number, height: number, anchor: CanvasAnchor): CanvasFrame {
  const column = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 1 : 0.5
  const row = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5
  const w = clampCanvasSide(width)
  const h = clampCanvasSide(height)
  // + 0 turns a -0 from a zero share into 0.
  return { left: Math.round((canvas.outputWidth - w) * column) + 0, top: Math.round((canvas.outputHeight - h) * row) + 0, width: w, height: h }
}

/**
 * A gray mask (one byte a pixel) cut or grown to a frame, with the frame in
 * the mask's own pixels. Outside the mask its outermost pixels repeat, so a
 * mask that shows the adjustment at its edges goes on showing it.
 */
export function remapGrayMask(data: Uint8Array | Uint8ClampedArray, width: number, height: number, frame: CanvasFrame, outWidth: number, outHeight: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(outWidth * outHeight)
  const scaleX = frame.width / outWidth
  const scaleY = frame.height / outHeight
  for (let y = 0; y < outHeight; y += 1) {
    const sy = Math.max(0, Math.min(height - 1, Math.floor(frame.top + (y + 0.5) * scaleY)))
    for (let x = 0; x < outWidth; x += 1) {
      const sx = Math.max(0, Math.min(width - 1, Math.floor(frame.left + (x + 0.5) * scaleX)))
      out[y * outWidth + x] = data[sy * width + sx]!
    }
  }
  return out
}
