import { create } from 'zustand'
import {
  flipQuad,
  layerCanvasBounds,
  quadCentre,
  quadIsDrawable,
  rotateQuad,
  transformableLayers,
  transformLayers,
  transformLayersByQuads,
  transformQuad,
  transformReach,
  type Point,
  type Quad,
  type TransformReach
} from '../../../domain'
import { showAppNotice } from '../components/app-notice'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's free transform (Ctrl+T): a box around the selected layers
 * whose handles reshape them, shown at once but recorded only on Enter or
 * ✓, in one step; Esc or ✗ puts everything back. The layers are drawn from
 * the preview meanwhile, so the canvas shows exactly what applying does.
 */

export type FreeTransformMode = 'scale' | 'skew' | 'distort' | 'perspective'

export interface FreeTransformSession {
  /** The layers it moves (groups opened up), and the scene they were taken from. */
  readonly ids: readonly string[]
  readonly revision: number
  readonly reach: TransformReach
  /** The box when the transform began, and where its corners are now, in canvas pixels. */
  readonly source: Quad
  readonly target: Quad
  readonly mode: FreeTransformMode
  /** Each layer's changes as previewed. */
  readonly preview: ReadonlyMap<string, Record<string, unknown>>
}

interface FreeTransformState {
  readonly session: FreeTransformSession | null
  start(): boolean
  /** Moves the box's corners; refused (false) when the layers cannot take that shape. */
  setTarget(target: Quad): boolean
  setMode(mode: FreeTransformMode): void
  flip(axis: 'horizontal' | 'vertical'): void
  rotate(degrees: number): void
  apply(): Promise<boolean>
  cancel(): void
}

function previewFor(ids: readonly string[], source: Quad, target: Quad): ReadonlyMap<string, Record<string, unknown>> | string {
  const { scene } = useWorkspaceStore.getState()
  const layers = scene.elements.filter((element) => ids.includes(element.id))
  const outcome = transformLayersByQuads(scene, layers, source, target)
  return outcome.ok ? outcome.changes : outcome.reason
}

export const useFreeTransform = create<FreeTransformState>((set, get) => ({
  session: null,
  start: () => {
    const { scene, selectedIds } = useWorkspaceStore.getState()
    const layers = transformableLayers(scene, selectedIds)
    if (layers.length === 0) {
      showAppNotice(selectedIds.length === 0 ? '先选中要变换的图层。' : '选中的图层已锁定，或者不能变换（调整图层、修改区）。')
      return false
    }
    const source = transformQuad(scene, layers)
    if (source === null || !quadIsDrawable(source)) {
      showAppNotice('选中的图层太小，没法变换。')
      return false
    }
    set({ session: { ids: layers.map((layer) => layer.id), revision: scene.revision, reach: transformReach(layers), source, target: source, mode: 'scale', preview: new Map() } })
    return true
  },
  setTarget: (target) => {
    const session = get().session
    if (session === null || !quadIsDrawable(target)) return false
    const preview = previewFor(session.ids, session.source, target)
    if (typeof preview === 'string') return false
    set({ session: { ...session, target, preview } })
    return true
  },
  setMode: (mode) => {
    const session = get().session
    if (session === null) return
    if ((mode === 'distort' || mode === 'perspective') && session.reach !== 'full') {
      showAppNotice(session.reach === 'affine' ? '文字只能翻转和斜切；扭曲、透视要先栅格化（图层右键菜单）。' : '草图、主体、光影只能移动、缩放和旋转。')
      return
    }
    if (mode === 'skew' && session.reach === 'box') {
      showAppNotice('草图、主体、光影只能移动、缩放和旋转。')
      return
    }
    set({ session: { ...session, mode } })
  },
  flip: (axis) => {
    const session = get().session
    if (session === null) return
    if (session.reach === 'box') {
      showAppNotice('草图、主体、光影不能翻转。')
      return
    }
    get().setTarget(flipQuad(session.target, quadCentre(session.target), axis))
  },
  rotate: (degrees) => {
    const session = get().session
    if (session === null) return
    get().setTarget(rotateQuad(session.target, quadCentre(session.target), degrees))
  },
  apply: async () => {
    const session = get().session
    if (session === null) return false
    set({ session: null })
    const { scene, execute } = useWorkspaceStore.getState()
    if (scene.revision !== session.revision) {
      showAppNotice('画布在变换时改动过，这次变换没有应用。')
      return false
    }
    if (session.preview.size === 0) return true
    const layers = scene.elements.filter((element) => session.ids.includes(element.id))
    const outcome = transformLayersByQuads(scene, layers, session.source, session.target)
    if (!outcome.ok) {
      showAppNotice(outcome.reason, 'problem')
      return false
    }
    return execute(layers.length === 1 ? `自由变换“${layers[0]!.name}”` : `自由变换 ${layers.length} 个图层`, outcome.commands)
  },
  cancel: () => set({ session: null })
}))

/** The layers as the free transform shows them, or as they are. */
export function withFreeTransformPreview<T extends { readonly id: string }>(element: T, session: FreeTransformSession | null): T {
  const changes = session?.preview.get(element.id)
  return changes === undefined ? element : { ...element, ...changes } as T
}

/**
 * Photoshop's 编辑 > 变换 > 水平翻转 / 垂直翻转 / 旋转: the selected layers
 * flipped or turned as a whole, about the middle of the box around them, in
 * one step.
 */
export async function transformSelection(action: 'flip-horizontal' | 'flip-vertical' | 'rotate-180' | 'rotate-cw' | 'rotate-ccw'): Promise<boolean> {
  const { scene, selectedIds, execute } = useWorkspaceStore.getState()
  const layers = transformableLayers(scene, selectedIds)
  if (layers.length === 0) {
    showAppNotice(selectedIds.length === 0 ? '先选中要变换的图层。' : '选中的图层已锁定，或者不能变换。')
    return false
  }
  // About the middle of the box around them, square to the canvas, as Photoshop flips.
  const canvas = { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
  const bounds = layers.map((layer) => layerCanvasBounds(layer.transform, 'corners' in layer ? layer.corners : null, canvas))
  const left = Math.min(...bounds.map((box) => box.x))
  const top = Math.min(...bounds.map((box) => box.y))
  const right = Math.max(...bounds.map((box) => box.x + box.width))
  const bottom = Math.max(...bounds.map((box) => box.y + box.height))
  const centre: Point = [(left + right) / 2, (top + bottom) / 2]
  const turn = (degrees: number) => (point: Point): Point => {
    const angle = degrees * Math.PI / 180
    const dx = point[0] - centre[0]
    const dy = point[1] - centre[1]
    return [centre[0] + dx * Math.cos(angle) - dy * Math.sin(angle), centre[1] + dx * Math.sin(angle) + dy * Math.cos(angle)]
  }
  const map = action === 'flip-horizontal' ? (point: Point): Point => [2 * centre[0] - point[0], point[1]]
    : action === 'flip-vertical' ? (point: Point): Point => [point[0], 2 * centre[1] - point[1]]
      : turn(action === 'rotate-180' ? 180 : action === 'rotate-cw' ? 90 : -90)
  const outcome = transformLayers(scene, layers, map)
  if (!outcome.ok) {
    showAppNotice(outcome.reason, 'problem')
    return false
  }
  const label = { 'flip-horizontal': '水平翻转', 'flip-vertical': '垂直翻转', 'rotate-180': '旋转 180°', 'rotate-cw': '顺时针旋转 90°', 'rotate-ccw': '逆时针旋转 90°' }[action]
  return execute(layers.length === 1 ? `${label}“${layers[0]!.name}”` : `${label} ${layers.length} 个图层`, outcome.commands)
}

// A tool picked or another project opened ends the transform: a new tool applies it, as Photoshop does; a project change drops it.
useWorkspaceStore.subscribe((state, previous) => {
  const transform = useFreeTransform.getState()
  if (transform.session === null) return
  if (state.scene.projectId !== previous.scene.projectId) transform.cancel()
  else if (state.activeTool !== previous.activeTool) void transform.apply()
})
