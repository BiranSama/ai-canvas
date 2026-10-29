import type { LayerMask, SceneElement } from '../../../domain'
import { boxLayerSpace, boxMaskSize, imageLayerSpace, layerMaskOnCanvas, maskInLayerSpace, type LayerSpace } from '../../../shared/layer-space'
import { createMask, invertMask, type GrayMask } from '../../../shared/mask-raster'
import { showAppNotice } from '../components/app-notice'
import { currentSelection, setSelectionMask } from '../selection/selection-store'
import { useWorkspaceStore } from '../store/workspace-store'
import { rememberGrayAsset } from './asset-pixels'
import { opaqueBounds, renderLayersAsDrawn } from './layer-render'
import { useMaskState } from './mask-state'
import { layerMaskPixels, layerPixels, layerSourceImage } from './pixel-layers'

/*
 * Photoshop's layer masks from the layers panel and the keyboard: add one
 * from the selection (Alt hides the selection instead), apply, delete,
 * turn off, invert, load as a selection, and the ways of looking at one.
 */

type MaskableElement = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

export function isMaskable(element: SceneElement | undefined): element is MaskableElement {
  return element !== undefined && (element.type === 'image' || element.type === 'text' || element.type === 'shape')
}

function find(elementId: string): MaskableElement | null {
  const element = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === elementId)
  return isMaskable(element) ? element : null
}

function canvasSize(): { readonly width: number; readonly height: number } {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return { width: outputWidth, height: outputHeight }
}

/** The pixels a layer's mask lives in: an image's own, or a text or shape layer's box. */
function maskSpace(element: MaskableElement, size?: { readonly width: number; readonly height: number }): LayerSpace | null {
  if (element.type === 'image') {
    const image = layerSourceImage(element.id)
    return image === null ? null : imageLayerSpace(element, { width: image.naturalWidth, height: image.naturalHeight }, canvasSize())
  }
  return boxLayerSpace(element, size ?? boxMaskSize(element, canvasSize()), canvasSize())
}

async function importGray(mask: GrayMask, name: string): Promise<string | null> {
  try {
    const asset = await window.desktop.importPixels({ projectId: useWorkspaceStore.getState().scene.projectId, name, width: mask.width, height: mask.height, gray: new Uint8Array(mask.data) })
    rememberGrayAsset(asset.id, mask)
    return asset.id
  } catch {
    showAppNotice('蒙版没有存好，稍后再试。', 'problem')
    return null
  }
}

function refuse(message: string): false {
  showAppNotice(message)
  return false
}

/**
 * Photoshop's 添加蒙版: the selection shows and the rest hides, or with Alt
 * the reverse; with nothing selected the mask is white (Alt: black). The
 * mask is then the painting tools' target, and the selection is dropped.
 */
export async function addLayerMask(elementId: string, hideSelection: boolean): Promise<boolean> {
  const element = find(elementId)
  if (element === null) return refuse('只有图片、文字和形状图层能加蒙版。')
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能加蒙版。`)
  if (element.mask !== null && element.mask !== undefined) return refuse(`「${element.name}」已经有蒙版了。`)
  const space = maskSpace(element)
  if (space === null) return refuse(`「${element.name}」还没画好，稍后再试。`)
  const selection = currentSelection()
  let mask: GrayMask = selection === null
    ? createMask(space.width, space.height, 255)
    : { width: space.width, height: space.height, data: maskInLayerSpace(selection, space) }
  if (hideSelection) mask = invertMask(mask)
  const assetId = await importGray(mask, '图层蒙版.png')
  if (assetId === null) return false
  const next: LayerMask = { assetId, enabled: true }
  if (!await useWorkspaceStore.getState().updateElement(element.id, { mask: next }, hideSelection ? '添加蒙版（隐藏选区）' : '添加蒙版')) return false
  if (selection !== null) setSelectionMask(null)
  useMaskState.getState().editMask(element.id)
  return true
}

/** A new asset holding the mask as it is now, its paint baked in. */
async function bakedMask(element: MaskableElement, change: (coverage: GrayMask) => GrayMask, name: string): Promise<LayerMask | null> {
  const mask = element.mask
  const pixels = layerMaskPixels(element.id)
  if (mask === null || mask === undefined || pixels === null) return null
  const assetId = await importGray(change({ width: pixels.width, height: pixels.height, data: new Uint8Array(pixels.coverage) }), name)
  return assetId === null ? null : { assetId, enabled: mask.enabled }
}

/** Ctrl+I while editing a mask: what showed hides and what hid shows. */
export async function invertLayerMask(elementId: string): Promise<boolean> {
  const element = find(elementId)
  if (element === null || element.mask === null || element.mask === undefined) return false
  if (element.locked) return refuse(`「${element.name}」已锁定。`)
  const next = await bakedMask(element, invertMask, '图层蒙版.png')
  return next !== null && useWorkspaceStore.getState().updateElement(element.id, { mask: next }, '反相蒙版')
}

export function setMaskEnabled(elementId: string, enabled: boolean): Promise<boolean> {
  const element = find(elementId)
  if (element === null || element.mask === null || element.mask === undefined) return Promise.resolve(false)
  return useWorkspaceStore.getState().updateElement(element.id, { mask: { ...element.mask, enabled } }, enabled ? '启用蒙版' : '停用蒙版')
}

export function deleteLayerMask(elementId: string): Promise<boolean> {
  const element = find(elementId)
  if (element === null || element.mask === null || element.mask === undefined) return Promise.resolve(false)
  if (useMaskState.getState().editing === elementId) useMaskState.getState().editMask(null)
  return useWorkspaceStore.getState().updateElement(element.id, { mask: null }, '删除蒙版')
}

/**
 * Photoshop's 应用蒙版: the mask goes into the pixels and is gone. An image
 * layer keeps its place with new pixels; a text or shape layer becomes an
 * image as it looks.
 */
export async function applyLayerMask(elementId: string): Promise<boolean> {
  const element = find(elementId)
  if (element === null || element.mask === null || element.mask === undefined) return false
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能应用蒙版。`)
  if (!element.mask.enabled) return refuse('先启用蒙版（Shift+单击蒙版缩略图），再应用。')
  if (element.type === 'image') {
    const pixels = layerPixels(element.id)
    const mask = layerMaskPixels(element.id)
    if (pixels === null || mask === null || mask.width !== pixels.width || mask.height !== pixels.height) return refuse(`「${element.name}」还没画好，稍后再试。`)
    const rgba = new Uint8Array(pixels.data)
    for (let pixel = 0; pixel < mask.coverage.length; pixel += 1) rgba[pixel * 4 + 3] = Math.round(rgba[pixel * 4 + 3]! * mask.coverage[pixel]! / 255)
    const asset = await window.desktop.importPixels({ projectId: useWorkspaceStore.getState().scene.projectId, name: `${element.name}.png`, width: pixels.width, height: pixels.height, rgba })
    if (useMaskState.getState().editing === elementId) useMaskState.getState().editMask(null)
    return useWorkspaceStore.getState().updateElement(element.id, { assetId: asset.id, paint: [], mask: null }, '应用蒙版')
  }
  const drawn = await renderLayersAsDrawn([element.id], { base: element.id, showHidden: true })
  if (drawn === null) return refuse(`「${element.name}」还没画好，稍后再试。`)
  const area = opaqueBounds(drawn) ?? { x: 0, y: 0, width: drawn.width, height: drawn.height }
  const data = drawn.getContext('2d')?.getImageData(area.x, area.y, area.width, area.height)
  if (data === undefined) return false
  const asset = await window.desktop.importPixels({ projectId: useWorkspaceStore.getState().scene.projectId, name: `${element.name}.png`, width: area.width, height: area.height, rgba: new Uint8Array(data.data.buffer) })
  if (useMaskState.getState().editing === elementId) useMaskState.getState().editMask(null)
  return useWorkspaceStore.getState().execute('应用蒙版', [{
    kind: 'element.rasterize', elementId: element.id, assetId: asset.id,
    transform: { x: area.x / drawn.width, y: area.y / drawn.height, width: area.width / drawn.width, height: area.height / drawn.height, rotation: 0 }
  }])
}

/** Ctrl+click on a mask's thumbnail: the mask becomes the selection. */
export function loadMaskAsSelection(elementId: string): boolean {
  const element = find(elementId)
  const pixels = layerMaskPixels(elementId)
  if (element === null || pixels === null) return false
  const space = maskSpace(element, { width: pixels.width, height: pixels.height })
  if (space === null) return false
  setSelectionMask(layerMaskOnCanvas(pixels.coverage, space, canvasSize()))
  return true
}

/** Ctrl+click on a layer's thumbnail: its pixels' transparency becomes the selection, as in Photoshop. */
export async function loadTransparencyAsSelection(elementId: string): Promise<boolean> {
  const element = find(elementId)
  if (element === null) return false
  const drawn = await renderLayersAsDrawn([element.id], { base: element.id, showHidden: true })
  const data = drawn?.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, drawn.width, drawn.height)
  if (drawn === null || data === undefined) return false
  const mask = createMask(drawn.width, drawn.height)
  for (let pixel = 0; pixel < mask.data.length; pixel += 1) mask.data[pixel] = data.data[pixel * 4 + 3]!
  setSelectionMask(mask)
  return true
}

/** \\: the mask's hidden parts in red over the layer, on and off. */
export function toggleMaskOverlay(elementId: string): void {
  const { view, setView } = useMaskState.getState()
  setView(elementId, view?.elementId === elementId && view.mode === 'overlay' ? 'normal' : 'overlay')
}

/** Alt+click on a mask's thumbnail: the mask alone, on and off. */
export function toggleMaskAlone(elementId: string): void {
  const { view, setView } = useMaskState.getState()
  setView(elementId, view?.elementId === elementId && view.mode === 'alone' ? 'normal' : 'alone')
}

/** A click on a mask's thumbnail makes the mask the painting target; on the layer's thumbnail, its pixels. */
export function editMask(elementId: string, onMask: boolean): void {
  useMaskState.getState().editMask(onMask ? elementId : null)
}
