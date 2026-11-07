import { create } from 'zustand'
import { layerStyleSchema, type LayerStyle, type LayerStyleKind, type SceneElement } from '../../../domain'
import { defaultLayerStyle, LAYER_STYLE_LABELS } from '../../../shared/layer-styles'
import { showAppNotice } from '../components/app-notice'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's layer styles from the layers panel and the properties: the
 * 图层样式 dialog previews on the canvas and records one step on 确定;
 * single styles can be turned on or off and taken out; a layer's styles can
 * be copied onto others, or cleared.
 */

export type StylableElement = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

export function isStylable(element: SceneElement | undefined): element is StylableElement {
  return element !== undefined && (element.type === 'image' || element.type === 'text' || element.type === 'shape')
}

export interface StyleDialogState {
  readonly elementId: string
  /** The style shown first, on the left of the dialog. */
  readonly kind: LayerStyleKind
}

export const useStyleDialog = create<{ readonly open: StyleDialogState | null; show(open: StyleDialogState): void; close(): void }>()((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null })
}))

/** Styles being set up in the dialog, shown on the canvas before they are recorded. */
export const useStylePreview = create<{ readonly preview: { readonly elementId: string; readonly style: LayerStyle } | null; show(elementId: string, style: LayerStyle): void; clear(elementId: string): void }>()((set) => ({
  preview: null,
  show: (elementId, style) => set({ preview: { elementId, style } }),
  clear: (elementId) => set((state) => state.preview?.elementId === elementId ? { preview: null } : state)
}))

/** The element with the styles its dialog is showing, if any. */
export function withStylePreview<T extends SceneElement>(element: T, preview: { readonly elementId: string; readonly style: LayerStyle } | null): T {
  return preview !== null && preview.elementId === element.id && isStylable(element) ? { ...element, style: preview.style } : element
}

function refuse(message: string): false {
  showAppNotice(message)
  return false
}

function find(elementId: string): SceneElement | undefined {
  return useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === elementId)
}

/** The style a layer starts with when it is switched on in the dialog: its own settings if it had them, else Photoshop's. */
export function startingStyle<K extends LayerStyleKind>(style: LayerStyle | undefined, kind: K): NonNullable<LayerStyle[K]> {
  const own = style?.[kind]
  if (own !== undefined) return own as NonNullable<LayerStyle[K]>
  return defaultLayerStyle(kind, useWorkspaceStore.getState().foregroundColor.slice(0, 7).toUpperCase())
}

/** Opens the 图层样式 dialog on a layer, at one style, which is switched on if it was not. */
export function openLayerStyle(elementId: string, kind: LayerStyleKind = 'dropShadow'): boolean {
  const element = find(elementId)
  if (!isStylable(element)) return refuse('图层样式只能加在图片、文字和形状图层上。')
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能改图层样式。`)
  useStyleDialog.getState().show({ elementId, kind })
  return true
}

/** Records a layer's styles; an empty set takes them all off. */
export function commitLayerStyle(elementId: string, style: LayerStyle, summary: string): Promise<boolean> {
  const parsed = layerStyleSchema.parse(style)
  return useWorkspaceStore.getState().execute(summary, (scene) => {
    const current = scene.elements.find((candidate) => candidate.id === elementId)
    if (!isStylable(current)) return null
    return [{ kind: 'element.update', elementId, changes: { style: parsed } }]
  })
}

/** Switches one of a layer's styles on or off. */
export function toggleLayerStyle(element: StylableElement, kind: LayerStyleKind): Promise<boolean> {
  const entry = element.style?.[kind]
  if (entry === undefined) return Promise.resolve(false)
  return commitLayerStyle(element.id, { ...element.style, [kind]: { ...entry, enabled: !entry.enabled } }, `${entry.enabled ? '关闭' : '打开'}${LAYER_STYLE_LABELS[kind]}`)
}

/** Takes one style off a layer. */
export function removeLayerStyle(element: StylableElement, kind: LayerStyleKind): Promise<boolean> {
  const { [kind]: _removed, ...rest } = element.style ?? {}
  void _removed
  return commitLayerStyle(element.id, rest, `删除${LAYER_STYLE_LABELS[kind]}`)
}

let copied: LayerStyle | null = null

/** Photoshop's 拷贝图层样式. */
export function copyLayerStyle(element: SceneElement): boolean {
  if (!isStylable(element) || element.style === undefined || Object.keys(element.style).length === 0) return refuse(`「${element.name}」没有图层样式。`)
  copied = element.style
  showAppNotice(`已拷贝「${element.name}」的图层样式。`)
  return true
}

export function hasCopiedLayerStyle(): boolean {
  return copied !== null
}

/** Photoshop's 粘贴图层样式: the copied styles replace those of each stylable, unlocked layer. */
export function pasteLayerStyle(ids: readonly string[]): Promise<boolean> {
  const style = copied
  if (style === null) return Promise.resolve(refuse('还没有拷贝图层样式。'))
  return useWorkspaceStore.getState().execute('粘贴图层样式', (scene) => {
    const targets = scene.elements.filter((element) => ids.includes(element.id) && isStylable(element) && !element.locked)
    return targets.length === 0 ? null : targets.map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { style } }))
  })
}

/** Photoshop's 清除图层样式. */
export function clearLayerStyle(ids: readonly string[]): Promise<boolean> {
  return useWorkspaceStore.getState().execute('清除图层样式', (scene) => {
    const targets = scene.elements.filter((element) => ids.includes(element.id) && isStylable(element) && !element.locked && element.style !== undefined && Object.keys(element.style).length > 0)
    return targets.length === 0 ? null : targets.map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { style: {} } }))
  })
}
