import type { SceneCommand, SceneElement } from '../../../domain'
import type { AgentToolPlan } from '../../../shared/agent'
import { changeLines } from './geometry'
import type { AgentToolContext, AgentToolStep } from './types'

/**
 * A scene write that goes through the existing executor, then reports what
 * changed as before → after lines with the short references of new objects.
 */
export function sceneWrite(
  plan: AgentToolPlan,
  context: AgentToolContext,
  summary: string,
  touchedIds: readonly string[] = []
): AgentToolStep {
  return {
    kind: 'execute',
    plan,
    report: ({ outcome, sceneBefore, sceneAfter }) => {
      if (!outcome.ok) {
        return { ok: false, summary: outcome.message, hint: '画布没有改动。按提示调整参数后再试，或先 inspect 相关对象。' }
      }
      context.refs.sync(sceneAfter)
      const ids = [...new Set([...touchedIds, ...outcome.affectedElementIds])]
      return { ok: true, summary, details: changeLines(sceneBefore, sceneAfter, context.refs, ids) }
    }
  }
}

export function batchPlan(summary: string, commands: readonly SceneCommand[]): AgentToolPlan {
  return { kind: 'scene_batch', summary, commands: [...commands] }
}

export function createPlan(context: AgentToolContext, summary: string, elements: readonly SceneElement[]): AgentToolPlan {
  return { kind: 'scene.create_elements', expectedSceneRevision: context.scene.revision, summary, elements: [...elements] }
}

export function elementBase(
  context: AgentToolContext,
  input: { readonly name: string; readonly transform: SceneElement['transform']; readonly role?: string; readonly description?: string }
) {
  return {
    id: context.newId(),
    version: 1 as const,
    name: input.name.slice(0, 120),
    description: input.description ?? '',
    transform: input.transform,
    zIndex: context.scene.elements.length,
    opacity: 1,
    blendMode: 'normal' as const,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: input.role ?? 'content',
    referencePolicy: 'include' as const
  }
}
