import type { SceneCommand } from '../commands/schema'
import {
  applyMatrix,
  boxAroundLayers,
  cornersAreDrawable,
  homographyFromCorners,
  invertMatrix,
  layerCornerPoints,
  multiplyMatrices,
  placeFromCornerPoints,
  type Corners,
  type Matrix3,
  type Point
} from './free-transform'
import type { Scene, SceneElement } from './schema'

/*
 * Photoshop's free transform and 编辑 > 变换 over a set of layers: the
 * layers' corners on the canvas go through one map (a homography from the
 * transform box's corners before to after), and each layer is placed again
 * from where its corners land. Groups take their layers along and their
 * boxes are worked out again.
 */

/** Four points on the canvas, in the order of a box's top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point]

/**
 * What a set of layers can take: any shape (images and shapes), a
 * parallelogram (text, as Photoshop transforms type), or only boxes the
 * right way round (sketches, placeholders, lights, which have no corners).
 */
export type TransformReach = 'full' | 'affine' | 'box'

const REACH_ORDER: readonly TransformReach[] = ['box', 'affine', 'full']

function reachOf(element: SceneElement): TransformReach {
  if (element.type === 'image' || element.type === 'shape') return 'full'
  if (element.type === 'text') return 'affine'
  return 'box'
}

/** A text's type scaled by a factor, or null when that takes a size past what text can have. */
function textScaled(text: Extract<SceneElement, { type: 'text' }>, factor: number): Record<string, number> | null {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  const fontSize = round(text.fontSize * factor)
  const letterSpacing = round(text.letterSpacing * factor)
  const strokeWidth = round(text.strokeWidth * factor)
  const shadowBlur = round(text.shadowBlur * factor)
  if (fontSize < 8 || fontSize > 512 || Math.abs(letterSpacing) > 100 || strokeWidth > 32 || shadowBlur > 128) return null
  return { fontSize, letterSpacing, strokeWidth, shadowBlur }
}

function canvasSize(scene: Scene): { readonly width: number; readonly height: number } {
  return { width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
}

/** The layers a transform of these selected ones moves: groups opened up, adjustment layers and edit masks left out. */
export function transformableLayers(scene: Scene, ids: readonly string[]): readonly SceneElement[] {
  const byId = new Map(scene.elements.map((element) => [element.id, element]))
  const out = new Map<string, SceneElement>()
  const visit = (id: string): void => {
    const element = byId.get(id)
    if (element === undefined || element.locked) return
    if (element.type === 'group') {
      element.childIds.forEach(visit)
      return
    }
    if (element.type === 'adjustment' || element.type === 'mask') return
    out.set(element.id, element)
  }
  ids.forEach(visit)
  return [...out.values()]
}

export function transformReach(layers: readonly SceneElement[]): TransformReach {
  return layers.reduce<TransformReach>((reach, layer) => {
    const own = reachOf(layer)
    return REACH_ORDER.indexOf(own) < REACH_ORDER.indexOf(reach) ? own : reach
  }, 'full')
}

/**
 * The transform box: one layer's own corners, or the box around several,
 * square to the canvas.
 */
export function transformQuad(scene: Scene, layers: readonly SceneElement[]): Quad | null {
  if (layers.length === 0) return null
  const canvas = canvasSize(scene)
  if (layers.length === 1) {
    const layer = layers[0]!
    return layerCornerPoints(layer.transform, 'corners' in layer ? layer.corners : null, canvas)
  }
  const points = layers.flatMap((layer) => layerCornerPoints(layer.transform, 'corners' in layer ? layer.corners : null, canvas))
  const left = Math.min(...points.map((point) => point[0]))
  const top = Math.min(...points.map((point) => point[1]))
  const right = Math.max(...points.map((point) => point[0]))
  const bottom = Math.max(...points.map((point) => point[1]))
  return [[left, top], [right, top], [right, bottom], [left, bottom]]
}

/** The homography taking one quad's corners to another's. */
export function quadToQuad(from: Quad, to: Quad): Matrix3 {
  return multiplyMatrices(homographyFromCorners(to as unknown as Corners), invertMatrix(homographyFromCorners(from as unknown as Corners)))
}

/** Whether a quad can be a transform's result: not folded over itself, not squashed flat. */
export function quadIsDrawable(quad: Quad): boolean {
  return cornersAreDrawable(quad as unknown as Corners)
}

export type TransformOutcome =
  | { readonly ok: true; readonly commands: readonly SceneCommand[]; readonly changes: ReadonlyMap<string, Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string }

/**
 * Every layer moved through a map of canvas points: each placed again from
 * where its corners land (see placeFromCornerPoints), and the groups they
 * are in fitted around them again.
 */
export function transformLayers(scene: Scene, layers: readonly SceneElement[], map: (point: Point) => Point): TransformOutcome {
  const canvas = canvasSize(scene)
  const changes = new Map<string, Record<string, unknown>>()
  for (const layer of layers) {
    const before = layerCornerPoints(layer.transform, 'corners' in layer ? layer.corners : null, canvas)
    const after = before.map(map) as unknown as Quad
    const reach = reachOf(layer)
    let placed = placeFromCornerPoints(after, layer.transform, canvas, reach !== 'full')
    if (placed === null) return { ok: false, reason: `「${layer.name}」是文字，只能翻转和斜切；扭曲、透视要先栅格化。` }
    const change: Record<string, unknown> = {}
    // Text scaled keeps its lines: the type grows with the box, as Photoshop scales it, or, scaled unevenly,
    // stays laid out in its box and is stretched through its corners.
    if (layer.type === 'text') {
      const sx = placed.transform.width / layer.transform.width
      const sy = placed.transform.height / layer.transform.height
      if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) {
        const scaled = Math.abs(sx - sy) <= 1e-3 * Math.max(sx, sy) ? textScaled(layer, (sx + sy) / 2) : null
        if (scaled === null) placed = placeFromCornerPoints(after, layer.transform, canvas, true, true)!
        else Object.assign(change, scaled)
      }
    } else if (layer.type === 'image' && layer.fit !== 'fill') {
      // A picture fitted into its box (contain, cover) would be fitted again to a box of another shape, not
      // stretched: it keeps its box, and what was done to it goes into its corners.
      const shape = (box: SceneElement['transform']): number => (box.width * canvas.width) / Math.max(1e-9, box.height * canvas.height)
      if (Math.abs(shape(placed.transform) / shape(layer.transform) - 1) > 1e-6) placed = placeFromCornerPoints(after, layer.transform, canvas, false, true) ?? placed
    }
    if (reach === 'box' && placed.corners !== null) return { ok: false, reason: `「${layer.name}」只能移动、缩放和旋转，不能翻转或变形。` }
    if (placed.corners !== null && !cornersAreDrawable(placed.corners)) return { ok: false, reason: `「${layer.name}」会被翻折或压扁，换个形状再试。` }
    change.transform = placed.transform
    if (reach !== 'box') change.corners = placed.corners
    changes.set(layer.id, change)
  }
  const commands: SceneCommand[] = [...changes].map(([elementId, change]) => ({ kind: 'element.update', elementId, changes: change }))
  commands.push(...refitGroupsAround(scene, layers.map((layer) => layer.id), changes))
  return { ok: true, commands, changes }
}

/**
 * The groups holding these layers fitted again around what their layers now
 * cover, innermost first: `changed` holds each changed layer's new box and,
 * when they changed, its new corners.
 */
export function refitGroupsAround(scene: Scene, layerIds: readonly string[], changed: ReadonlyMap<string, Readonly<Record<string, unknown>>>): SceneCommand[] {
  const canvas = canvasSize(scene)
  const byId = new Map(scene.elements.map((element) => [element.id, element]))
  const groups = new Set<string>()
  for (const id of layerIds) {
    let parent = byId.get(id)?.groupId ?? null
    while (parent !== null) {
      groups.add(parent)
      parent = byId.get(parent)?.groupId ?? null
    }
  }
  const depth = (id: string): number => {
    let count = 0
    let parent = byId.get(id)?.groupId ?? null
    while (parent !== null) { count += 1; parent = byId.get(parent)?.groupId ?? null }
    return count
  }
  const fitted = new Map<string, SceneElement['transform']>()
  const commands: SceneCommand[] = []
  for (const groupId of [...groups].sort((a, b) => depth(b) - depth(a))) {
    const group = byId.get(groupId)
    if (group?.type !== 'group') continue
    const children = group.childIds.map((id) => byId.get(id)).filter((child): child is SceneElement => child !== undefined && child.type !== 'adjustment')
    if (children.length === 0) continue
    // Around what each layer now covers, its new corners included, so a part reshaped past its box is in the group's.
    const transform = boxAroundLayers(children.map((child) => {
      const change = changed.get(child.id)
      const corners = change !== undefined && 'corners' in change ? change.corners as Corners | null : 'corners' in child ? child.corners : null
      return { transform: fitted.get(child.id) ?? (change?.transform as SceneElement['transform'] | undefined) ?? child.transform, corners }
    }), canvas)
    fitted.set(groupId, transform)
    commands.push({ kind: 'element.update', elementId: groupId, changes: { transform } })
  }
  return commands
}

/** Layers moved through the homography from one quad to another. */
export function transformLayersByQuads(scene: Scene, layers: readonly SceneElement[], from: Quad, to: Quad): TransformOutcome {
  const matrix = quadToQuad(from, to)
  return transformLayers(scene, layers, ([x, y]) => applyMatrix(matrix, x, y))
}

// What the transform box's handles do, in canvas pixels.

export type HandleIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
/** Where each handle is in the box's own units: the four corners, then the middles of the top, right, bottom and left edges. */
export const HANDLE_UNITS: readonly Point[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]

export function quadPoint(quad: Quad, u: number, v: number): Point {
  return applyMatrix(homographyFromCorners(quad as unknown as Corners), u, v)
}

export function quadCentre(quad: Quad): Point {
  return quadPoint(quad, 0.5, 0.5)
}

function add(a: Point, b: Point, scale = 1): Point {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale]
}

export function moveQuad(quad: Quad, delta: Point): Quad {
  return quad.map((point) => add(point, delta)) as unknown as Quad
}

export function rotateQuad(quad: Quad, centre: Point, degrees: number): Quad {
  const angle = degrees * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return quad.map(([x, y]) => {
    const dx = x - centre[0]
    const dy = y - centre[1]
    return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos] as Point
  }) as unknown as Quad
}

/** Mirrored across the canvas's vertical (horizontal flip) or horizontal axis through a point. */
export function flipQuad(quad: Quad, centre: Point, axis: 'horizontal' | 'vertical'): Quad {
  return quad.map(([x, y]) => (axis === 'horizontal' ? [2 * centre[0] - x, y] : [x, 2 * centre[1] - y]) as Point) as unknown as Quad
}

/**
 * Scaled by dragging a handle to a point, in the box's own frame: the
 * opposite handle (or the centre, with Alt) stays put. A corner keeps the
 * proportions unless Shift is held, as in Photoshop since 2019; a side
 * scales one way.
 */
export function scaleQuad(start: Quad, handle: HandleIndex, pointer: Point, options: { readonly free: boolean; readonly fromCentre: boolean }): Quad {
  const forward = homographyFromCorners(start as unknown as Corners)
  const [u, v] = applyMatrix(invertMatrix(forward), pointer[0], pointer[1])
  const [hu, hv] = HANDLE_UNITS[handle]!
  const anchor: Point = options.fromCentre ? [0.5, 0.5] : [1 - hu, 1 - hv]
  let sx = hu === 0.5 ? 1 : (u - anchor[0]) / (hu - anchor[0])
  let sy = hv === 0.5 ? 1 : (v - anchor[1]) / (hv - anchor[1])
  if (handle < 4 && !options.free) {
    const s = (sx + sy) / 2
    sx = s
    sy = s
  }
  return HANDLE_UNITS.slice(0, 4).map(([cu, cv]) => applyMatrix(forward, anchor[0] + (cu - anchor[0]) * sx, anchor[1] + (cv - anchor[1]) * sy)) as unknown as Quad
}

/** The two corners of each side handle: top, right, bottom, left. */
const SIDES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0]]

/**
 * A side handle dragged with Ctrl, or in skew mode: the side's corners move
 * along the side (a skew), or anywhere (freely, Ctrl in scale mode); with
 * Alt the opposite side moves the other way.
 */
export function skewQuad(start: Quad, handle: HandleIndex, delta: Point, options: { readonly along: boolean; readonly symmetric: boolean }): Quad {
  if (handle < 4) return start
  const [a, b] = SIDES[handle - 4]!
  const [c, d] = SIDES[(handle - 4 + 2) % 4]!
  const edge: Point = [start[b]![0] - start[a]![0], start[b]![1] - start[a]![1]]
  const length = edge[0] * edge[0] + edge[1] * edge[1]
  const move: Point = options.along && length > 0
    ? [edge[0] * (delta[0] * edge[0] + delta[1] * edge[1]) / length, edge[1] * (delta[0] * edge[0] + delta[1] * edge[1]) / length]
    : delta
  const out = [...start] as Point[]
  out[a] = add(start[a]!, move)
  out[b] = add(start[b]!, move)
  if (options.symmetric) {
    out[c] = add(start[c]!, move, -1)
    out[d] = add(start[d]!, move, -1)
  }
  return out as unknown as Quad
}

/** A corner dragged with Ctrl, or in distort mode: it alone moves. */
export function distortQuad(start: Quad, handle: HandleIndex, delta: Point): Quad {
  if (handle >= 4) return start
  const corner = handle as 0 | 1 | 2 | 3
  const out = [...start] as Point[]
  out[corner] = add(start[corner], delta)
  return out as unknown as Quad
}

/**
 * A corner dragged with Ctrl+Alt+Shift, or in perspective mode: it moves
 * along whichever of its sides the drag follows more, and the other corner
 * of that side moves the opposite way, so the box narrows or widens there.
 */
export function perspectiveQuad(start: Quad, handle: HandleIndex, delta: Point): Quad {
  if (handle >= 4) return start
  const corner = handle as 0 | 1 | 2 | 3
  const across = corner === 0 ? 1 : corner === 1 ? 0 : corner === 2 ? 3 : 2
  const down = corner === 0 ? 3 : corner === 3 ? 0 : corner === 1 ? 2 : 1
  const unit = (to: 0 | 1 | 2 | 3): Point => {
    const dx = start[to][0] - start[corner][0]
    const dy = start[to][1] - start[corner][1]
    const length = Math.hypot(dx, dy) || 1
    return [dx / length, dy / length]
  }
  const h = unit(across)
  const v = unit(down)
  const alongH = delta[0] * h[0] + delta[1] * h[1]
  const alongV = delta[0] * v[0] + delta[1] * v[1]
  const [direction, partner, amount] = Math.abs(alongH) >= Math.abs(alongV) ? [h, across, alongH] as const : [v, down, alongV] as const
  const out = [...start] as Point[]
  out[corner] = add(start[corner], direction, amount)
  out[partner] = add(start[partner], direction, -amount)
  return out as unknown as Quad
}
