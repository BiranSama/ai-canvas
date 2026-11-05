import type { SceneElement } from './schema'

/**
 * The layers a hidden group hides: as in Photoshop, turning off a group's
 * eye hides everything in it, nested groups included, while each layer
 * keeps its own eye for when the group is shown again.
 */
export function hiddenByGroups(elements: readonly SceneElement[]): ReadonlySet<string> {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const hidden = new Set<string>()
  for (const element of elements) {
    const seen = new Set<string>()
    let parentId = element.groupId
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (parent === undefined) break
      if (!parent.visible) {
        hidden.add(element.id)
        break
      }
      parentId = parent.groupId
    }
  }
  return hidden
}
