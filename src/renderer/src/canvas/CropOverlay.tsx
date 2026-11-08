import { useRef, useState } from 'react'
import type { CanvasFrame } from '../../../domain'
import { useWorkspaceStore } from '../store/workspace-store'
import { cropAspect, frameExtends, useCrop } from './crop-store'
import { snapValue } from './view-store'

/*
 * The crop tool's frame over the stage: dark outside it, checked where it
 * reaches past the canvas (the canvas grows there), thirds while it is
 * dragged. Its handles size it (Shift keeps the proportions, Alt about the
 * middle), inside moves it, outside draws a new one. Its options are in the
 * options bar (CropOptionsBar).
 */

const MIN_SIDE = 64
const MAX_SIDE = 16384

type Drag =
  | { readonly kind: 'handle'; readonly handle: number; readonly start: CanvasFrame; readonly from: readonly [number, number] }
  | { readonly kind: 'move'; readonly start: CanvasFrame; readonly from: readonly [number, number] }
  | { readonly kind: 'draw'; readonly from: readonly [number, number] }

/** Which edges each handle moves: the four corners, then the middles of the top, right, bottom and left. */
const HANDLE_EDGES: readonly { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 }[] = [
  { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }
]

const CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'] as const

function clampSide(value: number): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, value))
}

/** A frame from a handle dragged by this much, kept to the proportions when asked. */
function resized(start: CanvasFrame, handle: number, delta: readonly [number, number], aspect: number | null, fromCentre: boolean, snap: (value: number, axis: 'x' | 'y') => number): CanvasFrame {
  const edges = HANDLE_EDGES[handle]!
  let left = start.left
  let right = start.left + start.width
  let top = start.top
  let bottom = start.top + start.height
  if (edges.x === -1) left = snap(left + delta[0], 'x')
  if (edges.x === 1) right = snap(right + delta[0], 'x')
  if (edges.y === -1) top = snap(top + delta[1], 'y')
  if (edges.y === 1) bottom = snap(bottom + delta[1], 'y')
  if (fromCentre) {
    if (edges.x === -1) right = start.left + start.width + (start.left - left)
    if (edges.x === 1) left = start.left - (right - start.left - start.width)
    if (edges.y === -1) bottom = start.top + start.height + (start.top - top)
    if (edges.y === 1) top = start.top - (bottom - start.top - start.height)
  }
  let width = clampSide(right - left)
  let height = clampSide(bottom - top)
  if (aspect !== null) {
    // A side drags the size it moves; a corner the one it moved more.
    if (edges.y === 0 || (edges.x !== 0 && Math.abs(width - start.width) / start.width >= Math.abs(height - start.height) / start.height)) height = clampSide(width / aspect)
    else width = clampSide(height * aspect)
  }
  // Anchored at the opposite side, or the middle.
  const cx = start.left + start.width / 2
  const cy = start.top + start.height / 2
  const x = fromCentre || edges.x === 0 ? cx - width / 2 : edges.x === -1 ? start.left + start.width - width : start.left
  const y = fromCentre || edges.y === 0 ? cy - height / 2 : edges.y === -1 ? start.top + start.height - height : start.top
  return { left: x, top: y, width, height }
}

export function CropOverlay({ originX, originY, zoom, width, height, stageContent }: {
  readonly originX: number
  readonly originY: number
  readonly zoom: number
  readonly width: number
  readonly height: number
  readonly stageContent: () => HTMLElement | null
}): React.JSX.Element | null {
  const frame = useCrop((state) => state.frame)
  const ratio = useCrop((state) => state.ratio)
  const portrait = useCrop((state) => state.portrait)
  const busy = useCrop((state) => state.busy)
  const canvas = useWorkspaceStore((state) => state.scene.canvas)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  if (frame === null) return null
  const { setFrame, commit } = useCrop.getState()

  const toCanvas = (clientX: number, clientY: number, element: Element): [number, number] => {
    const rect = element.getBoundingClientRect()
    return [(clientX - rect.left - originX) / zoom, (clientY - rect.top - originY) / zoom]
  }
  const screen = { x: originX + frame.left * zoom, y: originY + frame.top * zoom, width: frame.width * zoom, height: frame.height * zoom }
  const canvasRect = { x: originX, y: originY, width: canvas.outputWidth * zoom, height: canvas.outputHeight * zoom }
  const handles = HANDLE_EDGES.map(({ x, y }) => [screen.x + (x + 1) / 2 * screen.width, screen.y + (y + 1) / 2 * screen.height] as const)
  const aspectFor = (shift: boolean): number | null => cropAspect(ratio, portrait) ?? (shift ? frame.width / frame.height : null)
  // Edges snap to the canvas's edges, its middle and the guides, unless Ctrl is held.
  const snapper = (active: boolean) => (value: number, axis: 'x' | 'y'): number => active ? snapValue(value, axis, 8 / zoom) : value

  const begin = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0 || busy) return
    const svg = event.currentTarget
    const point = toCanvas(event.clientX, event.clientY, svg)
    const handle = (event.target as Element).getAttribute('data-handle')
    svg.setPointerCapture(event.pointerId)
    setDragging(true)
    if (handle !== null) drag.current = { kind: 'handle', handle: Number(handle), start: frame, from: point }
    else if (point[0] >= frame.left && point[0] <= frame.left + frame.width && point[1] >= frame.top && point[1] <= frame.top + frame.height) drag.current = { kind: 'move', start: frame, from: point }
    else drag.current = { kind: 'draw', from: point }
  }

  const follow = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current
    if (current === null) return
    const point = toCanvas(event.clientX, event.clientY, event.currentTarget)
    const snap = snapper(!(event.ctrlKey || event.metaKey))
    if (current.kind === 'handle') {
      setFrame(resized(current.start, current.handle, [point[0] - current.from[0], point[1] - current.from[1]], aspectFor(event.shiftKey && current.handle < 4), event.altKey, snap))
    } else if (current.kind === 'move') {
      let dx = point[0] - current.from[0]
      let dy = point[1] - current.from[1]
      if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0 }
      const left = current.start.left + dx
      const top = current.start.top + dy
      // Whichever edge lands nearer a snap line takes it.
      const nearer = (start: number, size: number, axis: 'x' | 'y'): number => {
        const before = snap(start, axis) - start
        const after = snap(start + size, axis) - start - size
        return before !== 0 && (after === 0 || Math.abs(before) <= Math.abs(after)) ? start + before : start + after
      }
      setFrame({ ...current.start, left: nearer(left, current.start.width, 'x'), top: nearer(top, current.start.height, 'y') })
    } else {
      const aspect = aspectFor(event.shiftKey)
      const x0 = current.from[0]
      const y0 = current.from[1]
      let x1 = snap(point[0], 'x')
      let y1 = snap(point[1], 'y')
      let w = clampSide(Math.abs(x1 - x0))
      let h = clampSide(Math.abs(y1 - y0))
      if (aspect !== null) h = clampSide(w / aspect)
      if (aspect !== null) w = clampSide(h * aspect)
      x1 = x1 >= x0 ? x0 + w : x0 - w
      y1 = y1 >= y0 ? y0 + h : y0 - h
      setFrame({ left: Math.min(x0, x1), top: Math.min(y0, y1), width: w, height: h })
    }
  }

  const end = (event: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const extends_ = frameExtends(frame)

  return (
    <>
      <svg
        className="crop-overlay"
        data-testid="crop-overlay"
        width={width}
        height={height}
        onPointerDown={begin}
        onPointerMove={follow}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => { void commit() }}
        onWheel={(event) => { stageContent()?.dispatchEvent(new WheelEvent('wheel', event.nativeEvent)) }}
      >
        <defs>
          <pattern id="crop-new-area" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="rgba(255,255,255,.55)" />
            <rect width="6" height="6" fill="rgba(200,206,214,.55)" />
            <rect x="6" y="6" width="6" height="6" fill="rgba(200,206,214,.55)" />
          </pattern>
          <clipPath id="crop-frame-clip"><rect x={screen.x} y={screen.y} width={screen.width} height={screen.height} /></clipPath>
        </defs>
        <path className="crop-veil" fillRule="evenodd" d={`M0 0H${width}V${height}H0Z M${screen.x} ${screen.y}H${screen.x + screen.width}V${screen.y + screen.height}H${screen.x}Z`} />
        {extends_ && (
          // New area inside the frame, past the canvas: checked, as Photoshop shows transparency.
          <path className="crop-new-area" clipPath="url(#crop-frame-clip)" fillRule="evenodd" fill="url(#crop-new-area)"
            d={`M${screen.x} ${screen.y}H${screen.x + screen.width}V${screen.y + screen.height}H${screen.x}Z M${canvasRect.x} ${canvasRect.y}H${canvasRect.x + canvasRect.width}V${canvasRect.y + canvasRect.height}H${canvasRect.x}Z`} />
        )}
        <rect className="crop-frame" x={screen.x} y={screen.y} width={screen.width} height={screen.height} />
        {dragging && [1, 2].map((third) => (
          <g key={third} className="crop-thirds">
            <line x1={screen.x + screen.width * third / 3} y1={screen.y} x2={screen.x + screen.width * third / 3} y2={screen.y + screen.height} />
            <line x1={screen.x} y1={screen.y + screen.height * third / 3} x2={screen.x + screen.width} y2={screen.y + screen.height * third / 3} />
          </g>
        ))}
        {handles.map(([x, y], index) => (
          <rect key={index} data-handle={index} className="crop-handle" x={x - (index < 4 ? 7 : 6)} y={y - (index < 4 ? 7 : 6)} width={index < 4 ? 14 : 12} height={index < 4 ? 14 : 12} style={{ cursor: CURSORS[index] }} />
        ))}
        <text className="crop-size" x={screen.x + screen.width / 2} y={Math.min(height - 8, screen.y + screen.height + 22)} textAnchor="middle">{Math.round(frame.width)} × {Math.round(frame.height)}</text>
      </svg>
    </>
  )
}
