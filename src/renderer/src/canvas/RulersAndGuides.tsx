import { useEffect, useRef, useState } from 'react'
import type { Guide } from '../../../domain'
import { useWorkspaceStore } from '../store/workspace-store'
import { editGuides, snapValue, useView } from './view-store'

/*
 * Photoshop's rulers, guides and grid over the stage. The rulers count
 * canvas pixels along the top and left and follow the zoom and pan; dragging
 * out of one makes a guide (the top ruler a horizontal one), dragging a
 * guide with the move tool moves it, and dragging it back onto its ruler
 * removes it, each one step. The grid is drawn over the canvas only.
 */

const RULER_SIZE = 18
const GUIDE_COLOR = '#21B5F2'

/** A round step between labelled ticks, at least this many canvas pixels. */
function niceStep(minimum: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, minimum))))
  for (const factor of [1, 2, 5, 10]) if (factor * power >= minimum) return factor * power
  return 10 * power
}

function drawRuler(canvas: HTMLCanvasElement, axis: 'x' | 'y', length: number, origin: number, zoom: number): void {
  const ratio = window.devicePixelRatio || 1
  const along = Math.max(1, Math.round(length))
  canvas.width = (axis === 'x' ? along : RULER_SIZE) * ratio
  canvas.height = (axis === 'x' ? RULER_SIZE : along) * ratio
  const context = canvas.getContext('2d')
  if (context === null) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.fillStyle = 'rgba(246, 247, 249, .94)'
  context.fillRect(0, 0, axis === 'x' ? along : RULER_SIZE, axis === 'x' ? RULER_SIZE : along)
  context.strokeStyle = 'rgba(52, 62, 78, .55)'
  context.fillStyle = 'rgba(52, 62, 78, .9)'
  context.font = '9px system-ui, sans-serif'
  context.lineWidth = 1
  const major = niceStep(64 / zoom)
  const minor = major / (String(major).startsWith('2') ? 4 : 5)
  const first = Math.floor(-origin / zoom / minor) * minor
  const last = (length - origin) / zoom
  context.beginPath()
  for (let value = first; value <= last; value += minor) {
    const at = Math.round(origin + value * zoom) + 0.5
    const isMajor = Math.abs(value / major - Math.round(value / major)) < 1e-6
    const tick = isMajor ? RULER_SIZE : RULER_SIZE * 0.3
    if (axis === 'x') { context.moveTo(at, RULER_SIZE); context.lineTo(at, RULER_SIZE - tick) } else { context.moveTo(RULER_SIZE, at); context.lineTo(RULER_SIZE - tick, at) }
    if (isMajor) {
      const label = String(Math.round(value))
      if (axis === 'x') context.fillText(label, at + 2, 9)
      else {
        context.save()
        context.translate(9, at + 2)
        context.rotate(-Math.PI / 2)
        context.fillText(label, -context.measureText(label).width, 0)
        context.restore()
      }
    }
  }
  context.stroke()
}

function drawGrid(canvas: HTMLCanvasElement, width: number, height: number, originX: number, originY: number, zoom: number, canvasWidth: number, canvasHeight: number, spacing: number, divisions: number): void {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = canvas.getContext('2d')
  if (context === null) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  const step = spacing / divisions
  // Too fine to see apart: only the main lines.
  const fine = step * zoom >= 6
  context.save()
  context.beginPath()
  context.rect(originX, originY, canvasWidth * zoom, canvasHeight * zoom)
  context.clip()
  for (const pass of fine ? ['minor', 'major'] as const : ['major'] as const) {
    const every = pass === 'major' ? spacing : step
    if (every * zoom < 3) continue
    context.beginPath()
    context.strokeStyle = pass === 'major' ? 'rgba(80, 140, 230, .55)' : 'rgba(80, 140, 230, .22)'
    context.lineWidth = 1
    for (let x = 0; x <= canvasWidth; x += every) { const at = Math.round(originX + x * zoom) + 0.5; context.moveTo(at, originY); context.lineTo(at, originY + canvasHeight * zoom) }
    for (let y = 0; y <= canvasHeight; y += every) { const at = Math.round(originY + y * zoom) + 0.5; context.moveTo(originX, at); context.lineTo(originX + canvasWidth * zoom, at) }
    context.stroke()
  }
  context.restore()
}

interface GuideDrag {
  readonly axis: Guide['axis']
  /** The guide moved, or null for a new one out of a ruler. */
  readonly index: number | null
  readonly position: number
  readonly overRuler: boolean
}

export function RulersAndGuides({ originX, originY, zoom, width, height, interactive }: {
  /** The artboard on the stage, and the stage pixels per canvas pixel. */
  readonly originX: number
  readonly originY: number
  readonly zoom: number
  readonly width: number
  readonly height: number
  /** Guides can be dragged: the move tool, with no transform or crop going on. */
  readonly interactive: boolean
}): React.JSX.Element {
  const view = useView()
  const canvas = useWorkspaceStore((state) => state.scene.canvas)
  const top = useRef<HTMLCanvasElement>(null)
  const left = useRef<HTMLCanvasElement>(null)
  const grid = useRef<HTMLCanvasElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<GuideDrag | null>(null)
  const guides = canvas.guides ?? []

  useEffect(() => {
    if (view.rulers && top.current !== null) drawRuler(top.current, 'x', width, originX, zoom)
    if (view.rulers && left.current !== null) drawRuler(left.current, 'y', height, originY, zoom)
  }, [view.rulers, width, height, originX, originY, zoom])

  useEffect(() => {
    if (view.grid && grid.current !== null) drawGrid(grid.current, width, height, originX, originY, zoom, canvas.outputWidth, canvas.outputHeight, view.gridSpacing, view.gridDivisions)
  }, [view.grid, view.gridSpacing, view.gridDivisions, width, height, originX, originY, zoom, canvas.outputWidth, canvas.outputHeight])

  const begin = (event: React.PointerEvent, axis: Guide['axis'], index: number | null): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = root.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const at = (clientX: number, clientY: number, free: boolean): GuideDrag => {
      const x = clientX - bounds.left
      const y = clientY - bounds.top
      const raw = axis === 'x' ? (x - originX) / zoom : (y - originY) / zoom
      // Back on its ruler, or off the stage, a guide goes away.
      const overRuler = axis === 'x' ? (view.rulers ? x < RULER_SIZE : x < 0) || x > bounds.width : (view.rulers ? y < RULER_SIZE : y < 0) || y > bounds.height
      return { axis, index, position: Math.round(free ? raw : snapValue(raw, axis, 6 / zoom)), overRuler }
    }
    setDrag(at(event.clientX, event.clientY, true))
    const move = (pointer: PointerEvent): void => setDrag(at(pointer.clientX, pointer.clientY, pointer.ctrlKey || pointer.metaKey))
    const up = (pointer: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const final = at(pointer.clientX, pointer.clientY, pointer.ctrlKey || pointer.metaKey)
      setDrag(null)
      if (index === null) {
        if (!final.overRuler) {
          void editGuides('新建参考线', (current) => [...current, { axis, position: final.position }])
          // A guide just made is shown, as Photoshop turns them on.
          if (!useView.getState().guides) useView.getState().toggle('guides')
        }
        return
      }
      // The guide picked up, found again by where it was when the change's turn comes.
      const picked = (useWorkspaceStore.getState().scene.canvas.guides ?? [])[index]
      if (picked === undefined) return
      const find = (current: readonly Guide[]): number => current.findIndex((guide) => guide.axis === picked.axis && guide.position === picked.position)
      if (final.overRuler) {
        void editGuides('删除参考线', (current) => {
          const at = find(current)
          return at < 0 ? null : current.filter((_, other) => other !== at)
        })
      } else if (picked.position !== final.position) {
        void editGuides('移动参考线', (current) => {
          const at = find(current)
          return at < 0 ? null : current.map((guide, other) => other === at ? { axis, position: final.position } : guide)
        })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const line = (axis: Guide['axis'], position: number, key: string, index: number | null, preview = false): React.JSX.Element => {
    const at = axis === 'x' ? originX + position * zoom : originY + position * zoom
    return (
      <div
        key={key}
        className={`view-guide is-${axis}${preview ? ' is-preview' : ''}`}
        data-testid={index === null ? undefined : `guide-${axis}-${index}`}
        style={axis === 'x' ? { left: at - 3, top: 0, height } : { top: at - 3, left: 0, width }}
        onPointerDown={index === null || !interactive ? undefined : (event) => begin(event, axis, index)}
        aria-hidden="true"
      >
        <span style={{ background: GUIDE_COLOR }} />
      </div>
    )
  }

  return (
    <div ref={root} className={`view-overlay${interactive ? ' is-interactive' : ''}`} style={{ width, height }}>
      {view.grid && <canvas ref={grid} className="view-grid" style={{ width, height }} aria-hidden="true" />}
      {view.guides && guides.map((guide, index) => drag?.index === index ? null : line(guide.axis, guide.position, `guide-${index}`, index))}
      {drag !== null && !drag.overRuler && line(drag.axis, drag.position, 'drag', null, true)}
      {drag !== null && (
        <span className="view-guide-readout" style={drag.axis === 'x' ? { left: originX + drag.position * zoom + 6, top: RULER_SIZE + 6 } : { top: originY + drag.position * zoom + 6, left: RULER_SIZE + 6 }}>
          {drag.overRuler ? '松开即删除' : `${drag.axis === 'x' ? 'X' : 'Y'} ${drag.position}`}
        </span>
      )}
      {view.rulers && (
        <>
          <canvas ref={top} className="view-ruler is-top" data-testid="ruler-top" style={{ width, height: RULER_SIZE }} onPointerDown={(event) => begin(event, 'y', null)} />
          <canvas ref={left} className="view-ruler is-left" data-testid="ruler-left" style={{ width: RULER_SIZE, height }} onPointerDown={(event) => begin(event, 'x', null)} />
          <span className="view-ruler-corner" aria-hidden="true" />
        </>
      )}
    </div>
  )
}
