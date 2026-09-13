import { SCENE_SCHEMA_VERSION, sceneSchema, type Scene } from './schema'

export interface CreateSceneInput {
  readonly id: string
  readonly projectId: string
  readonly now: string
  readonly aspectWidth?: number
  readonly aspectHeight?: number
  readonly outputWidth?: number
  readonly outputHeight?: number
}

export function createScene(input: CreateSceneInput): Scene {
  return sceneSchema.parse({
    schemaVersion: SCENE_SCHEMA_VERSION,
    id: input.id,
    projectId: input.projectId,
    revision: 0,
    canvas: {
      aspectWidth: input.aspectWidth ?? 4,
      aspectHeight: input.aspectHeight ?? 5,
      outputWidth: input.outputWidth ?? 1024,
      outputHeight: input.outputHeight ?? 1280,
      backgroundColor: '#FBFAF7',
      transparent: false,
      globalStyle: ''
    },
    elements: [],
    relations: [],
    creativeContext: null,
    createdAt: input.now,
    updatedAt: input.now
  })
}
