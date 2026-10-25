import type { PaintOp, SceneElement } from '../../../domain'
import { showAppNotice } from '../components/app-notice'
import { useWorkspaceStore, type PaintTool } from '../store/workspace-store'
import { drawRect } from './image-effects'
import { applyLiveOp, beginLiveStroke, discardPixelLayer, layerSourceImage, refreshPixelLayer, type LiveStroke } from './pixel-layers'

/*
 * Painting with the brush, eraser, paint bucket and gradient on the
 * selected image layer, as in Photoshop. Pointer positions become the
 * layer's own pixel coordinates (through its place, rotation, crop and
 * fit); each stroke, fill or gradient is drawn into the layer's canvas at
 * once and then recorded on the layer as one undoable operation.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>

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
  /** Layer pixels per canvas pixel, for brush sizes set in canvas pixels. */
  readonly scale: number
}

/** The layer pixel under a point on the stage, through the layer's place, rotation, crop and fit. */
export function stageToLayer(element: ImageElement, image: { readonly width: number; readonly height: number }, geometry: PaintGeometry, stageX: number, stageY: number): LayerPoint {
  const ox = (stageX - geometry.origin.x) / geometry.zoom
  const oy = (stageY - geometry.origin.y) / geometry.zoom
  const boxWidth = element.transform.width * geometry.canvasWidth
  const boxHeight = element.transform.height * geometry.canvasHeight
  const dx = ox - element.transform.x * geometry.canvasWidth
  const dy = oy - element.transform.y * geometry.canvasHeight
  const angle = element.transform.rotation * Math.PI / 180
  const lx = dx * Math.cos(angle) + dy * Math.sin(angle)
  const ly = -dx * Math.sin(angle) + dy * Math.cos(angle)
  const { crop, draw } = drawRect(image, element, boxWidth, boxHeight)
  const scale = crop.width / draw.width
  return { x: crop.x + (lx - draw.x) * scale, y: crop.y + (ly - draw.y) * (crop.height / draw.height), scale }
}

/** The single selected image layer that can take paint, or why there is none, said once. */
export function paintTarget(): ImageElement | null {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const element = selectedIds.length === 1 ? scene.elements.find((candidate) => candidate.id === selectedIds[0]) : undefined
  const refuse = (message: string): null => { showAppNotice(message); return null }
  if (element === undefined) return refuse('先在图层里选中一个图片图层，或按 Ctrl+Shift+N 新建空白图层，再开始画。')
  if (element.type === 'text' || element.type === 'shape') return refuse(`「${element.name}」是${element.type === 'text' ? '文字' : '形状'}图层，要先栅格化（图层右键菜单）才能画。`)
  if (element.type !== 'image') return refuse('只能在图片图层上画。选中一个图片图层，或按 Ctrl+Shift+N 新建空白图层。')
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能画。`)
  if (!element.visible) return refuse(`「${element.name}」是隐藏的，显示后才能画。`)
  return element
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
    const current = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === elementId)
    if (current?.type !== 'image') return
    const covered = new Set(baked.paintIds)
    await useWorkspaceStore.getState().updateElement(elementId, { assetId: baked.assetId, paint: (current.paint ?? []).filter((op) => !covered.has(op.id)) }, '合并绘制记录')
  } catch {
    // The operations stay recorded; the next stroke tries again.
  } finally {
    baking.delete(elementId)
  }
}

async function record(element: ImageElement, op: PaintOp, summary: string): Promise<boolean> {
  const current = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === element.id)
  const paint = current?.type === 'image' ? current.paint ?? [] : element.paint ?? []
  const saved = await useWorkspaceStore.getState().updateElement(element.id, { paint: [...paint, op] }, summary)
  if (!saved) discardPixelLayer(element.id)
  else void bakeIfLong(element.id)
  return saved
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

export interface PaintSession {
  move(stageX: number, stageY: number, pressure: number): void
  end(stageX: number, stageY: number, shift: boolean): void
  cancel(): void
}

/**
 * Starts a brush or eraser stroke at a stage point. lastPoint, in layer
 * pixels, is where the previous stroke on this layer ended: with Shift the
 * stroke runs straight from there, as in Photoshop.
 */
export function startStroke(
  tool: 'brush' | 'eraser',
  element: ImageElement,
  geometry: PaintGeometry,
  stageX: number,
  stageY: number,
  pressure: number | null,
  lastPoint: { readonly x: number; readonly y: number } | null,
  redraw: () => void,
  onEnd: (point: { readonly x: number; readonly y: number }) => void
): PaintSession | null {
  const image = layerSourceImage(element.id)
  if (image === null) return null
  const { paintSettings, foregroundColor, backgroundColor } = useWorkspaceStore.getState()
  const settings = paintSettings[tool]
  const start = stageToLayer(element, { width: image.naturalWidth, height: image.naturalHeight }, geometry, stageX, stageY)
  const brush = {
    kind: 'stroke' as const,
    tool,
    // An eraser on a transparency-locked layer paints the background colour, as in Photoshop.
    color: (tool === 'brush' ? foregroundColor : backgroundColor).toUpperCase(),
    size: Math.max(0.5, Math.min(5000, round(settings.size * start.scale))),
    hardness: settings.hardness,
    opacity: settings.opacity,
    flow: settings.flow,
    pressure: pressure !== null,
    lockAlpha: element.transparencyLocked === true
  }
  const live = beginLiveStroke(element.id, image, element.paint ?? [], brush)
  if (live === null) return null
  const stroke: LiveStroke = live.stroke
  const points: number[] = []
  const hasEffects = element.effects !== undefined
  let frame: number | null = null
  const show = (): void => {
    redraw()
    // A layer with effects is shown from a copy, which is redrawn at most once a frame.
    if (hasEffects && frame === null) frame = requestAnimationFrame(() => { frame = null; refreshPixelLayer(element.id) })
  }
  const add = (x: number, y: number, p: number): void => {
    if (points.length >= 60_000) return
    const px = round(x)
    const py = round(y)
    const pp = round(Math.max(0, Math.min(1, p)))
    points.push(px, py, pp)
    if (stroke.addPoint(px, py, pp)) show()
  }
  if (lastPoint !== null) add(lastPoint.x, lastPoint.y, pressure ?? 1)
  add(start.x, start.y, pressure ?? 1)
  let ended = false
  return {
    move: (x, y, p) => {
      if (ended) return
      const point = stageToLayer(element, { width: image.naturalWidth, height: image.naturalHeight }, geometry, x, y)
      add(point.x, point.y, pressure === null ? 1 : p)
    },
    end: () => {
      if (ended) return
      ended = true
      if (frame !== null) cancelAnimationFrame(frame)
      const op: PaintOp = { ...brush, id: newId(), points }
      stroke.commit(op)
      onEnd({ x: points[points.length - 3]!, y: points[points.length - 2]! })
      void record(element, op, tool === 'brush' ? '画笔' : '橡皮擦')
    },
    cancel: () => {
      if (ended) return
      ended = true
      stroke.cancel()
    }
  }
}

/** The paint bucket at a stage point. */
export function fillAt(element: ImageElement, geometry: PaintGeometry, stageX: number, stageY: number, redraw: () => void): void {
  const image = layerSourceImage(element.id)
  if (image === null) return
  const { paintSettings, foregroundColor } = useWorkspaceStore.getState()
  const point = stageToLayer(element, { width: image.naturalWidth, height: image.naturalHeight }, geometry, stageX, stageY)
  const op: PaintOp = {
    id: newId(), kind: 'fill', x: round(point.x), y: round(point.y), color: foregroundColor.toUpperCase(),
    tolerance: paintSettings.bucket.tolerance, contiguous: paintSettings.bucket.contiguous, opacity: paintSettings.bucket.opacity,
    lockAlpha: element.transparencyLocked === true
  }
  if (applyLiveOp(element.id, image, element.paint ?? [], op) === null) return
  redraw()
  void record(element, op, '油漆桶')
}

/** A gradient from one stage point to another, foreground to background. */
export function gradientBetween(element: ImageElement, geometry: PaintGeometry, from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, redraw: () => void): void {
  const image = layerSourceImage(element.id)
  if (image === null) return
  const { paintSettings, foregroundColor, backgroundColor } = useWorkspaceStore.getState()
  const size = { width: image.naturalWidth, height: image.naturalHeight }
  const start = stageToLayer(element, size, geometry, from.x, from.y)
  const end = stageToLayer(element, size, geometry, to.x, to.y)
  const op: PaintOp = {
    id: newId(), kind: 'gradient', shape: paintSettings.gradient.shape,
    from: [round(start.x), round(start.y)], to: [round(end.x), round(end.y)],
    colors: [foregroundColor.toUpperCase(), backgroundColor.toUpperCase()], opacity: paintSettings.gradient.opacity,
    lockAlpha: element.transparencyLocked === true
  }
  if (applyLiveOp(element.id, image, element.paint ?? [], op) === null) return
  redraw()
  void record(element, op, '渐变')
}

/** Photoshop's Alt or Ctrl+Backspace on an image layer: the whole layer filled with a colour. */
export function fillLayer(element: ImageElement, color: string, summary: string): Promise<boolean> {
  const op: PaintOp = { id: newId(), kind: 'fill-all', color: color.toUpperCase(), opacity: 1, lockAlpha: element.transparencyLocked === true }
  return record(element, op, summary)
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
