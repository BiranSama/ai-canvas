import { creativeContextSchema, type CreativeContext, type Scene, type SceneCommand, type SceneElement } from '../../domain'
import { designDirectionSelectionInputSchema, type DesignDirectionSelectionInput } from '../../shared/design-direction-selection'
import { compileCreativeContextReplacementCommands, selectCreativeDirection } from './planner'

export type CompiledDesignDirectionSelection =
  | {
      readonly status: 'ready'
      readonly directionId: string
      readonly summary: string
      readonly creativeContext: CreativeContext
      readonly commands: readonly SceneCommand[]
      readonly affectedElementIds: readonly string[]
      readonly message: string
    }
  | {
      readonly status: 'unchanged'
      readonly directionId: string
      readonly message: string
    }
  | {
      readonly status: 'conflict'
      readonly directionId: string
      readonly code: 'SCENE_REVISION_CHANGED' | 'MANUAL_SCENE_CHANGES' | 'PROTECTED_SCENE_CONTENT'
      readonly message: string
      readonly canReplaceAgentStructure: boolean
      readonly canRetryAfterUndo: boolean
      readonly canTryTemporarily: boolean
    }
  | {
      readonly status: 'rejected'
      readonly directionId: string
      readonly code: 'CREATIVE_CONTEXT_MISSING' | 'BRIEF_MISMATCH' | 'DIRECTION_NOT_FOUND' | 'CREATIVE_CONTEXT_INVALID'
      readonly message: string
    }

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001
}

function sameTransform(element: SceneElement, planned: CreativeContext['plan']['elements'][number]): boolean {
  return close(element.transform.x, planned.normalizedBounds.x)
    && close(element.transform.y, planned.normalizedBounds.y)
    && close(element.transform.width, planned.normalizedBounds.width)
    && close(element.transform.height, planned.normalizedBounds.height)
    && close(element.transform.rotation, planned.rotation)
}

function samePlannedElement(element: SceneElement, planned: CreativeContext['plan']['elements'][number], selectedDirectionId: string): boolean {
  if (element.type !== planned.type
    || element.name !== planned.name
    || element.description !== planned.semanticDescription
    || element.semanticRole !== planned.semanticRole
    || element.locked !== planned.locked
    || !sameTransform(element, planned)
    || element.provenance?.sourceDirectionId !== selectedDirectionId) return false
  const expectedOpacity = typeof planned.visualTreatment.opacity === 'number' ? planned.visualTreatment.opacity : 1
  if (!close(element.opacity, expectedOpacity)) return false
  const treatment = planned.visualTreatment
  if (element.type === 'text') {
    return element.content === String(treatment.content)
      && element.styleDescription === String(treatment.styleDescription)
      && element.renderStrategy === treatment.renderStrategy
      && element.visualWeight === (treatment.visualWeight ?? 'secondary')
  }
  if (element.type === 'shape') {
    return element.shape === treatment.shape
      && element.fill === String(treatment.fill)
      && element.role === treatment.role
  }
  if (element.type === 'placeholder') {
    return element.subject === String(treatment.subject)
      && element.frameShape === treatment.frameShape
      && element.visualKind === treatment.visualKind
  }
  if (element.type === 'light') {
    return close(element.direction, Number(treatment.direction))
      && close(element.intensity, Number(treatment.intensity))
  }
  if (element.type === 'sketch') return close(element.fidelity, Number(treatment.fidelity))
  return true
}

function planMembership(scene: Scene): {
  readonly plannedIds: ReadonlySet<string>
  readonly removableRootIds: ReadonlySet<string>
  readonly protectedContent: boolean
  readonly manualChanges: boolean
} {
  const context = scene.creativeContext!
  const selectedDirectionId = context.selectedDirectionId!
  const plannedIds = new Set(context.plan.elements.map((element) => element.id))
  const groups = scene.elements.filter((element): element is Extract<SceneElement, { type: 'group' }> => element.type === 'group')
  const mixedGroup = groups.some((group) => group.childIds.some((id) => plannedIds.has(id)) && group.childIds.some((id) => !plannedIds.has(id)))
  const groupIds = new Set(groups.filter((group) => group.childIds.length > 0 && group.childIds.every((id) => plannedIds.has(id))).map((group) => group.id))
  const removableRootIds = new Set(scene.elements
    .filter((element) => element.groupId === null && (plannedIds.has(element.id) || groupIds.has(element.id)))
    .map((element) => element.id))
  const protectedContent = mixedGroup
    || scene.elements.some((element) => plannedIds.has(element.id) && element.locked)
    || scene.elements.some((element) => element.type === 'mask' && element.mode === 'protect' && plannedIds.has(element.targetElementId))
  const missingOrChanged = context.plan.elements.some((planned) => {
    const element = scene.elements.find((candidate) => candidate.id === planned.id)
    return element === undefined || !samePlannedElement(element, planned, selectedDirectionId)
  })
  const unexplainedElement = scene.elements.some((element) => !plannedIds.has(element.id) && !groupIds.has(element.id))
  const expectedRelations = new Set(context.plan.elements.flatMap((element) => element.relations.map((relation) => relation.id)))
  const relationChanged = scene.relations.length !== expectedRelations.size
    || scene.relations.some((relation) => !expectedRelations.has(relation.id))
  return {
    plannedIds,
    removableRootIds,
    protectedContent,
    manualChanges: missingOrChanged || unexplainedElement || relationChanged
  }
}

export function compileDesignDirectionSelection(
  scene: Scene,
  inputValue: DesignDirectionSelectionInput,
  idFactory: () => string
): CompiledDesignDirectionSelection {
  const input = designDirectionSelectionInputSchema.parse(inputValue)
  if (input.expectedSceneRevision !== scene.revision) {
    return {
      status: 'conflict',
      directionId: input.directionId,
      code: 'SCENE_REVISION_CHANGED',
      message: `画布已从 revision ${input.expectedSceneRevision} 变化为 ${scene.revision}，未切换方向。`,
      canReplaceAgentStructure: true,
      canRetryAfterUndo: true,
      canTryTemporarily: true
    }
  }
  const parsed = creativeContextSchema.safeParse(scene.creativeContext)
  if (!parsed.success) {
    return {
      status: 'rejected',
      directionId: input.directionId,
      code: scene.creativeContext === null ? 'CREATIVE_CONTEXT_MISSING' : 'CREATIVE_CONTEXT_INVALID',
      message: scene.creativeContext === null ? '当前作品还没有可选择的设计方向。' : '当前设计上下文不完整，画布保持不变。'
    }
  }
  const current = parsed.data
  if (current.brief.id !== input.briefId) {
    return { status: 'rejected', directionId: input.directionId, code: 'BRIEF_MISMATCH', message: '这个方向不属于当前创作简报，画布保持不变。' }
  }
  const direction = current.directions?.find((candidate) => candidate.id === input.directionId && candidate.briefId === current.brief.id)
  if (direction === undefined) {
    return { status: 'rejected', directionId: input.directionId, code: 'DIRECTION_NOT_FOUND', message: '当前创作简报中不存在这个方向，画布保持不变。' }
  }
  if (current.selectedDirectionId === direction.id) {
    return { status: 'unchanged', directionId: direction.id, message: `“${direction.title}”已经是当前方向。` }
  }

  const membership = planMembership(scene)
  if (membership.protectedContent) {
    return {
      status: 'conflict',
      directionId: direction.id,
      code: 'PROTECTED_SCENE_CONTENT',
      message: '当前设计结构包含锁定对象、混合分组或保护蒙版。请先解除保护，再切换方向。',
      canReplaceAgentStructure: false,
      canRetryAfterUndo: true,
      canTryTemporarily: true
    }
  }
  if (membership.manualChanges && input.resolution === 'strict') {
    return {
      status: 'conflict',
      directionId: direction.id,
      code: 'MANUAL_SCENE_CHANGES',
      message: '方向提出后，画布结构已经被手工修改。系统没有覆盖这些内容。',
      canReplaceAgentStructure: true,
      canRetryAfterUndo: true,
      canTryTemporarily: true
    }
  }

  const creativeContext = selectCreativeDirection(current, direction.id, idFactory)
  const commands = compileCreativeContextReplacementCommands(scene, creativeContext, membership.removableRootIds, idFactory)
  return {
    status: 'ready',
    directionId: direction.id,
    summary: `切换设计方向：${direction.title}`,
    creativeContext,
    commands,
    affectedElementIds: creativeContext.plan.elements.map((element) => element.id),
    message: `已准备切换到“${direction.title}”，将作为一个可撤销批次提交。`
  }
}

