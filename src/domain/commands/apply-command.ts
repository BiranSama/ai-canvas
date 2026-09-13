import type { Draft } from 'immer'
import { imageElementSchema, sceneElementSchema, type Scene, type SceneElement } from '../scene/schema'
import { CommandDomainError } from './errors'
import type { SceneCommand } from './schema'

const PROTECTED_ELEMENT_FIELDS = new Set(['id', 'type', 'version', 'zIndex', 'groupId'])

function findElementIndex(scene: Draft<Scene>, elementId: string): number {
  const index = scene.elements.findIndex((element) => element.id === elementId)
  if (index === -1) {
    throw new CommandDomainError('ELEMENT_NOT_FOUND', `Element ${elementId} does not exist.`)
  }
  return index
}

function normalizeLayerOrder(scene: Draft<Scene>): void {
  scene.elements.forEach((element, index) => {
    element.zIndex = index
  })
}

function removeElementAndReferences(scene: Draft<Scene>, elementId: string): void {
  const index = findElementIndex(scene, elementId)
  const element = scene.elements[index]
  if (element === undefined) return

  const idsToRemove = new Set<string>([elementId])
  if (element.type === 'group') {
    element.childIds.forEach((childId) => idsToRemove.add(childId))
  }

  let expanded = true
  while (expanded) {
    expanded = false
    for (const candidate of scene.elements) {
      const shouldRemoveAttachedMask = candidate.type === 'mask' && idsToRemove.has(candidate.targetElementId)
      const shouldRemoveEmptyGroup =
        candidate.type === 'group' && candidate.childIds.every((childId) => idsToRemove.has(childId))
      if ((shouldRemoveAttachedMask || shouldRemoveEmptyGroup) && !idsToRemove.has(candidate.id)) {
        idsToRemove.add(candidate.id)
        expanded = true
      }
    }
  }

  scene.elements = scene.elements.filter((candidate) => !idsToRemove.has(candidate.id))
  for (const candidate of scene.elements) {
    if (candidate.type === 'group') {
      candidate.childIds = candidate.childIds.filter((childId) => !idsToRemove.has(childId))
    }
    if (candidate.groupId !== null && idsToRemove.has(candidate.groupId)) candidate.groupId = null
    if (candidate.type === 'light') {
      candidate.targetElementIds = candidate.targetElementIds.filter((targetId) => !idsToRemove.has(targetId))
    }
  }
  scene.elements = scene.elements.filter(
    (candidate) => candidate.type !== 'group' || candidate.childIds.length > 0
  )
  scene.relations = scene.relations.filter(
    (relation) =>
      !idsToRemove.has(relation.sourceElementId) && !idsToRemove.has(relation.targetElementId)
  )
  normalizeLayerOrder(scene)
}

function updateElement(scene: Draft<Scene>, elementId: string, changes: Record<string, unknown>): void {
  const index = findElementIndex(scene, elementId)
  const current = scene.elements[index]
  if (current === undefined) return

  const attemptedProtectedFields = Object.keys(changes).filter((field) => PROTECTED_ELEMENT_FIELDS.has(field))
  if (attemptedProtectedFields.length > 0) {
    throw new CommandDomainError(
      'INVALID_COMMAND',
      `Protected fields cannot be updated: ${attemptedProtectedFields.join(', ')}.`
    )
  }

  if (current.locked && !(Object.keys(changes).length === 1 && changes.locked === false)) {
    throw new CommandDomainError('ELEMENT_LOCKED', `Element ${elementId} is locked.`)
  }

  const transformChange = changes.transform
  const mergedTransform =
    typeof transformChange === 'object' && transformChange !== null
      ? { ...current.transform, ...transformChange }
      : current.transform

  const nextElement: unknown = {
    ...current,
    ...changes,
    id: current.id,
    type: current.type,
    version: current.version,
    zIndex: current.zIndex,
    groupId: current.groupId,
    blendMode: changes.blendMode ?? current.blendMode ?? 'normal',
    transform: mergedTransform
  }
  const parsed = sceneElementSchema.safeParse(nextElement)
  if (!parsed.success) {
    throw new CommandDomainError(
      'INVALID_COMMAND',
      `Element ${elementId} update is invalid.`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    )
  }

  scene.elements[index] = parsed.data as SceneElement
}

function groupElements(
  scene: Draft<Scene>,
  groupPayload: SceneElement,
  requestedElementIds: readonly string[]
): void {
  if (groupPayload.type !== 'group') {
    throw new CommandDomainError('GROUP_INVALID', 'Group payload is not a group element.')
  }
  if (scene.elements.some((element) => element.id === groupPayload.id)) {
    throw new CommandDomainError('ELEMENT_EXISTS', `Element ${groupPayload.id} already exists.`)
  }

  const elementIds = [...new Set(requestedElementIds)]
  if (elementIds.length !== requestedElementIds.length) {
    throw new CommandDomainError('GROUP_INVALID', 'Group element IDs must be unique.')
  }
  const children = elementIds.map((elementId) => {
    const element = scene.elements[findElementIndex(scene, elementId)]
    if (element === undefined) throw new CommandDomainError('ELEMENT_NOT_FOUND', elementId)
    if (element.type === 'group' || element.groupId !== null) {
      throw new CommandDomainError('GROUP_INVALID', 'Nested or already grouped elements are not supported by the current scene model.')
    }
    return element
  })

  const left = Math.min(...children.map((element) => element.transform.x))
  const top = Math.min(...children.map((element) => element.transform.y))
  const right = Math.max(...children.map((element) => element.transform.x + element.transform.width))
  const bottom = Math.max(...children.map((element) => element.transform.y + element.transform.height))
  const groupIndex = Math.min(...children.map((element) => element.zIndex))

  for (const child of children) child.groupId = groupPayload.id
  const group = sceneElementSchema.parse({
    ...groupPayload,
    blendMode: groupPayload.blendMode ?? 'normal',
    childIds: elementIds,
    zIndex: groupIndex,
    groupId: null,
    transform: { x: left, y: top, width: right - left, height: bottom - top, rotation: 0 }
  })
  scene.elements.splice(groupIndex, 0, group)
  normalizeLayerOrder(scene)
}

function ungroupElements(scene: Draft<Scene>, groupId: string): void {
  const index = findElementIndex(scene, groupId)
  const group = scene.elements[index]
  if (group?.type !== 'group') {
    throw new CommandDomainError('GROUP_INVALID', `Element ${groupId} is not a group.`)
  }
  const childIds = new Set(group.childIds)
  scene.elements.splice(index, 1)
  for (const element of scene.elements) {
    if (childIds.has(element.id)) element.groupId = null
  }
  normalizeLayerOrder(scene)
}

export function applySceneCommand(scene: Draft<Scene>, command: SceneCommand): void {
  switch (command.kind) {
    case 'scene.set-canvas':
      scene.canvas = command.canvas
      return
    case 'scene.set-creative-context':
      scene.creativeContext = command.creativeContext
      return
    case 'element.add':
      if (scene.elements.some((element) => element.id === command.element.id)) {
        throw new CommandDomainError('ELEMENT_EXISTS', `Element ${command.element.id} already exists.`)
      }
      scene.elements.push({ ...command.element, blendMode: command.element.blendMode ?? 'normal', zIndex: scene.elements.length })
      return
    case 'element.update':
      updateElement(scene, command.elementId, command.changes)
      return
    case 'element.set-image': {
      const index = findElementIndex(scene, command.elementId)
      const current = scene.elements[index]!
      if (current.type !== 'placeholder' && current.type !== 'image') {
        throw new CommandDomainError('INVALID_COMMAND', 'Only an image or placeholder can receive a generated image.')
      }
      // Keep identity, grouping, relations, stacking and geometry in one undoable operation.
      scene.elements[index] = imageElementSchema.parse({
        ...current, type: 'image', assetId: command.assetId, provenance: command.provenance,
        crop: current.type === 'image' ? current.crop : { x: 0, y: 0, width: 1, height: 1 },
        fit: current.type === 'image' ? current.fit : 'contain',
        referenceRole: current.type === 'image' ? current.referenceRole : 'subject'
      })
      return
    }
    case 'element.remove':
      removeElementAndReferences(scene, command.elementId)
      return
    case 'element.reorder': {
      const fromIndex = findElementIndex(scene, command.elementId)
      const toIndex = Math.min(command.toIndex, scene.elements.length - 1)
      const [element] = scene.elements.splice(fromIndex, 1)
      if (element !== undefined) scene.elements.splice(toIndex, 0, element)
      normalizeLayerOrder(scene)
      return
    }
    case 'element.group':
      groupElements(scene, command.group, command.elementIds)
      return
    case 'element.ungroup':
      ungroupElements(scene, command.groupId)
      return
    case 'relation.add':
      if (scene.relations.some((relation) => relation.id === command.relation.id)) {
        throw new CommandDomainError('RELATION_EXISTS', `Relation ${command.relation.id} already exists.`)
      }
      if (
        command.relation.sourceElementId === command.relation.targetElementId ||
        !scene.elements.some((element) => element.id === command.relation.sourceElementId) ||
        !scene.elements.some((element) => element.id === command.relation.targetElementId)
      ) {
        throw new CommandDomainError('INVALID_COMMAND', 'Relation endpoints are invalid.')
      }
      scene.relations.push(command.relation)
      return
    case 'relation.remove': {
      const relationIndex = scene.relations.findIndex((relation) => relation.id === command.relationId)
      if (relationIndex === -1) {
        throw new CommandDomainError('RELATION_NOT_FOUND', `Relation ${command.relationId} does not exist.`)
      }
      scene.relations.splice(relationIndex, 1)
      return
    }
  }
}
