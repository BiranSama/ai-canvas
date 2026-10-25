import type { SceneElement } from '../../../domain'
import type { EphemeralAnnotation } from '../../../shared/agent'
import { maskBounds, traceMaskOutline, type GrayMask } from '../../../shared/mask-raster'
import { useWorkspaceStore } from '../store/workspace-store'
import { currentSelection } from './selection-store'

/*
 * The selection told to the Agent: its outlines as the turn's temporary
 * marked region, which the Agent's local edits already use, and the image
 * layer it falls on. Outlines are simplified to what a region can hold.
 */

const MAX_REGIONS = 256
const MAX_POINTS = 4_096

/** Ramer–Douglas–Peucker: the outline with points closer than tolerance to the line between their neighbours left out. */
function simplify(points: Float32Array, tolerance: number): number[] {
  const count = points.length / 2
  if (count <= 3) return [...points]
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1
  const stack: Array<[number, number]> = [[0, count - 1]]
  while (stack.length > 0) {
    const [from, to] = stack.pop()!
    const ax = points[from * 2]!
    const ay = points[from * 2 + 1]!
    const bx = points[to * 2]!
    const by = points[to * 2 + 1]!
    const length = Math.hypot(bx - ax, by - ay) || 1
    let farthest = -1
    let distance = tolerance
    for (let index = from + 1; index < to; index += 1) {
      const d = Math.abs((bx - ax) * (ay - points[index * 2 + 1]!) - (ax - points[index * 2]!) * (by - ay)) / length
      if (d > distance) { distance = d; farthest = index }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    stack.push([from, farthest], [farthest, to])
  }
  const out: number[] = []
  for (let index = 0; index < count; index += 1) if (keep[index] === 1) out.push(points[index * 2]!, points[index * 2 + 1]!)
  return out
}

function area(points: readonly number[]): number {
  let sum = 0
  for (let index = 0, count = points.length / 2; index < count; index += 1) {
    const next = (index + 1) % count
    sum += points[index * 2]! * points[next * 2 + 1]! - points[next * 2]! * points[index * 2 + 1]!
  }
  return Math.abs(sum) / 2
}

/** The image layer the selection falls on: the selected one, or the topmost visible image it overlaps. */
function selectionTarget(selection: GrayMask): SceneElement | null {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const selected = selectedIds.length === 1 ? scene.elements.find((element) => element.id === selectedIds[0]) : undefined
  if (selected?.type === 'image') return selected
  const bounds = maskBounds(selection)
  if (bounds === null) return null
  const box = { x: bounds.x / selection.width, y: bounds.y / selection.height, right: (bounds.x + bounds.width) / selection.width, bottom: (bounds.y + bounds.height) / selection.height }
  return [...scene.elements].reverse().find((element) => element.type === 'image' && element.visible
    && element.transform.x < box.right && element.transform.x + element.transform.width > box.x
    && element.transform.y < box.bottom && element.transform.y + element.transform.height > box.y) ?? null
}

/** The selection as the turn's marked region, or null with nothing selected. */
export function selectionAnnotation(): EphemeralAnnotation | null {
  const selection = currentSelection()
  if (selection === null) return null
  const outlines = traceMaskOutline(selection)
    .map((outline) => {
      let tolerance = 1
      let points = simplify(outline, tolerance)
      while (points.length / 2 > MAX_POINTS) { tolerance *= 2; points = simplify(outline, tolerance) }
      return points
    })
    .filter((points) => points.length >= 6)
    .sort((left, right) => area(right) - area(left))
    .slice(0, MAX_REGIONS)
  if (outlines.length === 0) return null
  const regions = outlines.map((points) => ({
    id: globalThis.crypto.randomUUID(),
    mode: 'edit' as const,
    points: Array.from({ length: points.length / 2 }, (_, index) => ({
      x: Math.min(1, Math.max(0, points[index * 2]! / selection.width)),
      y: Math.min(1, Math.max(0, points[index * 2 + 1]! / selection.height))
    })),
    closed: true,
    width: 0.015
  }))
  return { ...regions[0]!, targetElementId: selectionTarget(selection)?.id ?? null, regions }
}
