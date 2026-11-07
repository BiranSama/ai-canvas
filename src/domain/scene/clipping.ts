import type { SceneElement } from './schema'

/*
 * Photoshop's clipping masks: a clipped layer shows only where the nearest
 * unclipped layer below it in the same group has content, its base. The
 * base and the layers clipped to it are drawn as one, with the base's
 * opacity and blend mode. Every renderer reads the stacks from here.
 */

/** What a clipped layer can be. */
export function canBeClipped(element: SceneElement): boolean {
  return element.type === 'image' || element.type === 'text' || element.type === 'shape' || element.type === 'adjustment'
}

/** What a clipping base can be: a layer with pixels of its own that is part of the picture. */
export function canBeClipBase(element: SceneElement): boolean {
  return element.type === 'image' || element.type === 'text' || (element.type === 'shape' && element.role === 'final')
}

export interface ClipStack {
  readonly baseId: string
  /** The layers clipped to it, bottom first. */
  readonly memberIds: readonly string[]
}

/**
 * The clipping stacks of a scene, in drawing order. A clipped layer with no
 * base right below it (a group, an adjustment layer, a layer of another
 * group or nothing) belongs to no stack and is drawn as a plain layer.
 */
export function clipStacks(elements: readonly SceneElement[]): ReadonlyMap<string, ClipStack> {
  const ordered = [...elements].sort((left, right) => left.zIndex - right.zIndex)
  const stacks = new Map<string, { baseId: string; memberIds: string[] }>()
  let open: { stack: { baseId: string; memberIds: string[] }; groupId: string | null } | null = null
  for (const element of ordered) {
    if (element.type === 'group') { open = null; continue }
    if (element.clipped === true && canBeClipped(element) && open !== null && open.groupId === element.groupId) {
      open.stack.memberIds.push(element.id)
      continue
    }
    open = canBeClipBase(element) && element.clipped !== true ? { stack: { baseId: element.id, memberIds: [] }, groupId: element.groupId } : null
    if (open !== null) stacks.set(element.id, open.stack)
  }
  for (const [id, stack] of stacks) if (stack.memberIds.length === 0) stacks.delete(id)
  return stacks
}

/** For each clipped layer that has a base, that base's id. */
export function clipBases(elements: readonly SceneElement[]): ReadonlyMap<string, string> {
  const bases = new Map<string, string>()
  for (const stack of clipStacks(elements).values()) for (const id of stack.memberIds) bases.set(id, stack.baseId)
  return bases
}
