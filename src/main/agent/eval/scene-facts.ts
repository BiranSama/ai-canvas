import type { Scene, SceneElement } from '../../../domain'
import type { SceneSummary } from '../../../shared/agent'
import type { ElementSelection, ElementSelector } from './case-schema'

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function matchesSelector(element: SceneElement, selector: ElementSelector): boolean {
  if (selector.id !== undefined && element.id !== selector.id) return false
  if (selector.name !== undefined && element.name !== selector.name) return false
  if (selector.nameIncludes !== undefined && !element.name.includes(selector.nameIncludes)) return false
  if (selector.type !== undefined && element.type !== selector.type) return false
  if (selector.role !== undefined && element.semanticRole !== selector.role) return false
  if (selector.text !== undefined && (element.type !== 'text' || element.content.trim() !== selector.text)) return false
  if (selector.textIncludes !== undefined && (element.type !== 'text' || !element.content.includes(selector.textIncludes))) return false
  return true
}

export function selectorList(selection: ElementSelection): readonly ElementSelector[] {
  return Array.isArray(selection) ? selection : [selection]
}

export function selectElements(scene: Scene, selection: ElementSelection): readonly SceneElement[] {
  const selectors = selectorList(selection)
  return scene.elements.filter((element) => selectors.some((selector) => matchesSelector(element, selector)))
}

export function describeSelection(selection: ElementSelection): string {
  return selectorList(selection).map((selector) => Object.entries(selector).map(([key, value]) => `${key}=${String(value)}`).join(',')).join(' | ')
}

/** Element content without its stacking index, which other layers' edits may renumber. */
export function elementFingerprint(element: SceneElement): string {
  return stableJson({ ...element, zIndex: undefined })
}

/** True when two scenes hold the same canvas, elements (in order), relations and creative context. */
export function sameSceneContent(left: Scene, right: Scene): boolean {
  return stableJson({ canvas: left.canvas, elements: left.elements, relations: left.relations, creativeContext: left.creativeContext })
    === stableJson({ canvas: right.canvas, elements: right.elements, relations: right.relations, creativeContext: right.creativeContext })
}

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Axis-aligned bounds in canvas units (aspect-corrected), rotation included. */
export function elementBox(element: SceneElement, scene: Scene): Box {
  const scaleX = scene.canvas.aspectWidth
  const scaleY = scene.canvas.aspectHeight
  const { x, y, width, height, rotation } = element.transform
  const centerX = (x + width / 2) * scaleX
  const centerY = (y + height / 2) * scaleY
  const radians = (rotation * Math.PI) / 180
  const halfWidth = (Math.abs(width * scaleX * Math.cos(radians)) + Math.abs(height * scaleY * Math.sin(radians))) / 2
  const halfHeight = (Math.abs(width * scaleX * Math.sin(radians)) + Math.abs(height * scaleY * Math.cos(radians))) / 2
  return { left: centerX - halfWidth, top: centerY - halfHeight, right: centerX + halfWidth, bottom: centerY + halfHeight }
}

/** Intersection area divided by the smaller box's area; 0 means no overlap. */
export function overlapRatio(left: Box, right: Box): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
  const smaller = Math.min((left.right - left.left) * (left.bottom - left.top), (right.right - right.left) * (right.bottom - right.top))
  return smaller <= 0 ? 0 : (width * height) / smaller
}

export function sameRatio(width: number, height: number, expectedWidth: number, expectedHeight: number): boolean {
  return Math.abs(width / height - expectedWidth / expectedHeight) < 0.005
}

export function visibleTexts(scene: Scene): readonly string[] {
  return scene.elements.flatMap((element) => element.type === 'text' && element.visible ? [element.content] : [])
}

/** Mirrors the Renderer composer's scene summary; Main refreshes it before planning. */
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
