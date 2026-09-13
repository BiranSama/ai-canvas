import type { Scene } from './schema'
import type { SceneCommand } from '../commands/schema'

export function createSceneInitializationCommands(scene: Scene): readonly SceneCommand[] {
  return [
    { kind: 'scene.set-canvas', canvas: scene.canvas },
    { kind: 'scene.set-creative-context', creativeContext: scene.creativeContext },
    ...scene.elements.map((element): SceneCommand => ({ kind: 'element.add', element })),
    ...scene.relations.map((relation): SceneCommand => ({ kind: 'relation.add', relation }))
  ]
}
