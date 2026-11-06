import type { Scene, SceneElement } from '../../../domain'
import { MAX_EXPORT_EDGE } from '../../../shared/artwork-export'
import { hasVisibleEffects, shadowGeometry } from '../../../shared/layer-effects'
import { isFinalContent } from '../canvas/layer-drawing'

/*
 * Which layers a PSD gets and where each is drawn: the exported kinds,
 * hidden ones too, in their groups, bottom first. A group whose layers are
 * not next to each other in the stack (another layer sits between them)
 * cannot be a Photoshop group without changing the picture, so its layers
 * go in flat, in their own places.
 */

/** hidden: the layer or group is hidden itself, or a group laid out flat around it was. */
export type LayerPlan =
  | { readonly kind: 'layer'; readonly element: SceneElement; readonly hidden: boolean }
  | { readonly kind: 'group'; readonly element: Extract<SceneElement, { type: 'group' }>; readonly hidden: boolean; readonly children: readonly LayerPlan[] }

export interface PsdPlan {
  readonly layers: readonly LayerPlan[]
  /** Groups laid out flat because other layers sit between theirs. */
  readonly flattened: readonly string[]
}

export function psdPlan(scene: Scene): PsdPlan {
  const leaves = scene.elements.filter((element) => element.type !== 'group' && isFinalContent(element)).sort((left, right) => left.zIndex - right.zIndex)
  const place = new Map(leaves.map((element, index) => [element.id, index]))
  const childIds = new Map<string | null, SceneElement[]>()
  for (const element of scene.elements) childIds.set(element.groupId, [...(childIds.get(element.groupId) ?? []), element])
  const leavesIn = (groupId: string, seen = new Set<string>()): number[] => {
    if (seen.has(groupId)) return []
    seen.add(groupId)
    return (childIds.get(groupId) ?? []).flatMap((child) => child.type === 'group' ? leavesIn(child.id, seen) : place.has(child.id) ? [place.get(child.id)!] : [])
  }
  const flattened: string[] = []
  // hiddenAbove: a group laid out flat above these was hidden, so they stay hidden without it.
  const childrenOf = (groupId: string | null, seen: ReadonlySet<string>, hiddenAbove: boolean): LayerPlan[] => (childIds.get(groupId) ?? []).flatMap((element): LayerPlan[] => {
    const hidden = hiddenAbove || !element.visible
    if (element.type !== 'group') return place.has(element.id) ? [{ kind: 'layer', element, hidden }] : []
    if (seen.has(element.id)) return []
    const inside = new Set([...seen, element.id])
    const indices = leavesIn(element.id)
    if (indices.length === 0) return []
    const together = Math.max(...indices) - Math.min(...indices) + 1 === indices.length
    // A Photoshop group hides what is in it, so its children need only their own eyes.
    if (together) return [{ kind: 'group', element, hidden, children: sorted(childrenOf(element.id, inside, false)) }]
    flattened.push(element.name)
    return childrenOf(element.id, inside, hidden)
  })
  const positionOf = (plan: LayerPlan): number => plan.kind === 'layer' ? place.get(plan.element.id)! : Math.max(...plan.children.map(positionOf))
  const sorted = (plans: LayerPlan[]): LayerPlan[] => plans.sort((left, right) => positionOf(left) - positionOf(right))
  return { layers: sorted(childrenOf(null, new Set(), false)), flattened }
}

export function countLayers(plans: readonly LayerPlan[]): number {
  return plans.reduce((total, plan) => total + (plan.kind === 'group' ? countLayers(plan.children) : 1), 0)
}

export interface Area {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where a layer can have pixels, in document pixels, also past the canvas
 * edge: its box turned about its top-left corner, with room for a stroke
 * and a shadow. A PSD keeps what lies outside the canvas, so a layer moved
 * back into view in Photoshop is whole. Too large an area is cut to the
 * canvas.
 */
export function layerArea(element: SceneElement, width: number, height: number): Area {
  const box = { x: element.transform.x * width, y: element.transform.y * height, w: element.transform.width * width, h: element.transform.height * height }
  const angle = element.transform.rotation * Math.PI / 180
  const corners = [[0, 0], [box.w, 0], [0, box.h], [box.w, box.h]].map(([dx, dy]) => ({
    x: box.x + dx! * Math.cos(angle) - dy! * Math.sin(angle),
    y: box.y + dx! * Math.sin(angle) + dy! * Math.cos(angle)
  }))
  let margin = 2
  if (element.type === 'text') margin += element.strokeWidth + element.shadowBlur * 2
  if (element.type === 'shape' && element.stroke !== null) margin += element.strokeWidth * Math.min(box.w, box.h)
  if (element.type === 'image' && hasVisibleEffects(element.effects) && element.effects?.shadow != null) {
    const shadow = shadowGeometry(element.effects.shadow, box.w, box.h)
    margin += shadow.padding + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY))
  }
  const left = Math.floor(Math.min(...corners.map((corner) => corner.x)) - margin)
  const top = Math.floor(Math.min(...corners.map((corner) => corner.y)) - margin)
  const right = Math.ceil(Math.max(...corners.map((corner) => corner.x)) + margin)
  const bottom = Math.ceil(Math.max(...corners.map((corner) => corner.y)) + margin)
  if (right - left <= MAX_EXPORT_EDGE && bottom - top <= MAX_EXPORT_EDGE) return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  const x = Math.max(0, left)
  const y = Math.max(0, top)
  return { x, y, width: Math.max(1, Math.min(width, right) - x), height: Math.max(1, Math.min(height, bottom) - y) }
}
