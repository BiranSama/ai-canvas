import type { NormalizedTransform } from './schema'

/*
 * Photoshop's free transform on a layer: the layer keeps its box (where its
 * content is laid out: position, size and turn), and its corners say where
 * the box's four corners land, in the box's own units, 0–1 being the box.
 * A flip or a skew moves them to a parallelogram, an affine map the canvas
 * and SVG draw directly; a distort or a perspective to any convex
 * quadrilateral, a projective map whose pixels are resampled by
 * shared/warp. Moving or scaling the box carries the corners with it.
 */

export type Point = readonly [number, number]
/** Top-left, top-right, bottom-right, bottom-left. */
export type Corners = readonly [Point, Point, Point, Point]
/** A 3×3 matrix, row by row. */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY_CORNERS: Corners = [[0, 0], [1, 0], [1, 1], [0, 1]]
/** The box mirrored left to right: Photoshop's 水平翻转. A vertical flip is this turned 180°. */
export const MIRRORED_CORNERS: Corners = [[1, 0], [0, 0], [0, 1], [1, 1]]

const EPSILON = 1e-9

function near(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

export function sameCorners(a: Corners, b: Corners, epsilon = 1e-6): boolean {
  return a.every((point, index) => near(point[0], b[index]![0], epsilon) && near(point[1], b[index]![1], epsilon))
}

/** No corners, or corners where the box is: nothing to draw differently. */
export function cornersAreIdentity(corners: Corners | null | undefined): boolean {
  return corners === undefined || corners === null || sameCorners(corners, IDENTITY_CORNERS)
}

/** A parallelogram: the map from the box is affine (a flip, a skew, or a scale within the box). */
export function cornersAreAffine(corners: Corners, epsilon = 1e-6): boolean {
  const [a, b, c, d] = corners
  return near(a[0] + c[0], b[0] + d[0], epsilon) && near(a[1] + c[1], b[1] + d[1], epsilon)
}

/** Only mirrored, so the layer's pixels map to the canvas one for one and can be painted on exactly. */
export function cornersAreMirror(corners: Corners | null | undefined): boolean {
  return corners !== undefined && corners !== null && sameCorners(corners, MIRRORED_CORNERS)
}

/** Whether painting would bend with the layer: after a skew, distort or perspective; a flip maps pixel for pixel. */
export function cornersBendPaint(corners: Corners | null | undefined): boolean {
  return !cornersAreIdentity(corners) && !cornersAreMirror(corners)
}

/**
 * Whether the canvas and SVG draw these corners as a matrix: a flip, and
 * text's skew (type stays crisp and Photoshop keeps it editable). An image
 * or shape skew, a distort or a perspective is resampled by shared/warp, so
 * every renderer gets the same pixels.
 */
export function cornersDrawnAsMatrix(corners: Corners, text: boolean): boolean {
  return cornersAreMirror(corners) || (text && cornersAreAffine(corners))
}

/** Twice the signed area of a quadrilateral, positive when it keeps the box's turn. */
function signedArea(points: readonly Point[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const [x0, y0] = points[index]!
    const [x1, y1] = points[(index + 1) % points.length]!
    sum += x0 * y1 - x1 * y0
  }
  return sum
}

/**
 * Whether these corners make a quadrilateral that can be drawn: convex, not
 * folded over itself and not squashed to a line, as Photoshop refuses a
 * transform that turns the layer inside out.
 */
export function cornersAreDrawable(corners: Corners): boolean {
  const area = signedArea(corners)
  if (Math.abs(area) < 1e-6) return false
  const sign = Math.sign(area)
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = corners[index]!
    const [x1, y1] = corners[(index + 1) % 4]!
    const [x2, y2] = corners[(index + 2) % 4]!
    const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)
    if (Math.sign(cross) !== sign || Math.abs(cross) < 1e-9) return false
  }
  return true
}

/** The corners' bounding box, in the box's units. */
export function cornersExtent(corners: Corners): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const xs = corners.map((point) => point[0])
  const ys = corners.map((point) => point[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * The homography that takes the unit square's corners to these corners:
 * (u, v) ↦ (x, y). Heckbert's closed form for a square to a quadrilateral.
 */
export function homographyFromCorners(corners: Corners): Matrix3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3
  if (Math.abs(sx) < EPSILON && Math.abs(sy) < EPSILON) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]
  }
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const denominator = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / denominator
  const h = (dx1 * sy - sx * dy1) / denominator
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]
}

export function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] = a[row * 3]! * b[column]! + a[row * 3 + 1]! * b[3 + column]! + a[row * 3 + 2]! * b[6 + column]!
    }
  }
  return out as unknown as Matrix3
}

export function invertMatrix(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const determinant = a * A + b * B + c * C
  if (Math.abs(determinant) < 1e-15) throw new Error('The transform cannot be undone: the layer is squashed flat.')
  const scale = 1 / determinant
  return [
    A * scale, -(b * i - c * h) * scale, (b * f - c * e) * scale,
    B * scale, (a * i - c * g) * scale, -(a * f - c * d) * scale,
    C * scale, -(a * h - b * g) * scale, (a * e - b * d) * scale
  ]
}

export function applyMatrix(m: Matrix3, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8]
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}

/** Scale, then move: (x, y) ↦ (x × sx + tx, y × sy + ty). */
export function scaleMatrix(sx: number, sy: number, tx = 0, ty = 0): Matrix3 {
  return [sx, 0, tx, 0, sy, ty, 0, 0, 1]
}

/**
 * The map from a layer's box, in its pixels (0–width, 0–height), to where
 * it lands in the same pixels after its corners: what to draw the box's
 * content through before the layer is turned and placed.
 */
export function boxWarpMatrix(corners: Corners, width: number, height: number): Matrix3 {
  return multiplyMatrices(multiplyMatrices(scaleMatrix(width, height), homographyFromCorners(corners)), scaleMatrix(1 / Math.max(EPSILON, width), 1 / Math.max(EPSILON, height)))
}

/** The affine part as a canvas transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export function affineOf(m: Matrix3): readonly [number, number, number, number, number, number] {
  return [m[0] / m[8], m[3] / m[8], m[1] / m[8], m[4] / m[8], m[2] / m[8], m[5] / m[8]]
}

/**
 * An affine map split the way Konva sets a node: turned, then sheared along
 * x, then scaled, then moved, so a node with these attributes draws its
 * children through the map. A mirror shows as a negative scale on y.
 */
export function decomposeAffine(affine: readonly [number, number, number, number, number, number]): { readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number; readonly skewX: number } {
  const [a, b, c, d, e, f] = affine
  const scaleX = Math.hypot(a, b)
  const determinant = a * d - b * c
  // Kept away from zero with its sign: a mirror's determinant is negative.
  const safe = Math.abs(determinant) < EPSILON ? (determinant < 0 ? -EPSILON : EPSILON) : determinant
  const rotation = Math.atan2(b, a)
  const scaleY = determinant / Math.max(EPSILON, scaleX)
  const skewX = (a * c + b * d) / safe
  return { x: e, y: f, rotation: rotation * 180 / Math.PI, scaleX, scaleY, skewX }
}

/** The four corners of a layer on the canvas, in canvas pixels, with its turn about the box's top-left corner. */
export function layerCornerPoints(transform: NormalizedTransform, corners: Corners | null | undefined, canvas: { readonly width: number; readonly height: number }): readonly [Point, Point, Point, Point] {
  const x = transform.x * canvas.width
  const y = transform.y * canvas.height
  const width = transform.width * canvas.width
  const height = transform.height * canvas.height
  const angle = transform.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const local = corners ?? IDENTITY_CORNERS
  return local.map(([u, v]) => {
    const lx = u * width
    const ly = v * height
    return [x + lx * cos - ly * sin, y + lx * sin + ly * cos] as Point
  }) as unknown as readonly [Point, Point, Point, Point]
}

/** The axis-aligned box around a layer's corners on the canvas, in canvas pixels. */
export function layerCanvasBounds(transform: NormalizedTransform, corners: Corners | null | undefined, canvas: { readonly width: number; readonly height: number }): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const points = layerCornerPoints(transform, corners, canvas)
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/**
 * The box a group takes around its layers, square to the canvas: what each
 * layer covers, through its turn and its free-transform corners. A layer
 * neither turned nor reshaped counts as its box exactly.
 */
export function boxAroundLayers(layers: readonly { readonly transform: NormalizedTransform; readonly corners?: Corners | null | undefined }[], canvas: { readonly width: number; readonly height: number }): NormalizedTransform {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const { transform, corners } of layers) {
    const box = transform.rotation === 0 && cornersAreIdentity(corners)
      ? transform
      : (() => {
          const bounds = layerCanvasBounds(transform, corners, canvas)
          return { x: bounds.x / canvas.width, y: bounds.y / canvas.height, width: bounds.width / canvas.width, height: bounds.height / canvas.height }
        })()
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top, rotation: 0 }
}

export interface PlacedLayer {
  readonly transform: NormalizedTransform
  /** Null when the layer is a plain box again. */
  readonly corners: Corners | null
}

/**
 * A layer's place from where its four corners land on the canvas (canvas
 * pixels, in the order of the box's corners). A rectangle the right way
 * round becomes a plain box; a mirrored rectangle a box with mirrored
 * corners; anything else keeps the layer's box and records the corners in
 * it. Text takes only the first two (Photoshop distorts type only once it
 * is rasterized): null when a projective shape is asked of it.
 */
export function placeFromCornerPoints(points: readonly [Point, Point, Point, Point], box: NormalizedTransform, canvas: { readonly width: number; readonly height: number }, affineOnly = false, keepBox = false): PlacedLayer | null {
  const [p0, p1, p2, p3] = points
  const edge = (from: Point, to: Point): Point => [to[0] - from[0], to[1] - from[1]]
  const top = edge(p0, p1)
  const left = edge(p0, p3)
  const length = (vector: Point): number => Math.hypot(vector[0], vector[1])
  const parallelogram = Math.abs(p0[0] + p2[0] - p1[0] - p3[0]) < 1e-6 * Math.max(1, canvas.width) && Math.abs(p0[1] + p2[1] - p1[1] - p3[1]) < 1e-6 * Math.max(1, canvas.height)
  const square = parallelogram && Math.abs(top[0] * left[0] + top[1] * left[1]) <= 1e-6 * Math.max(1, length(top) * length(left))
  if (square && !keepBox && length(top) > EPSILON && length(left) > EPSILON) {
    const cross = top[0] * left[1] - top[1] * left[0]
    // The right way round: the box's top-left is where the content's is.
    const [origin, across, down] = cross > 0 ? [p0, top, left] : [p1, edge(p1, p0), edge(p1, p2)]
    return {
      transform: {
        x: round(origin[0] / canvas.width),
        y: round(origin[1] / canvas.height),
        width: round(length(across) / canvas.width),
        height: round(length(down) / canvas.height),
        rotation: normalizeAngle(Math.atan2(across[1], across[0]) * 180 / Math.PI)
      },
      corners: cross > 0 ? null : MIRRORED_CORNERS
    }
  }
  if (affineOnly && !parallelogram) return null
  // Anything else: the corners in the box the layer already has.
  const width = box.width * canvas.width
  const height = box.height * canvas.height
  const angle = -box.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const ox = box.x * canvas.width
  const oy = box.y * canvas.height
  const corners = points.map(([x, y]) => {
    const dx = x - ox
    const dy = y - oy
    return [(dx * cos - dy * sin) / Math.max(EPSILON, width), (dx * sin + dy * cos) / Math.max(EPSILON, height)] as Point
  }) as unknown as Corners
  const rounded = corners.map(([u, v]) => [round(u), round(v)] as Point) as unknown as Corners
  // A parallelogram stays one after rounding, so text keeps an affine shape.
  if (parallelogram) {
    const [a, b, , d] = rounded
    return { transform: box, corners: [a, b, [b[0] + d[0] - a[0], b[1] + d[1] - a[1]], d] }
  }
  return { transform: box, corners: rounded }
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function normalizeAngle(degrees: number): number {
  let value = degrees % 360
  if (value > 180) value -= 360
  if (value <= -180) value += 360
  return Math.abs(value) < 1e-9 ? 0 : Math.round(value * 1e6) / 1e6
}
