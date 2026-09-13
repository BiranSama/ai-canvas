import type { Scene } from '../../../domain'
import type { AgentRequest, EphemeralAnnotation, SceneSummary } from '../../../shared/agent'
import { useWorkspaceStore } from '../store/workspace-store'

export function summarizeScene(scene: Scene): SceneSummary {
  return {
    revision: scene.revision,
    canvas: {
      aspectWidth: scene.canvas.aspectWidth,
      aspectHeight: scene.canvas.aspectHeight,
      outputWidth: scene.canvas.outputWidth,
      outputHeight: scene.canvas.outputHeight,
      globalStyle: scene.canvas.globalStyle
    },
    elementCount: scene.elements.length,
    relationCount: scene.relations.length,
    creativeBrief: scene.creativeContext?.brief ?? null,
    creativeContext: scene.creativeContext,
    elements: scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      description: element.description,
      semanticRole: element.semanticRole,
      zIndex: element.zIndex,
      groupId: element.groupId,
      ...(element.type === 'group' ? { childIds: [...element.childIds] } : {}),
      locked: element.locked,
      visible: element.visible,
      referencePolicy: element.referencePolicy,
      ...(element.controlIntent === undefined ? {} : { controlIntent: element.controlIntent }),
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
      ...(element.type === 'text' ? {
        content: element.content,
        fontSize: element.fontSize,
        fontFamily: element.fontFamily,
        fontWeight: element.fontWeight,
        align: element.align,
        fill: element.fill,
        accuracy: element.accuracy,
        visualWeight: element.visualWeight ?? 'secondary',
        renderStrategy: element.renderStrategy,
        resultAssetId: element.resultAssetId
      } : {}),
      ...(element.type === 'image' ? {
        assetId: element.assetId,
        hasEditMask: scene.elements.some((mask) => mask.type === 'mask' && mask.targetElementId === element.id && mask.mode === 'edit' && mask.visible)
      } : {}),
      ...(element.type === 'placeholder' ? { subject: element.subject, visualKind: element.visualKind ?? 'generic' } : {}),
      ...(element.type === 'shape' ? { shapeRole: element.role, fill: element.fill } : {}),
      ...(element.type === 'light' ? { lightIntensity: element.intensity } : {}),
      transform: { ...element.transform }
    }))
  }
}

export async function createAgentRequest(
  text: string,
  autoGenerate: boolean,
  scope: 'selection' | 'canvas' = 'selection',
  ephemeralAnnotation: EphemeralAnnotation | null = null
): Promise<AgentRequest> {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const scopedIds = scope === 'canvas' ? [] : selectedIds
  const selectedElements = scene.elements.filter((element) => scopedIds.includes(element.id))
  const jobs = await window.desktop.listGenerationJobs()
  const activeGenerationJobId = jobs.find((job) => ['queued', 'preparing', 'uploading', 'generating', 'downloading', 'saving'].includes(job.status))?.id ?? null
  const selectionAttachments = selectedElements.flatMap((element) => element.type === 'image'
    ? [
        { kind: 'selection' as const, id: element.id, name: element.name },
        { kind: 'asset' as const, id: element.assetId, name: `${element.name} · 图片参考` }
      ]
    : [{ kind: 'selection' as const, id: element.id, name: element.name }])
  return {
    text,
    projectId: scene.projectId,
    sceneSummary: summarizeScene(scene),
    selectedIds: [...scopedIds],
    selectedElements,
    attachments: [
      ...selectionAttachments.slice(0, ephemeralAnnotation === null ? 20 : 19),
      ...(ephemeralAnnotation === null ? [] : [{ kind: 'selection' as const, id: ephemeralAnnotation.id, name: '本轮临时圈选' }])
    ],
    ephemeralAnnotation,
    autoGenerate,
    activeGenerationJobId
  }
}
