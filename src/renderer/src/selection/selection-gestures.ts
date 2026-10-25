import {
  combineMasks,
  ellipseMask,
  featherMask,
  magicWandMask,
  polygonMask,
  rectMask,
  sampleMask,
  translateMask,
  type GrayMask,
  type MaskCombine,
  type MaskRect
} from '../../../shared/mask-raster'
import { showAppNotice } from '../components/app-notice'
import type { SelectionTool } from '../store/workspace-store'
import { samplePixels } from './selection-sampling'
import { currentSelection, setSelectionDraft, setSelectionMask, useSelectionStore } from './selection-store'

/*
 * The selection tools on the canvas, as in Photoshop. Points are canvas
 * pixels. Shift at the start of a gesture adds to the selection, Alt
 * subtracts, both intersect; pressed during a marquee drag, Shift makes a
 * square or circle and Alt draws from the centre. Dragging inside the
 * selection with no modifier moves the selection itself.
 */

export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

export interface GestureModifiers {
  readonly shift: boolean
  readonly alt: boolean
}

export interface CanvasSize {
  readonly width: number
  readonly height: number
}

/** The object selection's model calls, which the stage registers once the models are wired. */
export interface ObjectSelector {
  /** The object under a point, as a canvas-size mask, or null when there is none or the model is not ready. */
  atPoint(point: CanvasPoint): Promise<GrayMask | null>
  /** The main subject inside a rectangle. */
  inBox(rect: MaskRect): Promise<GrayMask | null>
}

let objectSelector: ObjectSelector | null = null

export function setObjectSelector(next: ObjectSelector | null): void {
  objectSelector = next
}

type Gesture =
  | { readonly kind: 'shape'; readonly tool: 'marquee-rect' | 'marquee-ellipse' | 'object-select'; readonly start: CanvasPoint; current: CanvasPoint; readonly mode: MaskCombine; readonly startShift: boolean; readonly startAlt: boolean; shiftReleased: boolean; altReleased: boolean }
  | { readonly kind: 'lasso'; readonly points: number[]; readonly mode: MaskCombine }
  | { readonly kind: 'move'; readonly start: CanvasPoint; readonly mask: GrayMask; offset: CanvasPoint }

let gesture: Gesture | null = null
let polygon: { readonly points: number[]; readonly mode: MaskCombine; cursor: CanvasPoint | null } | null = null
let canvasSize: CanvasSize = { width: 1, height: 1 }
/** A gesture's result is kept only if no newer one started while a model ran. */
let generation = 0

export function gestureMode(modifiers: GestureModifiers): MaskCombine {
  if (modifiers.shift && modifiers.alt) return 'intersect'
  if (modifiers.shift) return 'add'
  if (modifiers.alt) return 'subtract'
  return useSelectionStore.getState().settings.mode
}

function finishShape(shape: GrayMask, mode: MaskCombine, feather: boolean): void {
  const radius = feather ? useSelectionStore.getState().settings.feather : 0
  const soft = radius > 0 ? featherMask(shape, radius) : shape
  setSelectionMask(combineMasks(currentSelection(), soft, mode))
}

/** The rectangle a marquee drag spans, squared with Shift and centred with Alt once pressed during the drag. */
function marqueeRect(state: Extract<Gesture, { kind: 'shape' }>, modifiers: GestureModifiers): MaskRect {
  if (!modifiers.shift) state.shiftReleased = true
  if (!modifiers.alt) state.altReleased = true
  const constrain = modifiers.shift && (!state.startShift || state.shiftReleased)
  const fromCentre = modifiers.alt && (!state.startAlt || state.altReleased)
  let dx = state.current.x - state.start.x
  let dy = state.current.y - state.start.y
  if (constrain && state.tool !== 'object-select') {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * side
    dy = Math.sign(dy || 1) * side
  }
  const rect = fromCentre && state.tool !== 'object-select'
    ? { x: state.start.x - dx, y: state.start.y - dy, width: dx * 2, height: dy * 2 }
    : { x: state.start.x, y: state.start.y, width: dx, height: dy }
  const x = Math.min(rect.x, rect.x + rect.width)
  const y = Math.min(rect.y, rect.y + rect.height)
  const normal = { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) }
  if (state.tool !== 'marquee-rect') return normal
  // The rectangular marquee follows whole pixels, as Photoshop's does.
  const left = Math.round(normal.x)
  const top = Math.round(normal.y)
  return { x: left, y: top, width: Math.round(normal.x + normal.width) - left, height: Math.round(normal.y + normal.height) - top }
}

function insideSelection(point: CanvasPoint): boolean {
  const mask = currentSelection()
  return mask !== null && sampleMask(mask, point.x, point.y) >= 128
}

async function magicWand(point: CanvasPoint, mode: MaskCombine): Promise<void> {
  const ticket = ++generation
  const settings = useSelectionStore.getState().settings
  const pixels = await samplePixels(settings.sampleAllLayers)
  if (ticket !== generation) return
  if (pixels === null) {
    showAppNotice('画面还没画好，稍后再点一次。')
    return
  }
  const shape = magicWandMask(pixels.rgba, pixels.width, pixels.height, point.x, point.y, settings.wandTolerance, settings.wandContiguous, settings.antialias)
  finishShape(shape, mode, false)
}

async function objectSelect(run: () => Promise<GrayMask | null>, mode: MaskCombine): Promise<void> {
  const ticket = ++generation
  if (objectSelector === null) {
    showAppNotice('对象选择还没准备好，稍后再试。')
    return
  }
  const shape = await run()
  if (ticket !== generation || shape === null) return
  finishShape(shape, mode, false)
}

/** Whether the polygonal lasso has points down and is waiting for the next click. */
export function polygonLassoActive(): boolean {
  return polygon !== null
}

function showPolygon(): void {
  if (polygon === null) { setSelectionDraft(null); return }
  setSelectionDraft({ kind: 'polygon', points: [...polygon.points], closed: false, cursor: polygon.cursor === null ? null : [polygon.cursor.x, polygon.cursor.y] })
}

function closePolygon(): void {
  const done = polygon
  polygon = null
  setSelectionDraft(null)
  if (done === null || done.points.length < 6) return
  finishShape(polygonMask(canvasSize.width, canvasSize.height, done.points), done.mode, true)
}

/**
 * A press with a selection tool. closeRadius is how near the first point
 * of a polygonal lasso a click closes it, in canvas pixels; clicks counts
 * the presses of a double-click.
 */
export function selectionPointerDown(tool: SelectionTool, point: CanvasPoint, modifiers: GestureModifiers, size: CanvasSize, closeRadius: number, clicks: number): void {
  canvasSize = size
  if (tool === 'lasso-polygon') {
    if (polygon === null) {
      polygon = { points: [point.x, point.y], mode: gestureMode(modifiers), cursor: null }
    } else {
      const [x0, y0] = [polygon.points[0]!, polygon.points[1]!]
      if (polygon.points.length >= 6 && (Math.hypot(point.x - x0, point.y - y0) <= closeRadius || clicks >= 2)) {
        closePolygon()
        return
      }
      const lastX = polygon.points[polygon.points.length - 2]!
      const lastY = polygon.points[polygon.points.length - 1]!
      if (Math.hypot(point.x - lastX, point.y - lastY) > 0.5) polygon.points.push(point.x, point.y)
    }
    showPolygon()
    return
  }
  const mode = gestureMode(modifiers)
  const selection = currentSelection()
  if (mode === 'replace' && !modifiers.shift && !modifiers.alt && selection !== null && insideSelection(point)) {
    gesture = { kind: 'move', start: point, mask: selection, offset: { x: 0, y: 0 } }
    return
  }
  if (tool === 'magic-wand') {
    void magicWand(point, mode)
    return
  }
  if (tool === 'lasso') {
    gesture = { kind: 'lasso', points: [point.x, point.y], mode }
    setSelectionDraft({ kind: 'polygon', points: [point.x, point.y], closed: false, cursor: null })
    return
  }
  gesture = { kind: 'shape', tool, start: point, current: point, mode, startShift: modifiers.shift, startAlt: modifiers.alt, shiftReleased: false, altReleased: false }
}

export function selectionPointerMove(point: CanvasPoint, modifiers: GestureModifiers): void {
  if (polygon !== null) {
    polygon.cursor = point
    showPolygon()
    return
  }
  const state = gesture
  if (state === null) return
  if (state.kind === 'move') {
    state.offset = { x: Math.round(point.x - state.start.x), y: Math.round(point.y - state.start.y) }
    setSelectionDraft(null, { dx: state.offset.x, dy: state.offset.y })
    return
  }
  if (state.kind === 'lasso') {
    const lastX = state.points[state.points.length - 2]!
    const lastY = state.points[state.points.length - 1]!
    if (Math.hypot(point.x - lastX, point.y - lastY) < 0.75) return
    state.points.push(point.x, point.y)
    setSelectionDraft({ kind: 'polygon', points: state.points, closed: false, cursor: null })
    return
  }
  state.current = point
  const rect = marqueeRect(state, modifiers)
  setSelectionDraft({ kind: state.tool === 'marquee-ellipse' ? 'ellipse' : 'rect', ...rect })
}

export function selectionPointerUp(point: CanvasPoint, modifiers: GestureModifiers): void {
  const state = gesture
  gesture = null
  if (state === null) return
  setSelectionDraft(null)
  if (state.kind === 'move') {
    const dx = Math.round(point.x - state.start.x)
    const dy = Math.round(point.y - state.start.y)
    if (dx !== 0 || dy !== 0) setSelectionMask(translateMask(state.mask, dx, dy))
    return
  }
  if (state.kind === 'lasso') {
    state.points.push(point.x, point.y)
    let area = 0
    for (let index = 0, count = state.points.length / 2; index < count; index += 1) {
      const next = (index + 1) % count
      area += state.points[index * 2]! * state.points[next * 2 + 1]! - state.points[next * 2]! * state.points[index * 2 + 1]!
    }
    if (Math.abs(area) / 2 < 1) {
      // A click with the lasso drops the selection, as in Photoshop.
      if (state.mode === 'replace') setSelectionMask(null)
      return
    }
    finishShape(polygonMask(canvasSize.width, canvasSize.height, state.points), state.mode, true)
    return
  }
  state.current = point
  const rect = marqueeRect(state, modifiers)
  if (state.tool === 'object-select') {
    if (rect.width < 3 && rect.height < 3) void objectSelect(() => objectSelector!.atPoint(point), state.mode)
    else void objectSelect(() => objectSelector!.inBox(rect), state.mode)
    return
  }
  if (rect.width < 1 || rect.height < 1) {
    if (state.mode === 'replace') setSelectionMask(null)
    return
  }
  const antialias = useSelectionStore.getState().settings.antialias
  const shape = state.tool === 'marquee-rect'
    ? rectMask(canvasSize.width, canvasSize.height, rect)
    : ellipseMask(canvasSize.width, canvasSize.height, rect)
  if (!antialias && state.tool === 'marquee-ellipse') for (let index = 0; index < shape.data.length; index += 1) shape.data[index] = shape.data[index]! >= 128 ? 255 : 0
  finishShape(shape, state.mode, true)
}

/** Keys while the polygonal lasso is open: Backspace takes back a point, Enter closes, Escape cancels. */
export function selectionKeyDown(event: KeyboardEvent): boolean {
  if (polygon === null) {
    if (event.key === 'Escape' && gesture !== null) { cancelSelectionGesture(); return true }
    return false
  }
  if (event.key === 'Escape') { cancelSelectionGesture(); return true }
  if (event.key === 'Enter') { closePolygon(); return true }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    polygon.points.splice(-2, 2)
    if (polygon.points.length === 0) polygon = null
    showPolygon()
    return true
  }
  return false
}

export function cancelSelectionGesture(): void {
  gesture = null
  polygon = null
  generation += 1
  setSelectionDraft(null)
}

/** Photoshop's arrow keys with a selection tool: the selection moves 1 pixel, or 10 with Shift. */
export function nudgeSelection(dx: number, dy: number): boolean {
  const mask = currentSelection()
  if (mask === null) return false
  setSelectionMask(translateMask(mask, dx, dy))
  return true
}
