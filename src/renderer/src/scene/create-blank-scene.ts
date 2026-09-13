import { createScene, type Scene } from '../../../domain'

export interface BlankSceneOptions {
  readonly sceneId?: string
  readonly projectId?: string
  readonly now?: string
}

/**
 * Runtime projects start from a neutral Scene. Product examples live in
 * `fixtures/` and must only be loaded through an explicit example/test path.
 */
export function createBlankScene(options: BlankSceneOptions = {}): Scene {
  return createScene({
    id: options.sceneId ?? globalThis.crypto.randomUUID(),
    projectId: options.projectId ?? globalThis.crypto.randomUUID(),
    now: options.now ?? new Date().toISOString()
  })
}
