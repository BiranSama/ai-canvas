import { ELEMENT_SCHEMA_VERSION, SCENE_SCHEMA_VERSION, sceneSchema, type Scene } from '../../../domain'

const colors = ['#D8E2EC', '#B8C9DC', '#8FA8C3', '#6E89A6', '#4F6D8B'] as const

export function createHundredElementScene(): Scene {
  const now = '2026-08-10T00:00:00.000Z'
  return sceneSchema.parse({
    schemaVersion: SCENE_SCHEMA_VERSION,
    id: '20000000-0000-4000-8000-000000000001',
    projectId: '20000000-0000-4000-8000-000000000002',
    revision: 0,
    canvas: {
      aspectWidth: 1,
      aspectHeight: 1,
      outputWidth: 1024,
      outputHeight: 1024,
      backgroundColor: '#F5F6F8',
      transparent: false,
      globalStyle: '100 元素交互性能基准'
    },
    elements: Array.from({ length: 100 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      version: ELEMENT_SCHEMA_VERSION,
      type: 'shape' as const,
      name: `基准元素 ${index + 1}`,
      description: 'M3 100 元素画布性能 Fixture',
      transform: {
        x: 0.055 + (index % 10) * 0.09,
        y: 0.055 + Math.floor(index / 10) * 0.09,
        width: 0.07,
        height: 0.07,
        rotation: index % 5 === 0 ? 5 : 0
      },
      zIndex: index,
      opacity: 0.94,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'benchmark',
      referencePolicy: 'include' as const,
      shape: index % 3 === 0 ? 'ellipse' as const : 'rectangle' as const,
      fill: colors[index % colors.length] ?? colors[0],
      stroke: '#60758D',
      strokeWidth: 0.002,
      role: 'final' as const
    })),
    relations: [],
    createdAt: now,
    updatedAt: now
  })
}
