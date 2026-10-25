import type { SceneElement } from '../../../domain'
import type { EphemeralAnnotation } from '../../../shared/agent'
import { maskBounds, simplifyOutline, traceMaskOutline, type GrayMask } from '../../../shared/mask-raster'
import { useWorkspaceStore } from '../store/workspace-store'
import { currentSelection } from './selection-store'

/*
 * The selection told to the Agent: its outlines as the turn's temporary
 * marked region, which the Agent's local edits already use, and the image
 * layer it falls on. Outlines are simplified to what a region can hold.
 * An outline inside an odd number of others bounds a hole, such as the
 * middle of an inverted rectangle, and goes as a region to keep as it is.
 */

const MAX_REGIONS = 256
const MAX_POINTS = 4_096

function area(points: ArrayLike<number>): number {
  let sum = 0
  for (let index = 0, count = points.length / 2; index < count; index += 1) {
    const next = (index + 1) % count
    sum += points[index * 2]! * points[next * 2 + 1]! - points[next * 2]! * points[index * 2 + 1]!
  }
  return Math.abs(sum) / 2
}

function contains(points: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false
  for (let index = 0, count = points.length / 2, previous = count - 1; index < count; previous = index, index += 1) {
    const ax = points[index * 2]!, ay = points[index * 2 + 1]!, bx = points[previous * 2]!, by = points[previous * 2 + 1]!
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/** Whether each outline, largest first, bounds a hole: whether an odd number of the larger ones enclose it. */
function holes(outlines: readonly Float32Array[]): boolean[] {
  const boxes = outlines.map((points) => {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    for (let index = 0; index < points.length; index += 2) {
      box.left = Math.min(box.left, points[index]!); box.right = Math.max(box.right, points[index]!)
      box.top = Math.min(box.top, points[index + 1]!); box.bottom = Math.max(box.bottom, points[index + 1]!)
    }
    return box
  })
  return outlines.map((outline, index) => {
    const x = outline[0]!, y = outline[1]!
    let depth = 0
    for (let other = 0; other < index; other += 1) {
      const box = boxes[other]!
      if (x > box.left && x < box.right && y > box.top && y < box.bottom && contains(outlines[other]!, x, y)) depth += 1
    }
    return depth % 2 === 1
  })
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
      let points = simplifyOutline(outline, tolerance)
      while (points.length / 2 > MAX_POINTS) { tolerance *= 2; points = simplifyOutline(outline, tolerance) }
      return points
    })
    .filter((points) => points.length >= 6)
    .sort((left, right) => area(right) - area(left))
    .slice(0, MAX_REGIONS)
  if (outlines.length === 0) return null
  const hole = holes(outlines)
  const regions = outlines.map((points, index) => ({
    id: globalThis.crypto.randomUUID(),
    mode: hole[index] ? 'protect' as const : 'edit' as const,
    points: Array.from({ length: points.length / 2 }, (_, index) => ({
      x: Math.min(1, Math.max(0, points[index * 2]! / selection.width)),
      y: Math.min(1, Math.max(0, points[index * 2 + 1]! / selection.height))
    })),
    closed: true,
    width: 0.015
  }))
  return { ...regions[0]!, targetElementId: selectionTarget(selection)?.id ?? null, regions }
}
