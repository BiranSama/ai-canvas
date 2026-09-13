import { randomUUID } from 'node:crypto'
import type { Scene } from '../../domain'
import type { ProviderCapabilities, ReferenceMode } from '../../shared/generation'
import { promptPackageSchema, type PromptIr, type PromptPackage } from '../../shared/reference'

function relationCopy(ir: PromptIr, elementId: string): string[] {
  return ir.relations.flatMap((relation) => {
    if (relation.sourceElementId !== elementId && relation.targetElementId !== elementId) return []
    const source = ir.elements.find((element) => element.id === relation.sourceElementId)?.name ?? relation.sourceElementId
    const target = ir.elements.find((element) => element.id === relation.targetElementId)?.name ?? relation.targetElementId
    return [`${source} ${relation.type} ${target}${relation.description ? `：${relation.description}` : ''}`]
  })
}

export function compilePromptPackage(
  scene: Scene,
  ir: PromptIr,
  references: { readonly appearanceCompositeAssetId: string; readonly semanticSheetAssetId: string },
  options: {
    readonly idFactory?: () => string
    readonly compiledAt?: string
    readonly renderTier?: PromptPackage['renderTier']
    readonly providerId?: string
    readonly model?: string
    readonly capabilities?: Pick<ProviderCapabilities, 'imageReferences' | 'multipleReferences' | 'maskEditing'>
    readonly referenceMode?: ReferenceMode
    readonly targetOutput?: PromptPackage['targetOutput']
  } = {}
): PromptPackage {
  const idFactory = options.idFactory ?? randomUUID
  const compiledAt = options.compiledAt ?? ir.compiledAt
  const brief = scene.creativeContext?.brief
  const plan = scene.creativeContext?.plan
  const currentBrief = brief !== undefined && brief.version !== 1 ? brief : null
  const fallbackId = idFactory()
  const textModeByContent = new Map(brief?.text.map((text) => [text.content, text.mode]) ?? [])
  const textWeightByContent = new Map(brief?.text.map((text) => [text.content, text.visualWeight ?? 'secondary']) ?? [])
  const compositionContract = [
    `输出比例 ${options.targetOutput?.aspectWidth ?? ir.canvas.aspectWidth}:${options.targetOutput?.aspectHeight ?? ir.canvas.aspectHeight}，分辨率 ${options.targetOutput?.outputWidth ?? ir.canvas.outputWidth}×${options.targetOutput?.outputHeight ?? ir.canvas.outputHeight}。`,
    ...ir.occlusions.map((item) => item.instruction),
    ...ir.relations.map((relation) => {
      const source = ir.elements.find((element) => element.id === relation.sourceElementId)?.name ?? relation.sourceElementId
      const target = ir.elements.find((element) => element.id === relation.targetElementId)?.name ?? relation.targetElementId
      return `${source} ${relation.type} ${target}${relation.description ? `：${relation.description}` : ''}`
    }),
    ...(currentBrief?.compositionNotes ?? []),
    ...(currentBrief?.keep.map((item) => `必须保留：${item}`) ?? [])
  ]
  const sourceReferences = ir.elements.flatMap((element) => element.type === 'image' && element.referencePolicy !== 'exclude' && typeof element.attributes.assetId === 'string'
    ? [{ assetId: element.attributes.assetId, role: element.attributes.referenceRole === 'composition' ? 'sketch-underlay' as const : 'source-image' as const, weight: element.referencePolicy === 'reference-only' ? .66 : .78, sourceElementId: element.id }]
    : [])
  const maskReferences = ir.elements.flatMap((element) => element.type === 'mask'
    ? [{
        assetId: references.semanticSheetAssetId,
        role: 'mask' as const,
        weight: element.attributes.mode === 'protect' ? .9 : .76,
        sourceElementId: element.id
      }]
    : [])
  return promptPackageSchema.parse({
    version: 1,
    ...(options.targetOutput === undefined ? {} : { targetOutput: options.targetOutput }),
    id: idFactory(),
    referenceMode: options.referenceMode ?? 'hybrid',
    sceneIntent: {
      purpose: currentBrief?.purpose ?? brief?.intent ?? '依据当前可编辑 Scene 生成完整画面',
      medium: brief?.media ?? ['结构化画布参考'],
      usage: brief?.usage ?? null,
      originalRequirement: ir.originalRequirement
    },
    compositionContract,
    elementBriefs: ir.elements.map((element) => ({
      id: element.id,
      name: element.name,
      type: element.type,
      description: element.description,
      semanticRole: element.semanticRole,
      ...(element.controlIntent === undefined ? {} : { controlIntent: element.controlIntent }),
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
      layer: element.zIndex,
      blendMode: element.blendMode,
      visibility: element.presentation,
      bounds: element.bounds,
      relations: relationCopy(ir, element.id),
      occludedBy: ir.occlusions.filter((item) => item.behindElementId === element.id).map((item) => item.frontElementId),
      protected: ir.protectedElementIds.includes(element.id)
    })),
    styleBible: [
      ...(brief?.mood ?? []),
      ...(currentBrief?.style ?? []),
      ...(brief?.palette.map((color) => `色彩 ${color}`) ?? []),
      ...((brief?.lighting ?? []).map((light) => `光影：${light.description}，${light.color}，方向 ${light.direction}°，强度 ${Math.round(light.intensity * 100)}%`)),
      ...(ir.canvas.globalStyle ? [ir.canvas.globalStyle] : [])
    ],
    textContract: ir.elements.flatMap((element) => element.type === 'text' ? [{
      elementId: element.id,
      content: String(element.attributes.content ?? ''),
      style: String(element.attributes.styleDescription ?? element.description),
      accuracy: element.attributes.accuracy as 'strict' | 'balanced' | 'expressive',
      mode: textModeByContent.get(String(element.attributes.content ?? '')) ?? (element.attributes.renderStrategy === 'editable-overlay' ? 'exact-overlay' : element.attributes.renderStrategy === 'standard' ? 'reference' : 'image-text'),
      visualWeight: textWeightByContent.get(String(element.attributes.content ?? '')) ?? (element.attributes.visualWeight as 'whisper' | 'secondary' | 'primary' | 'hero' | undefined) ?? 'secondary'
    }] : []),
    negativeConstraints: [...new Set([...ir.prohibitions, ...(brief?.constraints ?? []), ...(currentBrief?.prohibitions ?? [])])],
    referenceManifest: [
      { assetId: references.appearanceCompositeAssetId, role: 'appearance-composite', weight: .82, sourceElementId: null },
      { assetId: references.semanticSheetAssetId, role: 'semantic-sheet', weight: .72, sourceElementId: null },
      ...sourceReferences,
      ...maskReferences
    ],
    renderTier: options.renderTier ?? 'mock-final',
    generationProfile: {
      providerId: options.providerId ?? 'mock',
      model: options.model ?? 'mock-balanced',
      imageReferences: options.capabilities?.imageReferences ?? true,
      multipleReferences: options.capabilities?.multipleReferences ?? true,
      maskEditing: options.capabilities?.maskEditing ?? true
    },
    provenance: {
      sceneId: ir.sceneId,
      sceneRevision: ir.sceneRevision,
      briefId: brief?.id ?? fallbackId,
      directionId: scene.creativeContext?.selectedDirectionId ?? null,
      planId: plan?.id ?? fallbackId,
      compiledAt
    }
  })
}
