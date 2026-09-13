import { sceneSchema, type Scene, type SceneElement } from '../../domain'
import { promptIrSchema, type PromptIr, type PromptIrElement, type PromptIrOcclusion } from '../../shared/reference'
import { resolveBlendMode } from '../../shared/blend-mode'

function attributesFor(element: SceneElement): Record<string, unknown> {
  if (element.type === 'image') return { assetId: element.assetId, crop: element.crop, fit: element.fit, referenceRole: element.referenceRole }
  if (element.type === 'text') return {
    content: element.content,
    orientation: element.orientation,
    align: element.align,
    wrapping: element.wrapping,
    fontFamily: element.fontFamily,
    fontSize: element.fontSize,
    fontWeight: element.fontWeight,
    fill: element.fill,
    stroke: element.stroke,
    strokeWidth: element.strokeWidth,
    shadowColor: element.shadowColor,
    shadowBlur: element.shadowBlur,
    letterSpacing: element.letterSpacing,
    lineHeight: element.lineHeight,
    accuracy: element.accuracy,
    visualWeight: element.visualWeight ?? 'secondary',
    styleDescription: element.styleDescription,
    renderStrategy: element.renderStrategy,
    resultAssetId: element.resultAssetId
  }
  if (element.type === 'sketch') return { fidelity: element.fidelity, finalVisible: element.finalVisible, strokeCount: element.strokes.length }
  if (element.type === 'shape') return { shape: element.shape, fill: element.fill, stroke: element.stroke, strokeWidth: element.strokeWidth, cornerRadius: element.cornerRadius, role: element.role }
  if (element.type === 'placeholder') return {
    subject: element.subject,
    pose: element.pose,
    facing: element.facing,
    allowOverflow: element.allowOverflow,
    transparentBackground: element.transparentBackground,
    frameShape: element.frameShape,
    visualKind: element.visualKind ?? 'generic',
    generationNotes: element.generationNotes
  }
  if (element.type === 'light') return {
    direction: element.direction,
    color: element.color,
    intensity: element.intensity,
    softness: element.softness,
    range: element.range,
    targetElementIds: element.targetElementIds
  }
  if (element.type === 'mask') return { mode: element.mode, targetElementId: element.targetElementId, feather: element.feather, pathCount: element.paths.length }
  return { childIds: element.childIds }
}

function presentationFor(element: SceneElement): PromptIrElement['presentation'] {
  if (!element.visible || element.referencePolicy === 'exclude' || element.type === 'mask' || element.type === 'group') return 'omitted'
  if (element.referencePolicy === 'reference-only' || element.type === 'placeholder' || (element.type === 'shape' && element.role === 'placeholder')) return 'semantic-guide'
  return 'visual'
}

function overlapRatio(left: SceneElement, right: SceneElement): number {
  const x1 = Math.max(left.transform.x, right.transform.x)
  const y1 = Math.max(left.transform.y, right.transform.y)
  const x2 = Math.min(left.transform.x + left.transform.width, right.transform.x + right.transform.width)
  const y2 = Math.min(left.transform.y + left.transform.height, right.transform.y + right.transform.height)
  if (x2 <= x1 || y2 <= y1) return 0
  const intersection = (x2 - x1) * (y2 - y1)
  return Math.min(1, intersection / Math.max(0.000_001, Math.min(
    left.transform.width * left.transform.height,
    right.transform.width * right.transform.height
  )))
}

function compileOcclusions(elements: readonly SceneElement[]): PromptIrOcclusion[] {
  const candidates = elements.filter((element) =>
    element.visible &&
    element.referencePolicy !== 'exclude' &&
    !['group', 'mask', 'light'].includes(element.type) &&
    element.semanticRole !== 'background'
  )
  const occlusions: PromptIrOcclusion[] = []
  for (let behindIndex = 0; behindIndex < candidates.length; behindIndex += 1) {
    for (let frontIndex = behindIndex + 1; frontIndex < candidates.length; frontIndex += 1) {
      const behind = candidates[behindIndex]
      const front = candidates[frontIndex]
      if (behind === undefined || front === undefined) continue
      const ratio = overlapRatio(behind, front)
      if (ratio < 0.08) continue
      occlusions.push({
        frontElementId: front.id,
        behindElementId: behind.id,
        overlapRatio: Number(ratio.toFixed(4)),
        instruction: `“${front.name}”位于“${behind.name}”前方；保持真实遮挡，不要把任一物体误解为透明材质。`
      })
    }
  }
  return occlusions
}

export function compilePromptIr(
  sceneInput: Scene,
  originalRequirement: string,
  compiledAt = new Date().toISOString()
): PromptIr {
  const scene = sceneSchema.parse(sceneInput)
  const protectedElementIds = new Set(scene.elements.filter((element) => element.locked).map((element) => element.id))
  for (const element of scene.elements) {
    if (element.type === 'mask' && element.mode === 'protect') protectedElementIds.add(element.targetElementId)
  }
  const excluded = scene.elements.filter((element) => element.referencePolicy === 'exclude')
  return promptIrSchema.parse({
    version: 1,
    sceneId: scene.id,
    sceneRevision: scene.revision,
    originalRequirement,
    canvas: { ...scene.canvas },
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      ...(element.controlIntent === undefined ? {} : { controlIntent: element.controlIntent }),
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
      referencePolicy: element.referencePolicy,
      presentation: presentationFor(element),
      zIndex: element.zIndex,
      opacity: element.opacity,
      blendMode: resolveBlendMode(element),
      bounds: { ...element.transform },
      attributes: attributesFor(element)
    })),
    relations: scene.relations.map((relation) => ({ ...relation })),
    occlusions: compileOcclusions(scene.elements),
    protectedElementIds: [...protectedElementIds],
    prohibitions: [
      '不要生成编辑器选框、控制点、辅助线、工具图标、光源控制器或占位标签。',
      '不要把构图辅助轮廓、保护区或语义占位当作最终可见文字。',
      ...excluded.map((element) => `不要包含“${element.name}”（${element.description || element.semanticRole}）。`)
    ],
    compiledAt
  })
}
