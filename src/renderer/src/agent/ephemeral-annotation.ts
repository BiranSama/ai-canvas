import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneCommand, type SceneElement } from '../../../domain'
import type { EphemeralAnnotation, EphemeralAnnotationRegion } from '../../../shared/agent'
export { annotationRegions, buildTransientAnnotationMasks } from '../../../shared/ephemeral-annotation'
import { annotationRegions } from '../../../shared/ephemeral-annotation'

type AnnotationSaveKind = 'mask' | 'sketch'
type IdFactory = () => string

const MODE_COLOR: Readonly<Record<EphemeralAnnotationRegion['mode'], string>> = {
  edit: '#FF7C72',
  generate: '#64C79A',
  protect: '#75A8E8'
}

function orderedRegions(annotation: EphemeralAnnotation): readonly EphemeralAnnotationRegion[] {
  return [...annotationRegions(annotation)].sort((left, right) => Number(left.mode === 'protect') - Number(right.mode === 'protect'))
}

export function buildEphemeralAnnotationSaveCommands(
  scene: Scene,
  annotation: EphemeralAnnotation,
  kind: AnnotationSaveKind,
  idFactory: IdFactory = () => crypto.randomUUID()
): { readonly commands: readonly SceneCommand[]; readonly elementIds: readonly string[] } {
  const regions = orderedRegions(annotation)
  if (kind === 'mask') {
    const target = scene.elements.find((element) => element.id === annotation.targetElementId)
    if (target?.type !== 'image') return { commands: [], elementIds: [] }
    const elements = regions.map((region, index): SceneElement => ({
      id: idFactory(),
      version: ELEMENT_SCHEMA_VERSION,
      type: 'mask',
      name: region.mode === 'protect' ? '保护区域' : region.mode === 'generate' ? '生成区域' : '修改区域',
      description: '由对话中的本轮临时标注显式保存。',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      zIndex: scene.elements.length + index,
      opacity: 1,
      blendMode: 'normal',
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'edit-mask',
      referencePolicy: 'exclude',
      mode: region.mode,
      targetElementId: target.id,
      paths: [{ id: idFactory(), points: region.points, closed: region.closed }],
      feather: Math.min(0.24, Math.max(0.02, region.width * 5))
    }))
    return { commands: elements.map((element) => ({ kind: 'element.add', element })), elementIds: elements.map((element) => element.id) }
  }

  const sketchId = idFactory()
  const sketch: SceneElement = {
    id: sketchId,
    version: ELEMENT_SCHEMA_VERSION,
    type: 'sketch',
    name: '对话标注草图',
    description: '由本轮临时标注明确保存的构图草图；参与参考合成，但不进入最终导出。',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    zIndex: scene.elements.length,
    opacity: 1,
    blendMode: 'normal',
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'composition-sketch',
    referencePolicy: 'include',
    strokes: regions.map((region) => ({
      id: idFactory(),
      points: region.closed ? [...region.points, region.points[0] as { readonly x: number; readonly y: number }] : region.points,
      color: MODE_COLOR[region.mode],
      width: region.width,
      opacity: 0.9
    })),
    fidelity: 0.76,
    finalVisible: false
  }
  return { commands: [{ kind: 'element.add', element: sketch }], elementIds: [sketchId] }
}
