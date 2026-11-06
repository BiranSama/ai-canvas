import { create } from 'zustand'
import { ELEMENT_SCHEMA_VERSION, WHOLE_CANVAS, type AdjustmentKind, type AdjustmentSettings, type LayerAdjustment, type LayerMask, type SceneCommand, type SceneElement } from '../../../domain'
import { ADJUSTMENT_LABELS, adjustLayerPixels, autoLevels, defaultAdjustment, histogram, type Histogram } from '../../../shared/adjustments'
import { boxLayerSpace, boxMaskSize, imageLayerSpace, maskInLayerSpace } from '../../../shared/layer-space'
import { showAppNotice } from '../components/app-notice'
import { rememberGrayAsset } from '../canvas/asset-pixels'
import { useAdjustmentPreview } from '../canvas/adjustment-preview'
import { renderLayersAsDrawn } from '../canvas/layer-render'
import { useMaskState } from '../canvas/mask-state'
import { layerSourceImage, pixelLayerCanvas } from '../canvas/pixel-layers'
import { selectionClip } from '../selection/selection-clip'
import { currentSelection, setSelectionMask } from '../selection/selection-store'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's adjustments from the keyboard, the layers panel and the
 * properties: an image layer's own adjustments open in a dialog and are
 * recorded on 确定; adjustment layers are added above the current layer and
 * changed in the properties.
 */

type ImageElement = Extract<SceneElement, { type: 'image' }>
type AdjustmentLayer = Extract<SceneElement, { type: 'adjustment' }>

/** The adjustments without settings: Photoshop applies them at once. */
const IMMEDIATE: ReadonlySet<AdjustmentKind> = new Set(['invert', 'desaturate'])

/** The kinds Photoshop's 新建调整图层 menu lists, in its order (去色 is a command, not an adjustment layer). */
export const ADJUSTMENT_LAYER_KINDS: readonly AdjustmentKind[] = ['brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'black-white', 'invert']

export interface AdjustmentDialogState {
  readonly elementId: string
  readonly adjustment: LayerAdjustment
  /** Not in the layer's list yet: 确定 adds it, 取消 leaves the layer as it was. */
  readonly isNew: boolean
  /** The selection a new adjustment is limited to: its pixels now, its asset once imported. */
  readonly clip: { readonly id: string; readonly pixels: Uint8Array; readonly assetId: Promise<string | null> } | null
}

export const useAdjustmentDialog = create<{ readonly open: AdjustmentDialogState | null; show(open: AdjustmentDialogState): void; close(): void }>()((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null })
}))

function refuse(message: string): false {
  showAppNotice(message)
  return false
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

function selectedOne(): SceneElement | undefined {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  return selectedIds.length === 1 ? scene.elements.find((element) => element.id === selectedIds[0]) : undefined
}

function canvasSize(): { readonly width: number; readonly height: number } {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return { width: outputWidth, height: outputHeight }
}

/** The selection read into the image layer's pixels, or 'outside' when it misses the layer. */
function layerClip(element: ImageElement): AdjustmentDialogState['clip'] | 'outside' | 'pending' {
  const image = layerSourceImage(element.id)
  if (image === null) return 'pending'
  const clip = selectionClip(element, imageLayerSpace(element, { width: image.naturalWidth, height: image.naturalHeight }, canvasSize()), 'adjust')
  if (clip.kind === 'outside') return 'outside'
  return clip.kind === 'none' ? null : { id: newId(), pixels: clip.pixels, assetId: clip.assetId }
}

/** Records an image layer's adjustment: a new one at the end of its list, or the changed one in its place. */
export async function commitLayerAdjustment(open: AdjustmentDialogState, settings: AdjustmentSettings): Promise<boolean> {
  const store = useWorkspaceStore.getState()
  const element = store.scene.elements.find((candidate) => candidate.id === open.elementId)
  if (element?.type !== 'image') return false
  let adjustment: LayerAdjustment = { ...open.adjustment, settings }
  if (open.isNew && open.clip !== null) {
    const clipId = await open.clip.assetId
    if (clipId === null) return refuse('选区没有存好，没有调整。')
    adjustment = { ...adjustment, clip: clipId }
  }
  const current = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === open.elementId)
  if (current?.type !== 'image') return false
  const list = current.adjustments ?? []
  const next = open.isNew ? [...list, adjustment] : list.map((candidate) => candidate.id === adjustment.id ? adjustment : candidate)
  return useWorkspaceStore.getState().updateElement(current.id, { adjustments: next }, ADJUSTMENT_LABELS[settings.kind])
}

/** Changes an image layer's list of adjustments: on or off, order, or one taken out. */
export function changeLayerAdjustments(element: ImageElement, next: readonly LayerAdjustment[], summary: string): Promise<boolean> {
  return useWorkspaceStore.getState().updateElement(element.id, { adjustments: next }, summary)
}

/** Opens one of an image layer's adjustments again in its dialog. */
export function editLayerAdjustment(element: ImageElement, adjustmentId: string): void {
  const adjustment = element.adjustments?.find((candidate) => candidate.id === adjustmentId)
  if (adjustment === undefined || IMMEDIATE.has(adjustment.settings.kind)) return
  useAdjustmentDialog.getState().show({ elementId: element.id, adjustment, isNew: false, clip: null })
}

/**
 * Photoshop's 图像 > 调整 on the selected layer: on an image layer the
 * dialog opens (inside the selection when there is one); 反相 and 去色 apply
 * at once. On an adjustment layer its properties open instead.
 */
export async function adjustSelectedLayer(kind: AdjustmentKind): Promise<boolean> {
  const element = selectedOne()
  if (element === undefined) return refuse('先选中一个图片图层；要调整整个画面，用图层面板的「新建调整图层」。')
  if (element.type === 'adjustment') {
    useWorkspaceStore.getState().setInspectorTab('properties')
    return true
  }
  if (element.type === 'text' || element.type === 'shape') return refuse(`「${element.name}」是${element.type === 'text' ? '文字' : '形状'}图层，不能直接调整：用图层面板的「新建调整图层」，或先栅格化。`)
  if (element.type !== 'image') return refuse('只有图片图层能直接调整；要调整整个画面，用图层面板的「新建调整图层」。')
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能调整。`)
  if (!element.visible) return refuse(`「${element.name}」是隐藏的，显示后才能调整。`)
  const clip = layerClip(element)
  if (clip === 'pending') return refuse(`「${element.name}」还没画好，稍后再试。`)
  if (clip === 'outside') return refuse(`选区不在「${element.name}」上，调整不到。`)
  const adjustment: LayerAdjustment = { id: newId(), enabled: true, settings: defaultAdjustment(kind) }
  const open: AdjustmentDialogState = { elementId: element.id, adjustment, isNew: true, clip }
  if (IMMEDIATE.has(kind)) return commitLayerAdjustment(open, adjustment.settings)
  useAdjustmentDialog.getState().show(open)
  return true
}

/** How large a histogram is worked out: plenty for its 256 bins, and quick. */
const HISTOGRAM_EDGE = 512

function shrunk(source: CanvasImageSource, size: { readonly width: number; readonly height: number }, background: string | null): ImageData | null {
  const scale = Math.min(1, HISTOGRAM_EDGE / Math.max(size.width, size.height))
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  if (background !== null) {
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(source, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

/** The histogram an image layer's adjustment works on: its pixels, after the adjustments before this one. */
export function layerHistogram(element: ImageElement, adjustmentId: string): Histogram | null {
  const source = pixelLayerCanvas(element.id) ?? layerSourceImage(element.id)
  if (source === null) return null
  const pixels = shrunk(source, source instanceof HTMLImageElement ? { width: source.naturalWidth, height: source.naturalHeight } : source, null)
  if (pixels === null) return null
  const list = element.adjustments ?? []
  const index = list.findIndex((adjustment) => adjustment.id === adjustmentId)
  // Earlier adjustments made in a selection are left out here: the histogram is a guide, not the picture.
  adjustLayerPixels(pixels.data, (index < 0 ? list : list.slice(0, index)).filter((adjustment) => adjustment.clip === undefined))
  return histogram(pixels.data)
}

/** The histogram an adjustment layer works on: the picture below it, as drawn. */
export async function belowHistogram(element: AdjustmentLayer): Promise<Histogram | null> {
  const { scene } = useWorkspaceStore.getState()
  const index = scene.elements.findIndex((candidate) => candidate.id === element.id)
  const below = scene.elements.slice(0, Math.max(0, index)).filter((candidate) => candidate.visible && candidate.type !== 'group').map((candidate) => candidate.id)
  const background = scene.canvas.transparent ? null : scene.canvas.backgroundColor
  const drawn = below.length === 0 ? null : await renderLayersAsDrawn(below)
  if (drawn === null) {
    if (background === null) return null
    const blank = document.createElement('canvas')
    blank.width = 1
    blank.height = 1
    const pixels = shrunk(blank, blank, background)
    return pixels === null ? null : histogram(pixels.data)
  }
  const pixels = shrunk(drawn, drawn, background)
  return pixels === null ? null : histogram(pixels.data)
}

/** Photoshop's 自动色调 (Ctrl+Shift+L) and 自动对比度 (Ctrl+Alt+Shift+L) on the selected image layer: a levels adjustment set from its histogram. */
export async function autoTone(mode: 'tone' | 'contrast'): Promise<boolean> {
  const element = selectedOne()
  if (element?.type !== 'image') return refuse(`先选中一个图片图层再做${mode === 'tone' ? '自动色调' : '自动对比度'}。`)
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能调整。`)
  const counts = layerHistogram(element, '')
  if (counts === null) return refuse(`「${element.name}」还没画好，稍后再试。`)
  const clip = layerClip(element)
  if (clip === 'pending') return refuse(`「${element.name}」还没画好，稍后再试。`)
  if (clip === 'outside') return refuse(`选区不在「${element.name}」上，调整不到。`)
  const settings = autoLevels(counts, mode)
  const open: AdjustmentDialogState = { elementId: element.id, adjustment: { id: newId(), enabled: true, settings }, isNew: true, clip }
  return commitLayerAdjustment(open, settings)
}

function layerName(kind: AdjustmentKind): string {
  const label = ADJUSTMENT_LABELS[kind]
  const taken = new Set(useWorkspaceStore.getState().scene.elements.map((element) => element.name))
  let number = 1
  while (taken.has(`${label} ${number}`)) number += 1
  return `${label} ${number}`
}

/** The selection as an adjustment layer's mask over the whole canvas, imported; null with nothing selected. */
async function selectionMask(element: AdjustmentLayer): Promise<LayerMask | null | 'failed'> {
  const selection = currentSelection()
  if (selection === null) return null
  const canvas = canvasSize()
  const space = boxLayerSpace(element, boxMaskSize(element, canvas), canvas)
  const mask = { width: space.width, height: space.height, data: maskInLayerSpace(selection, space) }
  try {
    const asset = await window.desktop.importPixels({ projectId: useWorkspaceStore.getState().scene.projectId, name: '调整蒙版.png', width: mask.width, height: mask.height, gray: new Uint8Array(mask.data) })
    rememberGrayAsset(asset.id, mask)
    return { assetId: asset.id, enabled: true }
  } catch {
    return 'failed'
  }
}

/**
 * Photoshop's 新建调整图层: added above the topmost selected layer (or on
 * top), selected, its properties shown. With a selection it comes masked to
 * it, and the selection is dropped, as in Photoshop.
 */
export async function createAdjustmentLayer(kind: AdjustmentKind, settings: AdjustmentSettings = defaultAdjustment(kind)): Promise<string | null> {
  const store = useWorkspaceStore.getState()
  const base: AdjustmentLayer = {
    id: newId(), version: ELEMENT_SCHEMA_VERSION, type: 'adjustment', name: layerName(kind), description: '',
    transform: { ...WHOLE_CANVAS }, zIndex: store.scene.elements.length, opacity: 1, blendMode: 'normal', visible: true, locked: false,
    groupId: null, semanticRole: 'adjustment', referencePolicy: 'include', settings, mask: null
  }
  const mask = await selectionMask(base)
  if (mask === 'failed') { showAppNotice('选区没有存好，调整图层没有加上。', 'problem'); return null }
  const layer: AdjustmentLayer = { ...base, mask }
  const current = useWorkspaceStore.getState()
  const above = Math.max(-1, ...current.scene.elements.filter((element) => current.selectedIds.includes(element.id)).map((element) => element.zIndex))
  const commands: SceneCommand[] = [{ kind: 'element.add', element: layer }]
  if (above >= 0 && above + 1 < current.scene.elements.length) commands.push({ kind: 'element.reorder', elementId: layer.id, toIndex: above + 1 })
  if (!await current.execute(`新建调整图层「${layer.name}」`, commands)) return null
  if (mask !== null) setSelectionMask(null)
  useMaskState.getState().editMask(null)
  useWorkspaceStore.getState().setSelection([layer.id])
  useWorkspaceStore.getState().setInspectorTab('properties')
  return layer.id
}

/** Shows an adjustment layer's settings while a control is moving, then records them when it is let go. */
export async function setAdjustmentLayerSettings(element: AdjustmentLayer, settings: AdjustmentSettings, final: boolean): Promise<void> {
  const preview = useAdjustmentPreview.getState()
  if (!final) {
    preview.show({ kind: 'adjustment-layer', elementId: element.id, settings })
    return
  }
  if (element.locked) {
    preview.clear(element.id)
    showAppNotice(`「${element.name}」已锁定，解锁后才能改。`)
    return
  }
  await useWorkspaceStore.getState().updateElement(element.id, { settings }, ADJUSTMENT_LABELS[settings.kind])
  useAdjustmentPreview.getState().clear(element.id)
}
