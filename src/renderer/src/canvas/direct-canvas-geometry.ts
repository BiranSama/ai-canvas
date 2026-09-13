import type { SceneElement } from '../../../domain'

export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

interface CanvasViewportSize {
  readonly width: number
  readonly height: number
}

export type ShapeEditAnchor = 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

export function shapeEditAnchors(shape: 'rectangle' | 'ellipse' | 'line'): readonly ShapeEditAnchor[] {
  if (shape === 'line') return ['middle-left', 'middle-right']
  if (shape === 'ellipse') return ['top-center', 'middle-left', 'middle-right', 'bottom-center']
  return ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
}

export function cornerRadiusFromLocalPoint(
  point: CanvasPoint,
  size: Pick<CanvasRect, 'width' | 'height'>
): number {
  const minimumSide = Math.max(.001, Math.min(size.width, size.height))
  const radiusPixels = Math.max(0, Math.min(size.width - point.x, point.y))
  return Math.min(.5, Number((radiusPixels / minimumSide).toFixed(4)))
}

export function shapeEditToolbarPosition(
  bounds: CanvasRect,
  viewport: CanvasViewportSize,
  toolbar: CanvasViewportSize,
  gap = 12,
  margin = 12
): { readonly left: number; readonly top: number; readonly placement: 'above' | 'below' } {
  const left = Math.max(margin, Math.min(viewport.width - toolbar.width - margin, bounds.x + bounds.width / 2 - toolbar.width / 2))
  const above = bounds.y - toolbar.height - gap
  if (above >= margin) return { left, top: above, placement: 'above' }
  return {
    left,
    top: Math.max(margin, Math.min(viewport.height - toolbar.height - margin, bounds.y + bounds.height + gap)),
    placement: 'below'
  }
}

export function lineEndpointsForTransform(
  transform: SceneElement['transform'],
  artboard: CanvasRect
): { readonly start: CanvasPoint; readonly end: CanvasPoint } {
  const origin = {
    x: artboard.x + transform.x * artboard.width,
    y: artboard.y + transform.y * artboard.height
  }
  const width = transform.width * artboard.width
  const height = transform.height * artboard.height
  const angle = transform.rotation * Math.PI / 180
  const project = (localX: number): CanvasPoint => ({
    x: origin.x + localX * Math.cos(angle) - height / 2 * Math.sin(angle),
    y: origin.y + localX * Math.sin(angle) + height / 2 * Math.cos(angle)
  })
  return { start: project(0), end: project(width) }
}

export function lineTransformFromStageEndpoints(
  start: CanvasPoint,
  end: CanvasPoint,
  height: number,
  artboard: CanvasRect
): SceneElement['transform'] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(10, Math.hypot(dx, dy))
  const angle = Math.atan2(dy, dx)
  const heightPixels = height * artboard.height
  const origin = {
    x: start.x + Math.sin(angle) * heightPixels / 2,
    y: start.y - Math.cos(angle) * heightPixels / 2
  }
  return {
    x: (origin.x - artboard.x) / artboard.width,
    y: (origin.y - artboard.y) / artboard.height,
    width: Math.max(.01, length / artboard.width),
    height,
    rotation: Math.atan2(dy, dx) * 180 / Math.PI
  }
}

export interface CanvasRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SnapGuide {
  readonly axis: 'x' | 'y'
  readonly position: number
  readonly kind: 'edge' | 'center'
}

export interface SnapResult {
  readonly dx: number
  readonly dy: number
  readonly guides: readonly SnapGuide[]
}

export function rectFromPoints(start: CanvasPoint, end: CanvasPoint): CanvasRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

export function rectsIntersect(left: CanvasRect, right: CanvasRect): boolean {
  return left.x <= right.x + right.width
    && left.x + left.width >= right.x
    && left.y <= right.y + right.height
    && left.y + left.height >= right.y
}

export function rectContainsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
}

export function rotatedElementBounds(element: SceneElement, artboard: CanvasRect): CanvasRect {
  const x = artboard.x + element.transform.x * artboard.width
  const y = artboard.y + element.transform.y * artboard.height
  const width = element.transform.width * artboard.width
  const height = element.transform.height * artboard.height
  const angle = element.transform.rotation * Math.PI / 180
  if (angle === 0) return { x, y, width, height }
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ].map((point) => ({
    x: x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: y + point.x * Math.sin(angle) + point.y * Math.cos(angle)
  }))
  const left = Math.min(...corners.map((point) => point.x))
  const right = Math.max(...corners.map((point) => point.x))
  const top = Math.min(...corners.map((point) => point.y))
  const bottom = Math.max(...corners.map((point) => point.y))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function boundsForElements(elements: readonly SceneElement[], artboard: CanvasRect): CanvasRect | null {
  if (elements.length === 0) return null
  const bounds = elements.map((element) => rotatedElementBounds(element, artboard))
  const left = Math.min(...bounds.map((rect) => rect.x))
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width))
  const top = Math.min(...bounds.map((rect) => rect.y))
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

interface SnapLine {
  readonly position: number
  readonly kind: 'edge' | 'center'
}

function rectLines(rect: CanvasRect, axis: 'x' | 'y'): readonly SnapLine[] {
  if (axis === 'x') {
    return [
      { position: rect.x, kind: 'edge' },
      { position: rect.x + rect.width / 2, kind: 'center' },
      { position: rect.x + rect.width, kind: 'edge' }
    ]
  }
  return [
    { position: rect.y, kind: 'edge' },
    { position: rect.y + rect.height / 2, kind: 'center' },
    { position: rect.y + rect.height, kind: 'edge' }
  ]
}

function bestAxisSnap(moving: CanvasRect, candidates: readonly CanvasRect[], axis: 'x' | 'y', threshold: number): { delta: number; guide: SnapGuide | null } {
  const movingLines = rectLines(moving, axis)
  let best: { distance: number; delta: number; guide: SnapGuide } | null = null
  for (const candidate of candidates) {
    for (const target of rectLines(candidate, axis)) {
      for (const source of movingLines) {
        const delta = target.position - source.position
        const distance = Math.abs(delta)
        if (distance > threshold || (best !== null && distance >= best.distance)) continue
        best = {
          distance,
          delta,
          guide: {
            axis,
            position: target.position,
            kind: target.kind === 'center' && source.kind === 'center' ? 'center' : 'edge'
          }
        }
      }
    }
  }
  return best === null ? { delta: 0, guide: null } : { delta: best.delta, guide: best.guide }
}

export function snapRect(moving: CanvasRect, candidates: readonly CanvasRect[], threshold: number): SnapResult {
  const x = bestAxisSnap(moving, candidates, 'x', threshold)
  const y = bestAxisSnap(moving, candidates, 'y', threshold)
  return {
    dx: x.delta,
    dy: y.delta,
    guides: [x.guide, y.guide].filter((guide): guide is SnapGuide => guide !== null)
  }
}

export function clampPan(input: {
  readonly pan: CanvasPoint
  readonly viewport: { readonly width: number; readonly height: number }
  readonly centeredArtboard: CanvasRect
  readonly minimumVisible?: number
}): CanvasPoint {
  const minimumVisible = input.minimumVisible ?? 72
  const minX = minimumVisible - (input.centeredArtboard.x + input.centeredArtboard.width)
  const maxX = input.viewport.width - minimumVisible - input.centeredArtboard.x
  const minY = minimumVisible - (input.centeredArtboard.y + input.centeredArtboard.height)
  const maxY = input.viewport.height - minimumVisible - input.centeredArtboard.y
  return {
    x: Math.max(Math.min(minX, maxX), Math.min(Math.max(minX, maxX), input.pan.x)),
    y: Math.max(Math.min(minY, maxY), Math.min(Math.max(minY, maxY), input.pan.y))
  }
}

export function clampCrop(crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): { x: number; y: number; width: number; height: number } {
  const width = Math.max(0.05, Math.min(1, crop.width))
  const height = Math.max(0.05, Math.min(1, crop.height))
  return {
    x: Math.max(0, Math.min(1 - width, crop.x)),
    y: Math.max(0, Math.min(1 - height, crop.y)),
    width,
    height
  }
}
