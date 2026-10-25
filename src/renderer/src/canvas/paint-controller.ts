import type { LayerMask, PaintOp, SceneElement } from '../../../domain'
import { boxLayerSpace, canvasToLayer, imageLayerSpace, type LayerSpace } from '../../../shared/layer-space'
import { maskGray, paintClipIds, startsWithBaked } from '../../../shared/paint-ops'
import { showAppNotice } from '../components/app-notice'
import { selectionClip, type SelectionClip } from '../selection/selection-clip'
import { useSelectionStore } from '../selection/selection-store'
import { useWorkspaceStore, type PaintTool } from '../store/workspace-store'
import { clipLookup } from './asset-pixels'
import { useMaskState } from './mask-state'
import {
  applyLiveMaskOp,
  applyLiveOp,
  beginLiveMaskStroke,
  beginLiveStroke,
  discardPixelLayer,
  layerMaskSnapshot,
  layerSourceImage,
  maskSize,
  refreshPixelLayer,
  type LiveStroke
} from './pixel-layers'

/*
 * Painting with the brush, eraser, paint bucket and gradient on the
 * selected image layer, or on the selected layer's mask, as in Photoshop.
 * Pointer positions become the target's own pixel coordinates (through the
 * layer's place, rotation, crop and fit); each stroke, fill or gradient is
 * drawn at once and then recorded on the layer as one undoable operation.
 * With a selection, every operation stays inside it.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>
type MaskableElement = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

/** After this many operations the layer's paint is baked into a new asset. */
const BAKE_AFTER = 100
/** Points are kept to a hundredth of a pixel, live and recorded alike, so a replay matches what was drawn. */
const round = (value: number): number => Math.round(value * 100) / 100

export interface PaintGeometry {
  /** Where the artboard's top-left corner is on the stage, and the stage pixels per canvas pixel. */
  readonly origin: { readonly x: number; readonly y: number }
  readonly zoom: number
  readonly canvasWidth: number
  readonly canvasHeight: number
}

export interface LayerPoint {
  readonly x: number
  readonly y: number
  /** Target pixels per canvas pixel, for brush sizes set in canvas pixels. */
  readonly scale: number
}

/** What a painting tool works on: an image layer's pixels, or a layer's mask. */
export interface PaintTarget {
  readonly element: MaskableElement
  readonly onMask: boolean
  readonly space: LayerSpace
}

function canvasSize(): { readonly width: number; readonly height: number } {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return { width: outputWidth, height: outputHeight }
}

function spaceFor(element: MaskableElement, onMask: boolean): LayerSpace | null {
  if (element.type === 'image') {
    const image = layerSourceImage(element.id)
    return image === null ? null : imageLayerSpace(element, { width: image.naturalWidth, height: image.naturalHeight }, canvasSize())
  }
  const size = onMask ? maskSize(element.id) : null
  return size === null ? null : boxLayerSpace(element, size, canvasSize())
}

/** The target pixel under a point on the stage. */
export function stageToTarget(target: PaintTarget, geometry: PaintGeometry, stageX: number, stageY: number): LayerPoint {
  const back = canvasToLayer(target.space)
  const [x, y] = back.at((stageX - geometry.origin.x) / geometry.zoom, (stageY - geometry.origin.y) / geometry.zoom)
  return { x, y, scale: back.scale }
}

/** The single selected layer that can take paint (or whose mask is being edited), or why there is none, said once. */
export function paintTarget(): PaintTarget | null {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const element = selectedIds.length === 1 ? scene.elements.find((candidate) => candidate.id === selectedIds[0]) : undefined
  const refuse = (message: string): null => { showAppNotice(message); return null }
  if (element === undefined) return refuse('先在图层里选中一个图片图层，或按 Ctrl+Shift+N 新建空白图层，再开始画。')
  const editingMask = useMaskState.getState().editing === element.id && (element.type === 'image' || element.type === 'text' || element.type === 'shape') && element.mask !== null && element.mask !== undefined
  if (!editingMask) {
    if (element.type === 'text' || element.type === 'shape') return refuse(`「${element.name}」是${element.type === 'text' ? '文字' : '形状'}图层，要先栅格化（图层右键菜单）才能画；也可以给它加蒙版，在蒙版上画。`)
    if (element.type !== 'image') return refuse('只能在图片图层上画。选中一个图片图层，或按 Ctrl+Shift+N 新建空白图层。')
  }
  const target = element as MaskableElement
  if (target.locked) return refuse(`「${target.name}」已锁定，解锁后才能画。`)
  if (!target.visible) return refuse(`「${target.name}」是隐藏的，显示后才能画。`)
  const space = spaceFor(target, editingMask)
  if (space === null) return refuse(`「${target.name}」还没画好，稍后再试。`)
  return { element: target, onMask: editingMask, space }
}

const baking = new Set<string>()

/** Bakes a layer's paint into a new asset once it has many operations; the scene keeps any added meanwhile. */
async function bakeIfLong(elementId: string): Promise<void> {
  const element = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === elementId)
  if (element?.type !== 'image' || (element.paint?.length ?? 0) < BAKE_AFTER || baking.has(elementId)) return
  baking.add(elementId)
  try {
    const baked = await window.desktop.bakePaint(elementId)
    if (baked === null) return
    // Checked when the batch runs, after any undo queued before it.
    await useWorkspaceStore.getState().execute('合并绘制记录', (scene) => {
      const current = scene.elements.find((candidate) => candidate.id === elementId)
      if (current?.type !== 'image' || current.assetId !== element.assetId || !startsWithBaked(current.paint, baked.paintIds)) return null
      return [{ kind: 'element.update', elementId, changes: { assetId: baked.assetId, paint: (current.paint ?? []).slice(baked.paintIds.length) } }]
    })
  } catch {
    // The operations stay recorded; the next stroke tries again.
  } finally {
    baking.delete(elementId)
  }
}

function currentElement(id: string): MaskableElement | null {
  const element = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === id)
  return element !== undefined && (element.type === 'image' || element.type === 'text' || element.type === 'shape') ? element : null
}

/** Records the operation once its clip, if any, has been imported; a clip that fails to import drops the operation. */
async function record(target: PaintTarget, op: PaintOp, clip: SelectionClip, summary: string): Promise<boolean> {
  let recorded = op
  if (clip.kind === 'clip') {
    const clipId = await clip.assetId
    if (clipId === null) {
      discardPixelLayer(target.element.id)
      showAppNotice('选区没有存好，这一笔没有记下。', 'problem')
      return false
    }
    recorded = { ...op, clip: clipId }
  }
  const current = currentElement(target.element.id) ?? target.element
  let saved: boolean
  if (target.onMask) {
    const mask = current.mask ?? target.element.mask
    if (mask === null || mask === undefined) { discardPixelLayer(target.element.id); return false }
    const next: LayerMask = { ...mask, paint: [...mask.paint ?? [], recorded] }
    saved = await useWorkspaceStore.getState().updateElement(target.element.id, { mask: next }, `${summary}（蒙版）`)
  } else {
    const paint = current.type === 'image' ? current.paint ?? [] : []
    saved = await useWorkspaceStore.getState().updateElement(target.element.id, { paint: [...paint, recorded] }, summary)
  }
  if (!saved) discardPixelLayer(target.element.id)
  else void (target.onMask ? bakeMaskIfLong(target.element.id) : bakeIfLong(target.element.id))
  return saved
}

/**
 * Bakes a mask's paint into a new gray asset once it has many operations,
 * from the pixels the canvas already holds; the mask stays editable and
 * keeps any operations added meanwhile.
 */
async function bakeMaskIfLong(elementId: string): Promise<void> {
  const mask = currentElement(elementId)?.mask
  if (mask === null || mask === undefined || (mask.paint?.length ?? 0) < BAKE_AFTER || baking.has(elementId)) return
  const snapshot = layerMaskSnapshot(elementId)
  const recorded = (mask.paint ?? []).map((op) => op.id)
  // Only pixels that hold exactly the recorded operations, none mid-stroke, are baked.
  if (snapshot === null || snapshot.assetId !== mask.assetId || snapshot.applied.length !== recorded.length || snapshot.applied.some((id, index) => id !== recorded[index])) return
  baking.add(elementId)
  try {
    const { scene } = useWorkspaceStore.getState()
    const asset = await window.desktop.importPixels({ projectId: scene.projectId, name: '蒙版.png', width: snapshot.width, height: snapshot.height, gray: snapshot.coverage })
    // Checked when the batch runs, after any undo queued before it.
    await useWorkspaceStore.getState().execute('合并蒙版绘制记录', (scene) => {
      const element = scene.elements.find((candidate) => candidate.id === elementId)
      const current = element !== undefined && (element.type === 'image' || element.type === 'text' || element.type === 'shape') ? element.mask : null
      if (current === null || current === undefined || current.assetId !== mask.assetId || !startsWithBaked(current.paint, snapshot.applied)) return null
      return [{ kind: 'element.update', elementId, changes: { mask: { ...current, assetId: asset.id, paint: (current.paint ?? []).slice(snapshot.applied.length) } } }]
    })
  } catch {
    // The operations stay recorded; the next stroke tries again.
  } finally {
    baking.delete(elementId)
  }
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

/** The selection for this target, or null (said once) when it misses the layer. */
function clipFor(target: PaintTarget): SelectionClip | null {
  const clip = selectionClip(target.element, target.space, target.onMask ? 'mask' : 'layer')
  if (clip.kind === 'outside') {
    showAppNotice(`选区不在「${target.element.name}」上，画不到。`)
    return null
  }
  return clip
}

function clipPixels(clip: SelectionClip): Uint8Array | null {
  return clip.kind === 'clip' ? clip.pixels : null
}

/** The colours a tool paints with: on a mask, the gray of each colour's luminosity. */
function paintColor(target: PaintTarget, color: string): string {
  return target.onMask ? maskGray(color) : color.toUpperCase()
}

/**
 * A one-shot operation on the target, shown at once when the layer has been
 * drawn, then recorded. Without a selection it is recorded either way and
 * the layer replays it when it draws.
 */
function applyOnce(target: PaintTarget, op: PaintOp, clip: SelectionClip, summary: string, redraw: () => void): Promise<boolean> {
  const pixels = clipPixels(clip)
  // The live operation finds its clip under a stand-in id until the asset's own id is known.
  const live: PaintOp = pixels === null ? op : { ...op, clip: op.id }
  let applied: boolean
  if (target.onMask) {
    applied = applyLiveMaskOp(target.element.id, live, pixels)
  } else {
    const element = target.element as ImageElement
    const image = layerSourceImage(element.id)
    const clips = clipLookup(paintClipIds(element.paint), { width: target.space.width, height: target.space.height })
    applied = image !== null && clips !== null && applyLiveOp(element.id, image, element.paint ?? [], clips, live, pixels)
  }
  if (!applied && clip.kind !== 'none') return Promise.resolve(false)
  if (applied) redraw()
  return record(target, op, clip, summary)
}

/** Stands in for a layer not drawn yet, when nothing is selected and no pixels need mapping. */
const UNPLACED: LayerSpace = { width: 1, height: 1, toCanvas: (x, y) => [x, y] }

export interface PaintSession {
  move(stageX: number, stageY: number, pressure: number): void
  end(stageX: number, stageY: number, shift: boolean): void
  cancel(): void
}

/**
 * Starts a brush or eraser stroke at a stage point. lastPoint, in target
 * pixels, is where the previous stroke on this layer ended: with Shift the
 * stroke runs straight from there, as in Photoshop.
 */
export function startStroke(
  tool: 'brush' | 'eraser',
  target: PaintTarget,
  geometry: PaintGeometry,
  stageX: number,
  stageY: number,
  pressure: number | null,
  lastPoint: { readonly x: number; readonly y: number } | null,
  redraw: () => void,
  onEnd: (point: { readonly x: number; readonly y: number }) => void
): PaintSession | null {
  const clip = clipFor(target)
  if (clip === null) return null
  const { paintSettings, foregroundColor, backgroundColor } = useWorkspaceStore.getState()
  const settings = paintSettings[tool]
  const start = stageToTarget(target, geometry, stageX, stageY)
  const element = target.element
  const brush = {
    kind: 'stroke' as const,
    tool,
    // An eraser on a transparency-locked layer, or on a mask, paints the background colour, as in Photoshop.
    color: paintColor(target, tool === 'brush' ? foregroundColor : backgroundColor),
    size: Math.max(0.5, Math.min(5000, round(settings.size * start.scale))),
    hardness: settings.hardness,
    opacity: settings.opacity,
    flow: settings.flow,
    pressure: pressure !== null,
    lockAlpha: target.onMask || (element.type === 'image' && element.transparencyLocked === true)
  }
  let stroke: LiveStroke | null
  if (target.onMask) {
    stroke = beginLiveMaskStroke(element.id, brush, clipPixels(clip))
  } else {
    const image = layerSourceImage(element.id)
    const ops = element.type === 'image' ? element.paint ?? [] : []
    const clips = clipLookup(paintClipIds(ops), { width: target.space.width, height: target.space.height })
    stroke = image === null || clips === null ? null : beginLiveStroke(element.id, image, ops, clips, brush, clipPixels(clip))
  }
  if (stroke === null) return null
  const live = stroke
  const points: number[] = []
  const redrawsCopy = (element.type === 'image' && element.effects !== undefined) || element.type !== 'image'
  let frame: number | null = null
  const show = (): void => {
    redraw()
    // A layer shown from a copy (effects, or a masked text or shape) is redrawn at most once a frame.
    if (redrawsCopy && frame === null) frame = requestAnimationFrame(() => { frame = null; refreshPixelLayer(element.id) })
  }
  const add = (x: number, y: number, p: number): void => {
    if (points.length >= 60_000) return
    const px = round(x)
    const py = round(y)
    const pp = round(Math.max(0, Math.min(1, p)))
    points.push(px, py, pp)
    if (live.addPoint(px, py, pp)) show()
  }
  if (lastPoint !== null) add(lastPoint.x, lastPoint.y, pressure ?? 1)
  add(start.x, start.y, pressure ?? 1)
  let ended = false
  return {
    move: (x, y, p) => {
      if (ended) return
      const point = stageToTarget(target, geometry, x, y)
      add(point.x, point.y, pressure === null ? 1 : p)
    },
    end: () => {
      if (ended) return
      ended = true
      if (frame !== null) cancelAnimationFrame(frame)
      const op: PaintOp = { ...brush, id: newId(), points }
      live.commit(op)
      onEnd({ x: points[points.length - 3]!, y: points[points.length - 2]! })
      void record(target, op, clip, tool === 'brush' ? '画笔' : '橡皮擦')
    },
    cancel: () => {
      if (ended) return
      ended = true
      live.cancel()
    }
  }
}

/** The paint bucket at a stage point. */
export function fillAt(target: PaintTarget, geometry: PaintGeometry, stageX: number, stageY: number, redraw: () => void): void {
  const clip = clipFor(target)
  if (clip === null) return
  const { paintSettings, foregroundColor } = useWorkspaceStore.getState()
  const point = stageToTarget(target, geometry, stageX, stageY)
  const op: PaintOp = {
    id: newId(), kind: 'fill', x: round(point.x), y: round(point.y), color: paintColor(target, foregroundColor),
    tolerance: paintSettings.bucket.tolerance, contiguous: paintSettings.bucket.contiguous, opacity: paintSettings.bucket.opacity,
    lockAlpha: target.onMask || (target.element.type === 'image' && target.element.transparencyLocked === true)
  }
  void applyOnce(target, op, clip, '油漆桶', redraw)
}

/** A gradient from one stage point to another, foreground to background. */
export function gradientBetween(target: PaintTarget, geometry: PaintGeometry, from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, redraw: () => void): void {
  const clip = clipFor(target)
  if (clip === null) return
  const { paintSettings, foregroundColor, backgroundColor } = useWorkspaceStore.getState()
  const start = stageToTarget(target, geometry, from.x, from.y)
  const end = stageToTarget(target, geometry, to.x, to.y)
  const op: PaintOp = {
    id: newId(), kind: 'gradient', shape: paintSettings.gradient.shape,
    from: [round(start.x), round(start.y)], to: [round(end.x), round(end.y)],
    colors: [paintColor(target, foregroundColor), paintColor(target, backgroundColor)], opacity: paintSettings.gradient.opacity,
    lockAlpha: target.onMask || (target.element.type === 'image' && target.element.transparencyLocked === true)
  }
  void applyOnce(target, op, clip, '渐变', redraw)
}

/** A target for an action on the selected layer (fill, clear), without a pointer; null when it has no pixels to act on. */
function actionTarget(element: SceneElement): PaintTarget | null {
  const onMask = useMaskState.getState().editing === element.id
  if (!onMask && element.type !== 'image') return null
  if (element.type !== 'image' && element.type !== 'text' && element.type !== 'shape') return null
  const space = spaceFor(element, onMask)
  if (space !== null) return { element, onMask, space }
  // Only a selection needs the layer placed; without one the operation applies to every pixel.
  return useSelectionStore.getState().mask === null && !onMask ? { element, onMask, space: UNPLACED } : null
}

/**
 * Photoshop's Alt or Ctrl+Backspace and Shift+F5 on an image layer or its
 * mask: filled with a colour, inside the selection when there is one.
 */
export function fillLayer(element: SceneElement, color: string, summary: string, opacity = 1): Promise<boolean> {
  const target = actionTarget(element)
  if (target === null) return Promise.resolve(false)
  const clip = clipFor(target)
  if (clip === null) return Promise.resolve(false)
  const op: PaintOp = { id: newId(), kind: 'fill-all', color: paintColor(target, color), opacity, lockAlpha: target.onMask || (element.type === 'image' && element.transparencyLocked === true) }
  return applyOnce(target, op, clip, summary, () => undefined)
}

/**
 * Photoshop's Delete with a selection: the selected pixels cleared. On a
 * transparency-locked layer, or a mask, they fill with the background
 * colour instead, as Photoshop does.
 */
export function clearSelected(element: SceneElement): Promise<boolean> {
  const target = actionTarget(element)
  if (target === null) return Promise.resolve(false)
  if (target.onMask || (element.type === 'image' && element.transparencyLocked === true)) {
    return fillLayer(element, useWorkspaceStore.getState().backgroundColor, '清除')
  }
  const clip = clipFor(target)
  if (clip === null) return Promise.resolve(false)
  return applyOnce(target, { id: newId(), kind: 'clear' }, clip, '清除', () => undefined)
}

/** Gradient drags snap to 45° steps with Shift, as in Photoshop. */
export function constrainAngle(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.sqrt(dx * dx + dy * dy)
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length }
}

export function isStrokeTool(tool: PaintTool): tool is 'brush' | 'eraser' {
  return tool === 'brush' || tool === 'eraser'
}
