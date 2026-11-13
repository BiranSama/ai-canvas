import { applyMatrix, boxWarpMatrix, cornersAreIdentity, invertMatrix, multiplyMatrices, type Corners, type Matrix3, type SceneElement } from '../domain'
import type { GrayMask } from './mask-raster'

/*
 * Where a layer's own pixels sit on the canvas, so a selection drawn on the
 * canvas can become a clip or a mask in those pixels. An image layer's
 * pixels are its asset's, placed through its crop and fit; a text or shape
 * layer's mask stretches over its box. Layers rotate about their top-left
 * corner, as the canvas draws them, after their free-transform corners,
 * which can make the map projective.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>

export interface Size {
  readonly width: number
  readonly height: number
}

/** Where the cropped image lands in a box of this size, by its fit; cover overflows the box and is clipped. */
export function imageDrawRect(image: Size, element: Pick<ImageElement, 'crop' | 'fit'>, width: number, height: number) {
  const crop = {
    x: image.width * element.crop.x,
    y: image.height * element.crop.y,
    width: image.width * element.crop.width,
    height: image.height * element.crop.height
  }
  const sourceRatio = crop.width / crop.height
  const targetRatio = width / height
  let draw = { x: 0, y: 0, width, height }
  if (element.fit !== 'fill') {
    const contain = element.fit === 'contain'
    const useWidth = contain ? sourceRatio > targetRatio : sourceRatio < targetRatio
    draw = useWidth
      ? { x: 0, y: (height - width / sourceRatio) / 2, width, height: width / sourceRatio }
      : { x: (width - height * sourceRatio) / 2, y: 0, width: height * sourceRatio, height }
  }
  return { crop, draw }
}

export interface LayerSpace extends Size {
  /** A point in the layer's pixels (pixel centres at +0.5) as a point on the canvas, in canvas pixels. */
  toCanvas(x: number, y: number): readonly [number, number]
  /** The same map as a matrix, when it is known: projective after a distort or a perspective. */
  readonly matrix?: Matrix3
}

function layerCornersOf(element: SceneElement): Corners | null {
  const corners = element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.corners : null
  return cornersAreIdentity(corners) ? null : corners!
}

/** The layer's pixels → its box (local) → through its corners → turned and placed on the canvas. */
function placedMatrix(element: SceneElement, canvas: Size, local: Matrix3): Matrix3 {
  const originX = element.transform.x * canvas.width
  const originY = element.transform.y * canvas.height
  const angle = element.transform.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const turn: Matrix3 = [cos, -sin, originX, sin, cos, originY, 0, 0, 1]
  const corners = layerCornersOf(element)
  const warped = corners === null ? local : multiplyMatrices(boxWarpMatrix(corners, element.transform.width * canvas.width, element.transform.height * canvas.height), local)
  return multiplyMatrices(turn, warped)
}

function spaceOf(width: number, height: number, matrix: Matrix3): LayerSpace {
  return { width, height, matrix, toCanvas: (x, y) => applyMatrix(matrix, x, y) }
}

/** An image layer's own pixels on the canvas. */
export function imageLayerSpace(element: ImageElement, image: Size, canvas: Size): LayerSpace {
  const boxWidth = element.transform.width * canvas.width
  const boxHeight = element.transform.height * canvas.height
  const { crop, draw } = imageDrawRect(image, element, boxWidth, boxHeight)
  const scaleX = draw.width / crop.width
  const scaleY = draw.height / crop.height
  return spaceOf(image.width, image.height, placedMatrix(element, canvas, [scaleX, 0, draw.x - crop.x * scaleX, 0, scaleY, draw.y - crop.y * scaleY, 0, 0, 1]))
}

/** A mask of this size stretched over the layer's box (text and shapes). */
export function boxLayerSpace(element: SceneElement, mask: Size, canvas: Size): LayerSpace {
  const sx = element.transform.width * canvas.width / mask.width
  const sy = element.transform.height * canvas.height / mask.height
  return spaceOf(mask.width, mask.height, placedMatrix(element, canvas, [sx, 0, 0, 0, sy, 0, 0, 0, 1]))
}

/** Whether the map is projective, so it cannot be stepped along a row as an affine one is. */
function projective(space: LayerSpace): boolean {
  const matrix = space.matrix
  return matrix !== undefined && (Math.abs(matrix[6]) > 1e-12 || Math.abs(matrix[7]) > 1e-12)
}

/** Bilinear read of a gray image at a point whose integer parts index pixel centres; nothing outside. */
function sampleGray(data: ArrayLike<number>, width: number, height: number, fx: number, fy: number): number {
  if (fx <= -1 || fy <= -1 || fx >= width || fy >= height) return 0
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const inX0 = x0 >= 0
  const inX1 = x0 + 1 < width
  const inY0 = y0 >= 0
  const inY1 = y0 + 1 < height
  const top = inY0 ? (inX0 ? data[y0 * width + x0]! : 0) * (1 - tx) + (inX1 ? data[y0 * width + x0 + 1]! : 0) * tx : 0
  const bottom = inY1 ? (inX0 ? data[(y0 + 1) * width + x0]! : 0) * (1 - tx) + (inX1 ? data[(y0 + 1) * width + x0 + 1]! : 0) * tx : 0
  return Math.round(top * (1 - ty) + bottom * ty)
}

/** A canvas mask read into the pixels of a layer whose map is projective, one pixel at a time. */
function maskThroughHomography(mask: GrayMask, space: LayerSpace, matrix: Matrix3): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(space.width * space.height)
  for (let y = 0; y < space.height; y += 1) {
    for (let x = 0; x < space.width; x += 1) {
      const [cx, cy] = applyMatrix(matrix, x + 0.5, y + 0.5)
      out[y * space.width + x] = sampleGray(mask.data, mask.width, mask.height, cx - 0.5, cy - 0.5)
    }
  }
  return out
}

/** The size a new mask for a text or shape layer gets: its box in canvas pixels, at most 4096 a side. */
export function boxMaskSize(element: SceneElement, canvas: Size): Size {
  const width = Math.max(1, element.transform.width * canvas.width)
  const height = Math.max(1, element.transform.height * canvas.height)
  const scale = Math.min(1, 4096 / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * A canvas-size mask (a selection) read into a layer's pixels, sampled
 * bilinearly. The mapping is affine, so each row steps along it; a layer
 * that covers the canvas pixel for pixel is a straight copy.
 */
export function maskInLayerSpace(mask: GrayMask, space: LayerSpace): Uint8Array<ArrayBuffer> {
  if (projective(space)) return maskThroughHomography(mask, space, space.matrix!)
  const out = new Uint8Array(space.width * space.height)
  const [ox, oy] = space.toCanvas(0, 0)
  const [ax, ay] = space.toCanvas(1, 0)
  const [bx, by] = space.toCanvas(0, 1)
  const ux = ax - ox
  const uy = ay - oy
  const vx = bx - ox
  const vy = by - oy
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
  if (near(ux, 1) && near(uy, 0) && near(vx, 0) && near(vy, 1) && near(ox, Math.round(ox)) && near(oy, Math.round(oy))) {
    const left = Math.round(ox)
    const top = Math.round(oy)
    for (let y = 0; y < space.height; y += 1) {
      const cy = y + top
      if (cy < 0 || cy >= mask.height) continue
      for (let x = 0; x < space.width; x += 1) {
        const cx = x + left
        if (cx >= 0 && cx < mask.width) out[y * space.width + x] = mask.data[cy * mask.width + cx]!
      }
    }
    return out
  }
  const { width, height, data } = mask
  for (let y = 0; y < space.height; y += 1) {
    // The centre of the row's first pixel, less half a canvas pixel, so the integer parts index pixel centres.
    let fx = ox + (y + 0.5) * vx + 0.5 * ux - 0.5
    let fy = oy + (y + 0.5) * vy + 0.5 * uy - 0.5
    const row = y * space.width
    for (let x = 0; x < space.width; x += 1, fx += ux, fy += uy) {
      if (fx <= -1 || fy <= -1 || fx >= width || fy >= height) continue
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const inX0 = x0 >= 0
      const inX1 = x0 + 1 < width
      const inY0 = y0 >= 0
      const inY1 = y0 + 1 < height
      const top = inY0 ? (inX0 ? data[y0 * width + x0]! : 0) * (1 - tx) + (inX1 ? data[y0 * width + x0 + 1]! : 0) * tx : 0
      const bottom = inY1 ? (inX0 ? data[(y0 + 1) * width + x0]! : 0) * (1 - tx) + (inX1 ? data[(y0 + 1) * width + x0 + 1]! : 0) * tx : 0
      out[row + x] = Math.round(top * (1 - ty) + bottom * ty)
    }
  }
  return out
}

/** The way back: a point on the canvas as a point in the layer's pixels, and layer pixels per canvas pixel across. */
export function canvasToLayer(space: LayerSpace): { readonly at: (x: number, y: number) => readonly [number, number]; readonly scale: number } {
  if (projective(space)) {
    const inverse = invertMatrix(space.matrix!)
    // Across at the layer's middle, where a stroke's size is judged.
    const [mx, my] = space.toCanvas(space.width / 2, space.height / 2)
    const [nx, ny] = space.toCanvas(space.width / 2 + 1, space.height / 2)
    return { at: (x, y) => applyMatrix(inverse, x, y), scale: 1 / Math.max(1e-9, Math.hypot(nx - mx, ny - my)) }
  }
  const [ox, oy] = space.toCanvas(0, 0)
  const [ax, ay] = space.toCanvas(1, 0)
  const [bx, by] = space.toCanvas(0, 1)
  const ux = ax - ox
  const uy = ay - oy
  const vx = bx - ox
  const vy = by - oy
  const determinant = ux * vy - uy * vx
  const safe = Math.abs(determinant) < 1e-12 ? 1e-12 : determinant
  return {
    at: (x, y) => {
      const dx = x - ox
      const dy = y - oy
      return [(dx * vy - dy * vx) / safe, (ux * dy - uy * dx) / safe]
    },
    scale: 1 / Math.max(1e-9, Math.hypot(ux, uy))
  }
}

/** A layer's mask (in its pixels) read onto the canvas, as Ctrl+click on a mask thumbnail loads it as a selection. */
export function layerMaskOnCanvas(coverage: ArrayLike<number>, space: LayerSpace, canvas: Size): GrayMask {
  if (projective(space)) {
    const out = new Uint8Array(canvas.width * canvas.height)
    const inverse = invertMatrix(space.matrix!)
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const [lx, ly] = applyMatrix(inverse, x + 0.5, y + 0.5)
        // Beyond the layer there is nothing to load.
        if (lx < 0 || ly < 0 || lx > space.width || ly > space.height) continue
        out[y * canvas.width + x] = sampleGray(coverage, space.width, space.height, Math.max(0, Math.min(space.width - 1, lx - 0.5)), Math.max(0, Math.min(space.height - 1, ly - 0.5)))
      }
    }
    return { width: canvas.width, height: canvas.height, data: out }
  }
  const out = new Uint8Array(canvas.width * canvas.height)
  const back = canvasToLayer(space)
  const [ox, oy] = back.at(0, 0)
  const [ax, ay] = back.at(1, 0)
  const [bx, by] = back.at(0, 1)
  const ux = ax - ox
  const uy = ay - oy
  const vx = bx - ox
  const vy = by - oy
  const { width, height } = space
  for (let y = 0; y < canvas.height; y += 1) {
    let fx = ox + (y + 0.5) * vx + 0.5 * ux - 0.5
    let fy = oy + (y + 0.5) * vy + 0.5 * uy - 0.5
    const row = y * canvas.width
    for (let x = 0; x < canvas.width; x += 1, fx += ux, fy += uy) {
      // Beyond the layer there is nothing to load.
      if (fx < -0.5 || fy < -0.5 || fx > width - 0.5 || fy > height - 0.5) continue
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)))
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)))
      const x1 = Math.min(width - 1, x0 + 1)
      const y1 = Math.min(height - 1, y0 + 1)
      const tx = Math.max(0, Math.min(1, fx - x0))
      const ty = Math.max(0, Math.min(1, fy - y0))
      const top = coverage[y0 * width + x0]! * (1 - tx) + coverage[y0 * width + x1]! * tx
      const bottom = coverage[y1 * width + x0]! * (1 - tx) + coverage[y1 * width + x1]! * tx
      out[row + x] = Math.round(top * (1 - ty) + bottom * ty)
    }
  }
  return { width: canvas.width, height: canvas.height, data: out }
}
