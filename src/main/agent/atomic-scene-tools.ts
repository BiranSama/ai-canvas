import type { Scene, SceneCommand } from '../../domain'
import type { AgentToolPlan } from '../../shared/agent'
import { elementSupportsBlendMode } from '../../shared/blend-mode'

export type AtomicSceneWriteTool = Extract<AgentToolPlan, {
  kind:
    | 'scene.set_canvas'
    | 'scene.create_elements'
    | 'scene.update_elements'
    | 'scene.reorder_elements'
    | 'scene.group_elements'
    | 'scene.remove_elements'
}>

export function isAtomicSceneWriteTool(tool: AgentToolPlan): tool is AtomicSceneWriteTool {
  return tool.kind === 'scene.set_canvas'
    || tool.kind === 'scene.create_elements'
    || tool.kind === 'scene.update_elements'
    || tool.kind === 'scene.reorder_elements'
    || tool.kind === 'scene.group_elements'
    || tool.kind === 'scene.remove_elements'
}

export function compileAtomicSceneCommands(tool: AtomicSceneWriteTool): SceneCommand[] {
  if (tool.kind === 'scene.set_canvas') return [{ kind: 'scene.set-canvas', canvas: tool.canvas }]
  if (tool.kind === 'scene.create_elements') {
    return tool.elements.map((element) => ({ kind: 'element.add' as const, element }))
  }
  if (tool.kind === 'scene.update_elements') {
    return tool.updates.map((update) => ({
      kind: 'element.update' as const,
      elementId: update.elementId,
      changes: update.changes
    }))
  }
  if (tool.kind === 'scene.reorder_elements') {
    return tool.moves.map((move) => ({ kind: 'element.reorder' as const, elementId: move.elementId, toIndex: move.toIndex }))
  }
  if (tool.kind === 'scene.group_elements') {
    return [{ kind: 'element.group', group: tool.group, elementIds: tool.elementIds }]
  }
  return tool.elementIds.map((elementId) => ({ kind: 'element.remove' as const, elementId }))
}

export function blendModeCommandViolation(scene: Scene, commands: readonly SceneCommand[]): string | null {
  for (const command of commands) {
    if (command.kind === 'element.add') {
      const blendMode = command.element.blendMode ?? 'normal'
      if (blendMode !== 'normal' && !elementSupportsBlendMode(command.element.type)) {
        return `Blend mode ${blendMode} is not available for ${command.element.type} elements.`
      }
      continue
    }
    if (command.kind !== 'element.update' || typeof command.changes.blendMode !== 'string' || command.changes.blendMode === 'normal') continue
    const target = scene.elements.find((element) => element.id === command.elementId)
    if (target !== undefined && !elementSupportsBlendMode(target.type)) {
      return `Blend mode ${command.changes.blendMode} is not available for ${target.type} elements.`
    }
  }
  return null
}
