import type { SceneCommand, SceneElement } from '../../../domain'
import type { AgentToolPlan } from '../../../shared/agent'
import { changeLines } from './geometry'
import { bannedWordsIn } from '../../../shared/user-memory'
import type { AgentToolContext, AgentToolStep } from './types'

/** A line for each text this write left with one of the person's banned words; the person's own text is not checked. */
function bannedWordLines(sceneBefore: { readonly elements: readonly SceneElement[] }, sceneAfter: { readonly elements: readonly SceneElement[] }, ids: readonly string[], context: AgentToolContext): string[] {
  const banned = context.bannedWords ?? []
  if (banned.length === 0) return []
  return ids.flatMap((id) => {
    const after = sceneAfter.elements.find((element) => element.id === id)
    if (after?.type !== 'text') return []
    const before = sceneBefore.elements.find((element) => element.id === id)
    if (before?.type === 'text' && before.content === after.content) return []
    const found = bannedWordsIn(after.content, banned)
    return found.length === 0 ? [] : [`注意：${context.refs.ref(id)} 的文字里有用户品牌的禁用词「${found.join('」「')}」，改掉它们。`]
  })
}

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
      return { ok: true, summary, details: [...changeLines(sceneBefore, sceneAfter, context.refs, ids), ...bannedWordLines(sceneBefore, sceneAfter, ids, context)] }
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
