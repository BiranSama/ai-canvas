import { z } from 'zod'
import { sceneSchema, type Scene } from './schema'

export const sceneSnapshotSchema = z.object({
  format: z.literal('ai-canvas-scene'),
  formatVersion: z.literal(1),
  scene: sceneSchema
})

export interface SceneSnapshot {
  readonly format: 'ai-canvas-scene'
  readonly formatVersion: 1
  readonly scene: Scene
}

export function serializeSceneSnapshot(scene: Scene): string {
  const snapshot: SceneSnapshot = {
    format: 'ai-canvas-scene',
    formatVersion: 1,
    scene: sceneSchema.parse(scene)
  }
  return JSON.stringify(snapshot)
}

export function deserializeSceneSnapshot(serialized: string): Scene {
  const parsedJson: unknown = JSON.parse(serialized)
  return sceneSnapshotSchema.parse(parsedJson).scene
}

