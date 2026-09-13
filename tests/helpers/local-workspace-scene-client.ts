import type { Scene } from '../../src/domain'
import { SceneService } from '../../src/main/scene'
import type { WorkspaceSceneClient } from '../../src/renderer/src/store/workspace-store'

export function createLocalWorkspaceSceneClient(scene: Scene): WorkspaceSceneClient {
  const service = new SceneService(scene, { save: async () => undefined })
  return {
    execute: (input) => service.execute(input),
    undo: (input) => service.undo(input),
    redo: (input) => service.redo(input),
    markBatchUndone: async () => undefined
  }
}
