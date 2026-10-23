import type { Scene, SceneElement } from '../../domain'

/**
 * The scene with only the given elements, still valid: layer order is
 * renumbered, a group stays only with all its members, masks lose a missing
 * target, lights and relations drop missing ends. `visible` overrides each
 * kept element's visibility when given.
 */
export function subScene(scene: Scene, keep: ReadonlySet<string>, options: { readonly visible?: boolean } = {}): Scene {
  const groups = new Set(scene.elements
    .filter((element) => element.type === 'group' && keep.has(element.id) && element.childIds.every((id) => keep.has(id)))
    .map((element) => element.id))
  const kept = new Set(scene.elements
    .filter((element) => keep.has(element.id) && (element.type !== 'group' || groups.has(element.id)))
    .filter((element) => element.type !== 'mask' || keep.has(element.targetElementId))
    .map((element) => element.id))
  const elements = scene.elements.filter((element) => kept.has(element.id)).map((element, index) => ({
    ...element,
    zIndex: index,
    ...(options.visible === undefined ? {} : { visible: options.visible }),
    groupId: element.groupId !== null && groups.has(element.groupId) ? element.groupId : null,
    ...(element.type === 'light' ? { targetElementIds: element.targetElementIds.filter((id) => kept.has(id)) } : {})
  }) as SceneElement)
  return {
    ...scene,
    elements,
    relations: scene.relations.filter((relation) => kept.has(relation.sourceElementId) && kept.has(relation.targetElementId))
  }
}
