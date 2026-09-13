import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../domain'
import type { EphemeralAnnotation, EphemeralAnnotationRegion } from './agent'

type IdFactory = () => string

export function annotationRegions(annotation: EphemeralAnnotation): readonly EphemeralAnnotationRegion[] {
  return annotation.regions === undefined || annotation.regions.length === 0
    ? [{ id: annotation.id, mode: annotation.mode, points: annotation.points, closed: annotation.closed, width: annotation.width }]
    : annotation.regions
}

function orderedRegions(annotation: EphemeralAnnotation): readonly EphemeralAnnotationRegion[] {
  return [...annotationRegions(annotation)].sort((left, right) => Number(left.mode === 'protect') - Number(right.mode === 'protect'))
}

export function buildTransientAnnotationMasks(
  scene: Scene,
  targetElementId: string,
  annotation: EphemeralAnnotation,
  idFactory: IdFactory = () => globalThis.crypto.randomUUID()
): readonly SceneElement[] {
  const baseZIndex = Math.max(0, ...scene.elements.map((element) => element.zIndex + 1))
  return orderedRegions(annotation).map((region, index): SceneElement => ({
    id: index === 0 ? annotation.id : idFactory(),
    version: ELEMENT_SCHEMA_VERSION,
    type: 'mask',
    name: `本轮临时${region.mode === 'protect' ? '保护' : region.mode === 'generate' ? '生成' : '修改'}区`,
    description: '仅用于当前 Agent 回合；不进入项目快照、普通导出或参考合成。',
    zIndex: baseZIndex + index,
    opacity: 1,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'ephemeral-edit-mask',
    referencePolicy: 'exclude',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    mode: region.mode,
    targetElementId,
    paths: [{ id: idFactory(), points: region.points, closed: region.closed }],
    feather: Math.min(0.24, Math.max(0.02, region.width * 5))
  }))
}
