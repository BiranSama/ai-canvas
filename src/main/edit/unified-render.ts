import { z } from 'zod'
import type { Scene, SceneCommand, SceneElement } from '../../domain'
import { elementPresentation } from '../reference/composite-reference-renderer'

/** The layers a unified render redraws: everything exported except text, which stays exact on top. */
export function unifiedRenderCover(scene: Scene): readonly string[] {
  return scene.elements
    .filter((element) => element.type !== 'text' && elementPresentation(element, 'final') !== 'omit')
    .map((element) => element.id)
}

const unifiedJobSchema = z.object({
  mode: z.literal('unified-render'),
  coveredElementIds: z.array(z.string().min(1)).min(1)
})

/** The layers a unified-render job covered when it was submitted; null for every other job. */
export function unifiedRenderJob(parameters: Readonly<Record<string, unknown>>): { readonly coveredElementIds: readonly string[] } | null {
  const parsed = unifiedJobSchema.safeParse(parameters)
  return parsed.success ? { coveredElementIds: parsed.data.coveredElementIds } : null
}

/**
 * Lays the rendered picture directly above the highest layer it covers and
 * moves every text layer above it, keeping their order. The covered layers
 * stay as they were beneath it, so hiding the render shows them again.
 */
export function unifiedPlacementCommands(scene: Scene, rendered: SceneElement, coveredElementIds: readonly string[]): SceneCommand[] {
  const covered = new Set(coveredElementIds)
  const top = Math.max(-1, ...scene.elements.filter((element) => covered.has(element.id)).map((element) => element.zIndex))
  const texts = scene.elements.filter((element) => element.type === 'text' && element.groupId === null)
  return [
    { kind: 'element.add', element: { ...rendered, zIndex: scene.elements.length } },
    { kind: 'element.reorder', elementId: rendered.id, toIndex: top + 1 },
    ...texts.map((text) => ({ kind: 'element.reorder' as const, elementId: text.id, toIndex: scene.elements.length }))
  ]
}
