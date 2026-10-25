import { useEffect, useMemo, useRef } from 'react'
import { maskBounds, simplifyOutline, traceMaskOutline } from '../../../shared/mask-raster'
import { selectionDraft, selectionMoveOffset, subscribeSelectionDraft, useSelectionStore, type SelectionDraft } from './selection-store'

/*
 * Marching ants: the selection's outline drawn on a page canvas of its own
 * over the stage, so they move without redrawing the picture. The outline
 * is traced once per selection and thinned to what the zoom can show; each
 * tick only strokes it again with the dashes shifted.
 */

const TICK_MS = 120
const DASH = 4


function outlinePath(outlines: readonly Float32Array[]): Path2D {
  const path = new Path2D()
  for (const outline of outlines) {
    path.moveTo(outline[0]!, outline[1]!)
    for (let index = 2; index < outline.length; index += 2) path.lineTo(outline[index]!, outline[index + 1]!)
    path.closePath()
  }
  return path
}

function draftPath(shape: SelectionDraft): Path2D {
  const path = new Path2D()
  if (shape.kind === 'rect') {
    path.rect(shape.x, shape.y, shape.width, shape.height)
  } else if (shape.kind === 'ellipse') {
    if (Math.abs(shape.width) >= 1 && Math.abs(shape.height) >= 1) {
      path.ellipse(shape.x + shape.width / 2, shape.y + shape.height / 2, Math.abs(shape.width) / 2, Math.abs(shape.height) / 2, 0, 0, Math.PI * 2)
    }
  } else if (shape.kind === 'polygon' && shape.points.length >= 2) {
    path.moveTo(shape.points[0]!, shape.points[1]!)
    for (let index = 2; index < shape.points.length; index += 2) path.lineTo(shape.points[index]!, shape.points[index + 1]!)
    if (shape.cursor !== null) path.lineTo(shape.cursor[0], shape.cursor[1])
    if (shape.closed) path.closePath()
  }
  return path
}

interface View {
  readonly originX: number
  readonly originY: number
  readonly zoom: number
  readonly width: number
  readonly height: number
}

/** Strokes the selection's outline and any shape being drawn, light then dark dashes shifted by phase. */
function drawAnts(canvas: HTMLCanvasElement, view: View, outline: Path2D | null, phase: number): void {
  const context = canvas.getContext('2d')
  if (context === null) return
  const ratio = window.devicePixelRatio || 1
  const deviceWidth = Math.max(1, Math.round(view.width * ratio))
  const deviceHeight = Math.max(1, Math.round(view.height * ratio))
  if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
    canvas.width = deviceWidth
    canvas.height = deviceHeight
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  const stroke = (shape: Path2D, dx: number, dy: number): void => {
    context.setTransform(ratio * view.zoom, 0, 0, ratio * view.zoom, ratio * (view.originX + dx * view.zoom), ratio * (view.originY + dy * view.zoom))
    context.lineWidth = 1 / view.zoom
    context.setLineDash([])
    context.strokeStyle = '#FFFFFF'
    context.stroke(shape)
    context.setLineDash([DASH / view.zoom, DASH / view.zoom])
    context.lineDashOffset = -phase / view.zoom
    context.strokeStyle = '#000000'
    context.stroke(shape)
  }
  const offset = selectionMoveOffset()
  if (outline !== null) stroke(outline, offset?.dx ?? 0, offset?.dy ?? 0)
  const shape = selectionDraft()
  if (shape !== null) stroke(draftPath(shape), 0, 0)
}

/** Where the artboard's top-left corner is in the stage, the stage pixels per canvas pixel, and the stage's size. */
export function SelectionOverlay({ originX, originY, zoom, width, height }: View): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mask = useSelectionStore((state) => state.mask)
  const traced = useMemo(() => mask === null ? null : traceMaskOutline(mask), [mask])
  // Points within half a screen pixel of the line add nothing; on a large canvas seen whole they are most of the outline.
  const tolerance = 2 ** Math.round(Math.log2(Math.max(0.25, 0.5 / zoom)))
  const outline = useMemo(() => traced === null ? null : outlinePath(traced.map((points) => simplifyOutline(points, tolerance))), [traced, tolerance])
  // Where the selection reaches, in canvas pixels, for tests and assistive reading.
  const bounds = useMemo(() => {
    const rect = mask === null ? null : maskBounds(mask)
    return rect === null ? '' : `${rect.x},${rect.y},${rect.width},${rect.height}`
  }, [mask])
  const latest = useRef<{ view: View; outline: Path2D | null; phase: number }>({ view: { originX, originY, zoom, width, height }, outline: null, phase: 0 })

  useEffect(() => {
    latest.current.view = { originX, originY, zoom, width, height }
    latest.current.outline = outline
    if (canvasRef.current !== null) drawAnts(canvasRef.current, latest.current.view, outline, latest.current.phase)
  }, [height, originX, originY, outline, width, zoom])

  useEffect(() => subscribeSelectionDraft(() => {
    if (canvasRef.current !== null) drawAnts(canvasRef.current, latest.current.view, latest.current.outline, latest.current.phase)
  }), [])

  // The ants march only while there is something to draw, and not in a hidden window.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = latest.current
      if (document.hidden || canvasRef.current === null || (state.outline === null && selectionDraft() === null)) return
      state.phase = (state.phase + 1) % (DASH * 2)
      drawAnts(canvasRef.current, state.view, state.outline, state.phase)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  return <canvas ref={canvasRef} className="selection-ants" aria-hidden="true" data-testid="selection-ants" data-selection={mask === null ? 'none' : 'some'} data-selection-bounds={bounds} style={{ width, height }} />
}
