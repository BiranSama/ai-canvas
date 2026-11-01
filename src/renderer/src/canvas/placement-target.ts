import type { Scene } from '../../../domain'

/**
 * Where a result put in from 出图 would like to go: the one placeholder or
 * image selected, else the canvas's only subject placeholder. Undefined means
 * the middle of the canvas, as before; Main still checks the target can take it.
 */
export function preferredPlacementTarget(scene: Scene, selectedIds: readonly string[]): string | undefined {
  const selected = scene.elements.filter((element) => selectedIds.includes(element.id))
  if (selected.length === 1 && (selected[0]!.type === 'placeholder' || selected[0]!.type === 'image')) return selected[0]!.id
  const subjects = scene.elements.filter((element) => element.type === 'placeholder' && element.semanticRole === 'subject' && element.visible)
  return subjects.length === 1 ? subjects[0]!.id : undefined
}
