import { randomUUID } from 'node:crypto'
import type { Scene, SceneCommand } from '../../src/domain'
import type { GenerationRuntime } from '../../src/main/generation/generation-runtime'

/** Fixture authoring uses the production Scene executor. Generation entrypoints
 * must never accept a synthetic Renderer Scene as an authority substitute. */
export async function commitSceneFixture(runtime: GenerationRuntime, fixture: Scene): Promise<Scene> {
  const current = runtime.getWorkspaceBootstrap().scene
  const commands: SceneCommand[] = [
    ...current.elements.filter((element) => element.type !== 'group').map((element) => ({ kind: 'element.remove' as const, elementId: element.id })),
    ...current.elements.filter((element) => element.type === 'group').map((element) => ({ kind: 'element.remove' as const, elementId: element.id })),
    { kind: 'scene.set-canvas', canvas: fixture.canvas },
    { kind: 'scene.set-creative-context', creativeContext: fixture.creativeContext },
    ...fixture.elements.map((element) => ({ kind: 'element.add' as const, element })),
    ...fixture.relations.map((relation) => ({ kind: 'relation.add' as const, relation }))
  ]
  await runtime.executeSceneCommands({ projectId: current.projectId, expectedSceneRevision: current.revision,
    batch: { id: randomUUID(), origin: 'user', summary: 'Commit synthetic reference scene', commands } })
  return runtime.getWorkspaceBootstrap().scene
}
