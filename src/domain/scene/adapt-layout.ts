import type { SceneCommand } from '../commands/schema'
import type { Canvas, Scene, SceneElement } from './schema'

/*
 * Lays an artwork out again at another size, here on the computer: free
 * and immediate. The same proportions only scale. Otherwise backgrounds
 * fill the new canvas, and everything else is scaled evenly so the whole
 * old picture would fit, then placed by the third of the picture it sits
 * in: the top third keeps its distance from the top (a title with its
 * subtitle stays together), the bottom third from the bottom (a price bar
 * stays at the bottom), the middle keeps its place relative to the
 * picture; the same across. Along the side that grows, this only ever
 * moves things apart, so nothing that did not overlap comes to overlap.
 * Grouped layers move as one, and a full-width bar or line stretches to
 * stay full width. Text grows or shrinks with the layout, so its lines
 * break where they did.
 */

export interface LayoutSize {
  readonly width: number
  readonly height: number
}

type ElementChanges = Partial<SceneElement> & Record<string, unknown>

export interface LayoutAdaptation {
  readonly canvas: Canvas
  /** What changes on each layer, by id; layers left out stay as they are. */
  readonly changes: ReadonlyMap<string, ElementChanges>
}

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A bar or line at least this share of the picture across stretches with it. */
const SPAN = 0.9

function gcd(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b !== 0) [a, b] = [b, a % b]
  return a || 1
}

/** The ratio as the canvas stores it: whole numbers up to 100, the closest such when the exact one is larger. */
export function storedAspect(width: number, height: number): { readonly aspectWidth: number; readonly aspectHeight: number } {
  const divisor = gcd(width, height)
  if (width / divisor <= 100 && height / divisor <= 100) return { aspectWidth: width / divisor, aspectHeight: height / divisor }
  const ratio = width / height
  let best = { aspectWidth: 1, aspectHeight: 1, error: Infinity }
  for (let aspectHeight = 1; aspectHeight <= 100; aspectHeight += 1) {
    const aspectWidth = Math.round(ratio * aspectHeight)
    if (aspectWidth < 1 || aspectWidth > 100) continue
    const error = Math.abs(aspectWidth / aspectHeight - ratio)
    if (error < best.error - 1e-12) best = { aspectWidth, aspectHeight, error }
  }
  return { aspectWidth: best.aspectWidth, aspectHeight: best.aspectHeight }
}

function pixelBox(element: SceneElement, canvas: Canvas): Box {
  return {
    x: element.transform.x * canvas.outputWidth,
    y: element.transform.y * canvas.outputHeight,
    width: element.transform.width * canvas.outputWidth,
    height: element.transform.height * canvas.outputHeight
  }
}

/** The box a layer covers once turned; it turns about its top-left corner, as the canvas draws it. */
function turnedBounds(box: Box, rotation: number): Box {
  const angle = rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners = [[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([dx, dy]) => ({
    x: box.x + dx! * cos - dy! * sin,
    y: box.y + dx! * sin + dy! * cos
  }))
  const left = Math.min(...corners.map((corner) => corner.x))
  const top = Math.min(...corners.map((corner) => corner.y))
  return { x: left, y: top, width: Math.max(...corners.map((corner) => corner.x)) - left, height: Math.max(...corners.map((corner) => corner.y)) - top }
}

function union(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  return { x: left, y: top, width: Math.max(...boxes.map((box) => box.x + box.width)) - left, height: Math.max(...boxes.map((box) => box.y + box.height)) - top }
}

/** A layer that fills the picture behind everything else: a photo or a colour block across the whole canvas. */
export function isBackgroundLayer(element: SceneElement): boolean {
  if (element.type !== 'image' && element.type !== 'shape') return false
  if (element.semanticRole === 'background') return true
  const { x, y, width, height, rotation } = element.transform
  return rotation % 360 === 0 && x <= 0.02 && y <= 0.02 && x + width >= 0.98 && y + height >= 0.98
}

/** Sizes kept in output pixels, which follow the layout's scale. */
function scaledSizes(element: SceneElement, scale: number): ElementChanges {
  if (element.type !== 'text') return {}
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
  return {
    fontSize: clamp(element.fontSize * scale, 8, 512),
    strokeWidth: clamp(element.strokeWidth * scale, 0, 32),
    shadowBlur: clamp(element.shadowBlur * scale, 0, 128),
    letterSpacing: clamp(element.letterSpacing * scale, -100, 100)
  }
}

/** Where a unit's span goes along one axis: by the third its middle is in, the same distance from the near edge, or the same relative place. */
function place(start: number, size: number, length: number, nextSize: number, nextLength: number, scale: number): number {
  const middle = (start + size / 2) / length
  let next: number
  if (middle < 1 / 3) next = start * scale
  else if (middle > 2 / 3) next = nextLength - (length - start - size) * scale - nextSize
  else next = middle * nextLength - nextSize / 2
  if (nextSize >= nextLength) return (nextLength - nextSize) / 2
  return Math.min(nextLength - nextSize, Math.max(0, next))
}

function stretches(element: SceneElement, span: number): boolean {
  return element.type === 'shape' && (element.shape === 'rectangle' || element.shape === 'line') && element.transform.rotation % 360 === 0 && span >= SPAN
}

export function adaptLayout(scene: Scene, size: LayoutSize): LayoutAdaptation {
  const from = scene.canvas
  const canvas: Canvas = { ...from, outputWidth: size.width, outputHeight: size.height, ...storedAspect(size.width, size.height) }
  const scaleX = size.width / from.outputWidth
  const scaleY = size.height / from.outputHeight
  const scale = Math.min(scaleX, scaleY)
  const changes = new Map<string, ElementChanges>()
  const set = (element: SceneElement, change: ElementChanges): void => {
    changes.set(element.id, { ...changes.get(element.id), ...change })
  }
  const normalized = (box: Box, rotation: number): SceneElement['transform'] => ({
    x: box.x / size.width,
    y: box.y / size.height,
    width: Math.max(0.001, box.width / size.width),
    height: Math.max(0.001, box.height / size.height),
    rotation
  })

  // The same proportions: positions are already shares of the canvas, so only pixel sizes follow.
  if (Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) < 0.005) {
    for (const element of scene.elements) {
      const sizes = scaledSizes(element, scale)
      if (Object.keys(sizes).length > 0) set(element, sizes)
    }
    return { canvas, changes }
  }

  const byId = new Map(scene.elements.map((element) => [element.id, element]))
  const rootOf = (element: SceneElement): SceneElement => {
    let current = element
    const seen = new Set<string>()
    while (current.groupId !== null && !seen.has(current.groupId)) {
      seen.add(current.groupId)
      const parent = byId.get(current.groupId)
      if (parent === undefined) break
      current = parent
    }
    return current
  }

  const backgrounds = scene.elements.filter((element) => element.type !== 'group' && isBackgroundLayer(element))
  for (const element of backgrounds) {
    set(element, {
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      // A photo fills the new shape by cropping: never stretched, never left with empty strips beside it.
      ...(element.type === 'image' && element.fit !== 'cover' ? { fit: 'cover' as const } : {})
    })
  }
  const backgroundIds = new Set(backgrounds.map((element) => element.id))

  // Units: each layer outside a group, and each top-level group with everything in it.
  const units = new Map<string, SceneElement[]>()
  for (const element of scene.elements) {
    if (backgroundIds.has(element.id) || element.type === 'group') continue
    const root = rootOf(element)
    units.set(root.id, [...(units.get(root.id) ?? []), element])
  }

  for (const [rootId, members] of units) {
    const root = byId.get(rootId)!
    const bounds = union(members.map((member) => turnedBounds(pixelBox(member, from), member.transform.rotation)))
    const single = members.length === 1 && root.type !== 'group' ? members[0]! : null
    const stretchX = single !== null && stretches(single, bounds.width / from.outputWidth)
    const stretchY = single !== null && stretches(single, bounds.height / from.outputHeight)
    if (single !== null && (stretchX || stretchY)) {
      const box = pixelBox(single, from)
      const width = stretchX ? box.width * scaleX : box.width * scale
      const height = stretchY ? box.height * scaleY : box.height * scale
      set(single, {
        transform: normalized({
          x: stretchX ? box.x * scaleX : place(box.x, box.width, from.outputWidth, width, size.width, scale),
          y: stretchY ? box.y * scaleY : place(box.y, box.height, from.outputHeight, height, size.height, scale),
          width,
          height
        }, single.transform.rotation)
      })
      continue
    }
    const nextWidth = bounds.width * scale
    const nextHeight = bounds.height * scale
    const left = place(bounds.x, bounds.width, from.outputWidth, nextWidth, size.width, scale)
    const top = place(bounds.y, bounds.height, from.outputHeight, nextHeight, size.height, scale)
    const move = (box: Box): Box => ({ x: left + (box.x - bounds.x) * scale, y: top + (box.y - bounds.y) * scale, width: box.width * scale, height: box.height * scale })
    for (const member of members) set(member, { transform: normalized(move(pixelBox(member, from)), member.transform.rotation), ...scaledSizes(member, scale) })
    // The group's own box goes with its layers.
    const groups = new Set<string>()
    for (const member of members) {
      let parentId = member.groupId
      while (parentId !== null && !groups.has(parentId)) {
        groups.add(parentId)
        parentId = byId.get(parentId)?.groupId ?? null
      }
    }
    for (const groupId of groups) {
      const group = byId.get(groupId)
      if (group !== undefined) set(group, { transform: normalized(move(pixelBox(group, from)), group.transform.rotation) })
    }
  }
  return { canvas, changes }
}

/** The scene laid out at the new size, to draw or export; the project itself is not touched. */
export function adaptedScene(scene: Scene, size: LayoutSize): Scene {
  const { canvas, changes } = adaptLayout(scene, size)
  return {
    ...scene,
    canvas,
    elements: scene.elements.map((element) => {
      const change = changes.get(element.id)
      return change === undefined ? element : { ...element, ...change } as SceneElement
    })
  }
}

/** The same layout as commands, to apply to a project as one step that can be undone. */
export function adaptLayoutCommands(scene: Scene, size: LayoutSize): readonly SceneCommand[] {
  const { canvas, changes } = adaptLayout(scene, size)
  return [
    { kind: 'scene.set-canvas', canvas },
    ...[...changes].map(([elementId, change]) => ({ kind: 'element.update' as const, elementId, changes: change }))
  ]
}
