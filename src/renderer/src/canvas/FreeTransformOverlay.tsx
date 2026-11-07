import { Check, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  distortQuad,
  HANDLE_UNITS,
  moveQuad,
  perspectiveQuad,
  quadCentre,
  quadPoint,
  rotateQuad,
  scaleQuad,
  skewQuad,
  type HandleIndex,
  type Point,
  type Quad
} from '../../../domain'
import { useFreeTransform, type FreeTransformMode } from './free-transform-store'

/*
 * The free transform's box over the stage: eight handles, the reference
 * point in the middle, and the bar of modes, flips and turns. Dragging a
 * handle scales (a corner keeps proportions unless Shift is held; Alt from
 * the middle); with Ctrl a corner distorts and a side skews; with
 * Ctrl+Alt+Shift a corner pulls into perspective; inside moves, outside
 * turns (Shift in steps of 15°). Enter or a double-click applies, Esc puts
 * it back.
 */

const MODES: readonly { readonly mode: FreeTransformMode; readonly label: string }[] = [
  { mode: 'scale', label: '缩放' },
  { mode: 'skew', label: '斜切' },
  { mode: 'distort', label: '扭曲' },
  { mode: 'perspective', label: '透视' }
]

const HANDLE_CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'] as const

type Drag =
  | { readonly kind: 'handle'; readonly handle: HandleIndex; readonly start: Quad; readonly from: Point }
  | { readonly kind: 'move'; readonly start: Quad; readonly from: Point }
  | { readonly kind: 'rotate'; readonly start: Quad; readonly centre: Point; readonly angle: number }

function inside(point: Point, quad: Quad): boolean {
  let hit = false
  for (let index = 0, previous = 3; index < 4; previous = index, index += 1) {
    const [xi, yi] = quad[index]!
    const [xj, yj] = quad[previous]!
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

export function FreeTransformOverlay({ originX, originY, zoom, width, height, stageContent }: {
  /** The artboard on the stage, and the stage pixels per canvas pixel. */
  readonly originX: number
  readonly originY: number
  readonly zoom: number
  readonly width: number
  readonly height: number
  /** Where the stage listens for the wheel, so zooming still works over the box. */
  readonly stageContent: () => HTMLElement | null
}): React.JSX.Element | null {
  const session = useFreeTransform((state) => state.session)
  const { setTarget, setMode, flip, rotate, apply, cancel } = useFreeTransform.getState()
  const drag = useRef<Drag | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (session === null) return null

  const toScreen = ([x, y]: Point): Point => [originX + x * zoom, originY + y * zoom]
  const toCanvas = (clientX: number, clientY: number, element: Element): Point => {
    const rect = element.getBoundingClientRect()
    return [(clientX - rect.left - originX) / zoom, (clientY - rect.top - originY) / zoom]
  }
  const target = session.target
  const handles = HANDLE_UNITS.map(([u, v]) => toScreen(quadPoint(target, u, v)))
  const centre = toScreen(quadCentre(target))
  const outline = target.map((point) => toScreen(point).join(',')).join(' ')

  const begin = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    setMenu(null)
    const svg = event.currentTarget
    const point = toCanvas(event.clientX, event.clientY, svg)
    const handleAttribute = (event.target as Element).getAttribute('data-handle')
    svg.setPointerCapture(event.pointerId)
    if (handleAttribute !== null) {
      drag.current = { kind: 'handle', handle: Number(handleAttribute) as HandleIndex, start: target, from: point }
    } else if (inside(point, target)) {
      drag.current = { kind: 'move', start: target, from: point }
    } else {
      const middle = quadCentre(target)
      drag.current = { kind: 'rotate', start: target, centre: middle, angle: Math.atan2(point[1] - middle[1], point[0] - middle[0]) }
    }
  }

  const follow = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current
    if (current === null) return
    const point = toCanvas(event.clientX, event.clientY, event.currentTarget)
    const ctrl = event.ctrlKey || event.metaKey
    if (current.kind === 'move') {
      let delta: Point = [point[0] - current.from[0], point[1] - current.from[1]]
      if (event.shiftKey) delta = Math.abs(delta[0]) >= Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]]
      setTarget(moveQuad(current.start, delta))
      return
    }
    if (current.kind === 'rotate') {
      let degrees = (Math.atan2(point[1] - current.centre[1], point[0] - current.centre[0]) - current.angle) * 180 / Math.PI
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15
      setTarget(rotateQuad(current.start, current.centre, degrees))
      return
    }
    const delta: Point = [point[0] - current.from[0], point[1] - current.from[1]]
    const corner = current.handle < 4
    const mode = session.mode
    if (corner && (mode === 'perspective' || (ctrl && event.altKey && event.shiftKey))) {
      setTarget(perspectiveQuad(current.start, current.handle, delta))
    } else if (corner && (mode === 'distort' || ctrl)) {
      setTarget(distortQuad(current.start, current.handle, delta))
    } else if (!corner && (mode === 'skew' || mode === 'distort' || mode === 'perspective' || ctrl)) {
      // In skew mode a side slides along itself; with Ctrl, or when distorting, it moves freely.
      setTarget(skewQuad(current.start, current.handle, delta, { along: mode === 'skew' && !ctrl, symmetric: event.altKey }))
    } else {
      setTarget(scaleQuad(current.start, current.handle, point, { free: !corner || event.shiftKey, fromCentre: event.altKey }))
    }
  }

  const end = (event: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const actions = (
    <>
      <button type="button" aria-label="水平翻转" title="水平翻转" onClick={() => { flip('horizontal'); setMenu(null) }} disabled={session.reach === 'box'}><FlipHorizontal2 size={14} /></button>
      <button type="button" aria-label="垂直翻转" title="垂直翻转" onClick={() => { flip('vertical'); setMenu(null) }} disabled={session.reach === 'box'}><FlipVertical2 size={14} /></button>
      <button type="button" aria-label="旋转 180 度" title="旋转 180°" onClick={() => { rotate(180); setMenu(null) }}>180°</button>
      <button type="button" aria-label="顺时针旋转 90 度" title="顺时针旋转 90°" onClick={() => { rotate(90); setMenu(null) }}><RotateCw size={14} /></button>
      <button type="button" aria-label="逆时针旋转 90 度" title="逆时针旋转 90°" onClick={() => { rotate(-90); setMenu(null) }}><RotateCcw size={14} /></button>
    </>
  )

  return (
    <>
      <svg
        className="free-transform-overlay"
        data-testid="free-transform-overlay"
        width={width}
        height={height}
        onPointerDown={begin}
        onPointerMove={follow}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => { void apply() }}
        onContextMenu={(event) => {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top })
        }}
        onWheel={(event) => { stageContent()?.dispatchEvent(new WheelEvent('wheel', event.nativeEvent)) }}
      >
        <polygon points={outline} className="free-transform-box" />
        <circle cx={centre[0]} cy={centre[1]} r={4} className="free-transform-centre" />
        {handles.map(([x, y], index) => (
          <rect key={index} data-handle={index} x={x - 5} y={y - 5} width={10} height={10} className="free-transform-handle" style={{ cursor: HANDLE_CURSORS[index] }} />
        ))}
      </svg>
      <div className="free-transform-bar glass-surface" role="toolbar" aria-label="自由变换" data-testid="free-transform-bar" onPointerDown={(event) => event.stopPropagation()}>
        <div className="free-transform-modes" role="radiogroup" aria-label="变换方式">
          {MODES.map(({ mode, label }) => (
            <button key={mode} type="button" role="radio" aria-checked={session.mode === mode} className={session.mode === mode ? 'is-active' : ''}
              disabled={(mode === 'distort' || mode === 'perspective') ? session.reach !== 'full' : mode === 'skew' ? session.reach === 'box' : false}
              onClick={() => setMode(mode)}>{label}</button>
          ))}
        </div>
        <span className="free-transform-divider" aria-hidden="true" />
        {actions}
        <span className="free-transform-hint">Ctrl 拖角扭曲 · Ctrl 拖边斜切 · Ctrl+Alt+Shift 拖角透视</span>
        <button type="button" aria-label="取消变换" title="取消（Esc）" onClick={cancel}><X size={14} /></button>
        <button type="button" className="is-primary" aria-label="应用变换" title="应用（Enter）" onClick={() => { void apply() }}><Check size={14} /></button>
      </div>
      {menu !== null && (
        <div className="free-transform-menu glass-surface" role="menu" aria-label="变换菜单" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {MODES.map(({ mode, label }) => (
            <button key={mode} type="button" role="menuitemradio" aria-checked={session.mode === mode}
              disabled={(mode === 'distort' || mode === 'perspective') ? session.reach !== 'full' : mode === 'skew' ? session.reach === 'box' : false}
              onClick={() => { setMode(mode); setMenu(null) }}>{label}</button>
          ))}
          <hr />
          <button type="button" role="menuitem" onClick={() => { rotate(180); setMenu(null) }}>旋转 180°</button>
          <button type="button" role="menuitem" onClick={() => { rotate(90); setMenu(null) }}>顺时针旋转 90°</button>
          <button type="button" role="menuitem" onClick={() => { rotate(-90); setMenu(null) }}>逆时针旋转 90°</button>
          <button type="button" role="menuitem" disabled={session.reach === 'box'} onClick={() => { flip('horizontal'); setMenu(null) }}>水平翻转</button>
          <button type="button" role="menuitem" disabled={session.reach === 'box'} onClick={() => { flip('vertical'); setMenu(null) }}>垂直翻转</button>
        </div>
      )}
    </>
  )
}
