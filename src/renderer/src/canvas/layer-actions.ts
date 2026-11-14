import { canBeClipBase, canBeClipped, clipBases, clipStacks, cornersBendPaint, type NormalizedTransform, type PaintOp, type SceneCommand, type SceneElement } from '../../../domain'
import { MAX_EXPORT_EDGE } from '../../../shared/artwork-export'
import { imageLayerSpace } from '../../../shared/layer-space'
import { layerStyleReach } from '../../../shared/layer-styles'
import { logoPlacement } from '../../../shared/user-memory'
import type { GrayMask } from '../../../shared/mask-raster'
import { showAppNotice } from '../components/app-notice'
import { selectionClip, type SelectionClip } from '../selection/selection-clip'
import { currentSelection } from '../selection/selection-store'
import { layerArea } from '../export/psd-plan'
import { layerSourceImage } from './pixel-layers'
import { useWorkspaceStore } from '../store/workspace-store'
import { createElementForTool } from './element-factory'
import { opaqueBounds, renderLayersAsDrawn, type LayerRenderOptions } from './layer-render'

/** Photoshop's next free name: 图层 1, 图层 2, … */
function nextLayerName(elements: readonly SceneElement[]): string {
  const used = elements.map((element) => /^图层 (\d+)$/.exec(element.name)?.[1]).filter((value): value is string => value !== undefined).map(Number)
  return `图层 ${used.length === 0 ? 1 : Math.max(...used) + 1}`
}

const FULL_CANVAS: NormalizedTransform = { x: 0, y: 0, width: 1, height: 1, rotation: 0 }

/**
 * The pixels of some layers as drawn, cut to what they cover, imported as
 * an asset, and where they sit on the canvas. A picture with nothing in it
 * keeps the whole canvas, as a blank layer does.
 */
/**
 * Whether painting on the layer would bend with it: after a skew, distort
 * or perspective (a flip maps pixel for pixel), as on Photoshop's smart
 * objects, it has to be rasterized first.
 */
export function needsRasterizeToPaint(element: SceneElement): boolean {
  return cornersBendPaint(element.type === 'image' || element.type === 'text' || element.type === 'shape' ? element.corners : null)
}

async function drawnAsset(ids: readonly string[], summary: string, options: LayerRenderOptions = {}, within: GrayMask | null = null): Promise<{ readonly assetId: string; readonly transform: NormalizedTransform } | null> {
  const { scene } = useWorkspaceStore.getState()
  const drawn = await renderLayersAsDrawn(ids, options)
  if (drawn === null) {
    showAppNotice(`没能${summary}：画布上的图层还没画好，稍后再试。`, 'problem')
    return null
  }
  // Only what the selection covers, as Photoshop's Layer via Copy takes.
  if (within !== null && within.width === drawn.width && within.height === drawn.height) {
    const context = drawn.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const all = context.getImageData(0, 0, drawn.width, drawn.height)
    for (let pixel = 0; pixel < within.data.length; pixel += 1) all.data[pixel * 4 + 3] = Math.round(all.data[pixel * 4 + 3]! * within.data[pixel]! / 255)
    context.putImageData(all, 0, 0)
    if (opaqueBounds(drawn) === null) {
      showAppNotice('选区里没有像素。')
      return null
    }
  }
  const area = opaqueBounds(drawn) ?? { x: 0, y: 0, width: drawn.width, height: drawn.height }
  // The picture may cover more than the canvas (options.area): placed by where it starts.
  const { outputWidth, outputHeight } = scene.canvas
  const left = Math.round(options.area?.x ?? 0)
  const top = Math.round(options.area?.y ?? 0)
  const transform = { x: (left + area.x) / outputWidth, y: (top + area.y) / outputHeight, width: area.width / outputWidth, height: area.height / outputHeight, rotation: 0 }
  // Main encodes the PNG: a page canvas's own encoder waits for the page to go idle, which a busy canvas may not do for seconds.
  const pixels = drawn.getContext('2d')?.getImageData(area.x, area.y, area.width, area.height)
  if (pixels === undefined) return null
  const asset = await window.desktop.importPixels({ projectId: scene.projectId, name: `${summary}.png`, width: area.width, height: area.height, rgba: new Uint8Array(pixels.data.buffer) })
  return useWorkspaceStore.getState().scene.projectId === scene.projectId ? { assetId: asset.id, transform } : null
}

/** A new image layer directly above the topmost selected layer (or on top), selected; more commands go in the same step. */
async function addImageLayer(assetId: string, transform: NormalizedTransform, summary: string, look: Partial<Pick<SceneElement, 'opacity' | 'blendMode' | 'name'>> = {}, also: readonly SceneCommand[] = []): Promise<string | null> {
  const current = useWorkspaceStore.getState()
  const base = createElementForTool('image', current.scene, assetId)
  if (base?.type !== 'image') return null
  const layer: SceneElement = { ...base, ...look, name: look.name ?? nextLayerName(current.scene.elements), transform, fit: 'fill', referenceRole: 'general' }
  const above = Math.max(-1, ...current.scene.elements.filter((element) => current.selectedIds.includes(element.id)).map((element) => element.zIndex))
  const commands: SceneCommand[] = [{ kind: 'element.add', element: layer }]
  if (above >= 0 && above + 1 < current.scene.elements.length) commands.push({ kind: 'element.reorder', elementId: layer.id, toIndex: above + 1 })
  commands.push(...also)
  if (!await current.execute(summary, commands)) return null
  useWorkspaceStore.getState().setSelection([layer.id])
  return layer.id
}

/**
 * Photoshop's Ctrl+Shift+N: a transparent image layer the size of the
 * canvas, directly above the topmost selected layer (or on top), selected.
 */
export async function createBlankLayer(): Promise<string | null> {
  const { scene } = useWorkspaceStore.getState()
  const asset = await window.desktop.importPixels({ projectId: scene.projectId, name: '空白图层.png', width: scene.canvas.outputWidth, height: scene.canvas.outputHeight })
  if (useWorkspaceStore.getState().scene.projectId !== scene.projectId) return null
  return addImageLayer(asset.id, FULL_CANVAS, '新建图层')
}

/** The brand logo as a new layer named Logo, a fifth of the width in the top-left corner, selected. */
export async function insertBrandLogo(): Promise<string | null> {
  const { scene } = useWorkspaceStore.getState()
  const logo = await window.desktop.importBrandLogo(scene.projectId)
  if (logo === null) {
    showAppNotice('还没有品牌 Logo：在设置的「品牌与记忆」里上传。')
    return null
  }
  const current = useWorkspaceStore.getState().scene
  if (current.projectId !== scene.projectId) return null
  return addImageLayer(logo.assetId, logoPlacement(undefined, logo, current.canvas), '插入 Logo', { name: 'Logo' })
}

type PixelLayer = Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>

/** Layers that hold pixels, text or a shape; the AI's sketches, placeholders, lights and masks are notes, not picture. */
function isPictureLayer(element: SceneElement): element is PixelLayer {
  return element.type === 'image' || element.type === 'text' || (element.type === 'shape' && element.role === 'final')
}

type AdjustmentLayer = Extract<SceneElement, { type: 'adjustment' }>
type MergeLayer = PixelLayer | AdjustmentLayer

/** Layers a merge draws: picture layers, and adjustment layers, which merge into what is below them. */
function isMergeable(element: SceneElement): element is MergeLayer {
  return isPictureLayer(element) || element.type === 'adjustment'
}

function refuse(message: string): false {
  showAppNotice(message)
  return false
}

/**
 * Draws the layers into the one that receives them, in place, and removes
 * the rest; the receiving layer keeps its name, grouping and place.
 */
async function mergeInto(target: PixelLayer, layers: readonly MergeLayer[], summary: string, options: LayerRenderOptions, keepLook: boolean): Promise<boolean> {
  const drawn = await drawnAsset(layers.map((layer) => layer.id), summary, options)
  if (drawn === null) return false
  // Drawn with its base, a clipped layer's clipping is in the result; drawn without it (the lowest was clipped), the result clips as it did.
  const lowest = layers.reduce((low, layer) => layer.zIndex < low.zIndex ? layer : low, layers[0]!)
  const clipped = lowest.clipped === true
  const commands: SceneCommand[] = [
    { kind: 'element.rasterize', elementId: target.id, assetId: drawn.assetId, transform: drawn.transform },
    // Each layer was drawn with its own opacity and blend, so the result shows them at full strength.
    ...(keepLook ? [] : [{ kind: 'element.update' as const, elementId: target.id, changes: { opacity: 1, blendMode: 'normal' } }]),
    ...((target.clipped === true) === clipped ? [] : [{ kind: 'element.update' as const, elementId: target.id, changes: { clipped } }]),
    ...layers.filter((layer) => layer.id !== target.id).map((layer) => ({ kind: 'element.remove' as const, elementId: layer.id }))
  ]
  const store = useWorkspaceStore.getState()
  if (!await store.execute(summary, commands)) return false
  useWorkspaceStore.getState().setSelection([target.id])
  return true
}

function lockedAmong(layers: readonly SceneElement[]): SceneElement | undefined {
  return layers.find((layer) => layer.locked)
}

/**
 * Photoshop's Ctrl+E. One layer merges into the layer below it, which keeps
 * its name, opacity and blend; several selected layers merge into the
 * topmost of them; a selected group becomes one layer.
 */
export async function mergeDown(): Promise<boolean> {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const selected = scene.elements.filter((element) => selectedIds.includes(element.id))
  if (selected.length === 0) return refuse('先选中要合并的图层。')

  if (selected.length === 1 && selected[0]!.type === 'group') {
    const group = selected[0]!
    const children = scene.elements.filter((element) => element.groupId === group.id)
    const layers = children.filter(isMergeable)
    const locked = lockedAmong(children)
    if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁后才能合并。`)
    if (!layers.some(isPictureLayer)) return refuse(`「${group.name}」里没有可合并的图层。`)
    if (children.some((child) => !isMergeable(child))) return refuse(`「${group.name}」里有 AI 标注，先把它移出组再合并。`)
    const drawn = await drawnAsset(layers.filter((layer) => layer.visible).map((layer) => layer.id), '合并组')
    if (drawn === null) return false
    const current = useWorkspaceStore.getState()
    const base = createElementForTool('image', current.scene, drawn.assetId)
    if (base?.type !== 'image') return false
    const index = current.scene.elements.findIndex((element) => element.id === group.id)
    const merged: SceneElement = { ...base, name: group.name, transform: drawn.transform, fit: 'fill', referenceRole: 'general' }
    if (!await current.execute('合并组', [
      { kind: 'element.add', element: merged },
      { kind: 'element.reorder', elementId: merged.id, toIndex: Math.max(0, index) },
      { kind: 'element.remove', elementId: group.id }
    ])) return false
    useWorkspaceStore.getState().setSelection([merged.id])
    return true
  }

  if (selected.length > 1) {
    // A selected group brings its layers; the stack order decides which is on top.
    const ids = new Set(selected.flatMap((element) => element.type === 'group' ? element.childIds : [element.id]))
    const layers = scene.elements.filter((element) => ids.has(element.id))
    const notPicture = layers.find((layer) => !isMergeable(layer))
    if (notPicture !== undefined) return refuse(`「${notPicture.name}」是 AI 标注，不能合并。`)
    const locked = lockedAmong(layers)
    if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁后才能合并。`)
    const hidden = layers.find((layer) => !layer.visible)
    if (hidden !== undefined) return refuse(`「${hidden.name}」是隐藏的，显示它或取消选中后再合并。`)
    const pictures = layers.filter(isPictureLayer)
    // Adjustment layers among them change the layers below them and are merged in.
    if (pictures.length === 0) return refuse('调整图层没有像素，至少选中一个图片、文字或形状图层一起合并。')
    return mergeInto(pictures.at(-1)!, layers.filter(isMergeable), '合并图层', {}, false)
  }

  const upper = selected[0]!
  if (!isMergeable(upper)) return refuse(`「${upper.name}」是 AI 标注，不能合并。`)
  // Photoshop's 合并剪贴蒙版: on the base of a clipping mask, Ctrl+E merges the layers clipped to it into it.
  const stack = clipStacks(scene.elements).get(upper.id)
  if (stack !== undefined && isPictureLayer(upper)) {
    const members = stack.memberIds.flatMap((id) => scene.elements.find((element) => element.id === id) ?? []).filter((element) => element.visible && isMergeable(element))
    const locked = lockedAmong([upper, ...members])
    if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁后才能合并剪贴蒙版。`)
    if (!upper.visible) return refuse(`「${upper.name}」是隐藏的，显示它后再合并剪贴蒙版。`)
    if (members.length > 0) return mergeInto(upper, [upper, ...members.filter(isMergeable)], '合并剪贴蒙版', { base: upper.id }, true)
  }
  const index = scene.elements.findIndex((element) => element.id === upper.id)
  const lower = scene.elements.slice(0, index).reverse().find((element) => element.groupId === upper.groupId)
  if (lower === undefined) return refuse(`「${upper.name}」下面没有可以合并进去的图层。`)
  if (lower.type === 'group') return refuse(`「${upper.name}」下面是组「${lower.name}」，不能向下合并。`)
  if (lower.type === 'adjustment') return refuse(`下面的「${lower.name}」是调整图层，没有像素，不能合并进去。`)
  if (!isPictureLayer(lower)) return refuse(`下面的「${lower.name}」是 AI 标注，不能合并。`)
  const locked = lockedAmong([upper, lower])
  if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁后才能合并。`)
  if (!upper.visible || !lower.visible) return refuse('隐藏的图层不能向下合并，先把两层都显示出来。')
  return mergeInto(lower, [lower, upper], '向下合并', { base: lower.id }, true)
}

/** Every visible layer a merge draws, adjustment layers included. */
function visibleMergeLayers(): MergeLayer[] {
  const { elements } = useWorkspaceStore.getState().scene
  // A layer clipped to a hidden base is hidden with it.
  const bases = clipBases(elements)
  const shown = (element: SceneElement): boolean => {
    const baseId = bases.get(element.id)
    return element.visible && (baseId === undefined || elements.find((candidate) => candidate.id === baseId)?.visible === true)
  }
  return elements.filter((element): element is MergeLayer => isMergeable(element) && shown(element))
}

/** Photoshop's Ctrl+Shift+E: every visible layer into the lowest of them; hidden layers and AI notes stay. */
export async function mergeVisible(): Promise<boolean> {
  const layers = visibleMergeLayers()
  const pictures = layers.filter(isPictureLayer)
  if (layers.length < 2 || pictures.length === 0) return refuse('至少要有两个可见图层才能合并。')
  const locked = lockedAmong(layers)
  if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁或隐藏它后再合并可见图层。`)
  // The adjustment layers go into the result; what they did to the canvas colour goes with them, as
  // Photoshop's merge into the background layer keeps it.
  const canvasBackground = layers.some((layer) => layer.type === 'adjustment') && !useWorkspaceStore.getState().scene.canvas.transparent
  return mergeInto(pictures[0]!, layers, '合并可见图层', canvasBackground ? { canvasBackground } : {}, false)
}

/** Photoshop's Ctrl+Alt+Shift+E: every visible layer drawn into a new layer, the originals untouched. */
export async function stampVisible(): Promise<boolean> {
  const layers = visibleMergeLayers()
  if (!layers.some(isPictureLayer)) return refuse('没有可见图层可以盖印。')
  const drawn = await drawnAsset(layers.map((layer) => layer.id), '盖印可见图层')
  return drawn !== null && await addImageLayer(drawn.assetId, drawn.transform, '盖印可见图层') !== null
}

/**
 * Photoshop's Ctrl+Alt+G, 创建剪贴蒙版 and 释放剪贴蒙版: the selected layers
 * are clipped to the nearest unclipped layer below them (with several
 * selected, to the lowest of them), or, when they all are clipped already,
 * released, together with the layers clipped above them, as Photoshop does.
 */
export async function toggleClippingMask(ids?: readonly string[]): Promise<boolean> {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const chosen = new Set(ids ?? selectedIds)
  const targets = scene.elements.filter((element) => chosen.has(element.id) && canBeClipped(element)).sort((left, right) => left.zIndex - right.zIndex)
  if (targets.length === 0) return refuse('选一个图片、文字、形状或调整图层，再创建剪贴蒙版。')
  const locked = targets.find((element) => element.locked)
  if (locked !== undefined) return refuse(`「${locked.name}」已锁定，解锁后才能创建或释放剪贴蒙版。`)

  if (targets.every((element) => element.clipped === true)) {
    const stacks = [...clipStacks(scene.elements).values()]
    const released = new Set(targets.map((element) => element.id))
    for (const target of targets) {
      const stack = stacks.find((candidate) => candidate.memberIds.includes(target.id))
      for (const id of stack?.memberIds.slice(stack.memberIds.indexOf(target.id)) ?? []) released.add(id)
    }
    return useWorkspaceStore.getState().execute('释放剪贴蒙版', [...released].map((id) => ({ kind: 'element.update' as const, elementId: id, changes: { clipped: false } })))
  }

  // With several selected, the lowest is what the rest clip to, if it can be.
  const lowest = targets[0]!
  const clipping = targets.length > 1 && canBeClipBase(lowest) && lowest.clipped !== true ? targets.slice(1) : targets
  const after = scene.elements.map((element) => clipping.some((target) => target.id === element.id) ? { ...element, clipped: true } as SceneElement : element)
  const bases = clipBases(after)
  const orphan = clipping.find((element) => !bases.has(element.id))
  if (orphan !== undefined) return refuse(`「${orphan.name}」下面没有可以剪贴到的图层：要紧挨在同一组里的图片、文字或成品形状上面。`)
  const commands = clipping.filter((element) => element.clipped !== true).map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes: { clipped: true } }))
  if (commands.length === 0) return false
  return useWorkspaceStore.getState().execute('创建剪贴蒙版', commands)
}

/**
 * What rasterizing a layer draws, in canvas pixels: the canvas, and the
 * layer's own area past it (through its turn and corners, with its stroke,
 * shadow and styles), as a PSD keeps it. The canvas alone when that would be
 * too large to draw.
 */
function rasterArea(element: Extract<SceneElement, { type: 'image' | 'text' | 'shape' }>): { x: number; y: number; width: number; height: number } {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  const own = layerArea(element, outputWidth, outputHeight)
  const reach = layerStyleReach(element.style)
  const left = Math.min(0, Math.floor(own.x - reach))
  const top = Math.min(0, Math.floor(own.y - reach))
  const right = Math.max(outputWidth, Math.ceil(own.x + own.width + reach))
  const bottom = Math.max(outputHeight, Math.ceil(own.y + own.height + reach))
  if (right - left > MAX_EXPORT_EDGE || bottom - top > MAX_EXPORT_EDGE) return { x: 0, y: 0, width: outputWidth, height: outputHeight }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Photoshop's 栅格化图层: a text or shape layer becomes pixels as it looks, keeping its opacity and blend. */
export async function rasterizeLayer(elementId: string): Promise<boolean> {
  const element = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === elementId)
  // An image is pixels already, unless a skew, distort or perspective still has to be worked into them.
  if (element === undefined || (element.type !== 'text' && element.type !== 'shape' && !(element.type === 'image' && needsRasterizeToPaint(element)))) return false
  if (element.locked) return refuse(`「${element.name}」已锁定，解锁后才能栅格化。`)
  // A composition placeholder is not drawn into the picture, so it would come out empty.
  if (element.type === 'shape' && element.role !== 'final') return refuse(`「${element.name}」是构图占位，不在成品里，不能栅格化；先在属性里把用途改成成品。`)
  // Drawn over the canvas and wherever the layer reaches past it, so what lies off the canvas is kept.
  const drawn = await drawnAsset([element.id], '栅格化图层', { base: element.id, showHidden: true, area: rasterArea(element) })
  if (drawn === null) return false
  return useWorkspaceStore.getState().execute('栅格化图层', [{ kind: 'element.rasterize', elementId: element.id, assetId: drawn.assetId, transform: drawn.transform }])
}

/**
 * Photoshop's Ctrl+J and Ctrl+Shift+J with a selection: what the selection
 * covers on the selected layer, as drawn, becomes a new layer above it,
 * keeping its opacity and blend. Cutting also clears those pixels from the
 * layer, in the same step.
 */
export async function layerViaSelection(cut: boolean): Promise<boolean> {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  const selection = currentSelection()
  if (selection === null) return false
  const element = selectedIds.length === 1 ? scene.elements.find((candidate) => candidate.id === selectedIds[0]) : undefined
  if (element === undefined || !isPictureLayer(element)) return refuse('先选中一个图片、文字或形状图层。')
  if (cut && element.type !== 'image') return refuse(`「${element.name}」要先栅格化（图层右键菜单），才能剪切出选区里的像素。`)
  if (cut && element.locked) return refuse(`「${element.name}」已锁定，解锁后才能剪切。`)
  const summary = cut ? '通过剪切的图层' : '通过拷贝的图层'
  // What is cleared comes from the same selection as what is copied, taken now, before anything waits.
  let cutClip: SelectionClip | null = null
  if (cut && element.type === 'image') {
    const image = layerSourceImage(element.id)
    if (image === null) return refuse(`「${element.name}」还没画好，稍后再试。`)
    const space = imageLayerSpace(element, { width: image.naturalWidth, height: image.naturalHeight }, { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight })
    cutClip = selectionClip(element, space, 'layer')
  }
  const drawn = await drawnAsset([element.id], summary, { base: element.id, showHidden: true }, selection)
  if (drawn === null) return false
  const also: SceneCommand[] = []
  if (cutClip !== null && cutClip.kind !== 'outside') {
    const clipId = cutClip.kind === 'clip' ? await cutClip.assetId : null
    if (cutClip.kind === 'clip' && clipId === null) return refuse('选区没有存好，没有剪切。')
    const clear: PaintOp = clipId === null ? { id: globalThis.crypto.randomUUID(), kind: 'clear' } : { id: globalThis.crypto.randomUUID(), kind: 'clear', clip: clipId }
    const current = useWorkspaceStore.getState().scene.elements.find((candidate) => candidate.id === element.id)
    also.push({ kind: 'element.update', elementId: element.id, changes: { paint: [...(current?.type === 'image' ? current.paint ?? [] : []), clear] } })
  }
  return await addImageLayer(drawn.assetId, drawn.transform, summary, { opacity: element.opacity, blendMode: element.blendMode ?? 'normal' }, also) !== null
}
