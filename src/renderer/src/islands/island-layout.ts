export type GlassIslandId = 'tools' | 'inspector' | 'composer'
export type GlassIslandMode = 'floating' | 'docked-left' | 'docked-right' | 'docked-top' | 'docked-bottom' | 'orb'

export interface IslandBounds {
  readonly width: number
  readonly height: number
}

export interface IslandRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GlassIslandLayout extends IslandRect {
  readonly mode: GlassIslandMode
  readonly previous: (IslandRect & { readonly mode: Exclude<GlassIslandMode, 'orb'> }) | null
}

const EDGE_GAP = 18
const ORB_SIZE = 58
const GLASS_ISLAND_MODES = new Set<GlassIslandMode>([
  'floating',
  'docked-left',
  'docked-right',
  'docked-top',
  'docked-bottom',
  'orb'
])

export const ISLAND_MINIMUMS: Record<GlassIslandId, { readonly width: number; readonly height: number }> = {
  tools: { width: 58, height: 138 },
  inspector: { width: 238, height: 220 },
  composer: { width: 340, height: 180 }
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIslandMode(value: unknown): value is GlassIslandMode {
  return typeof value === 'string' && GLASS_ISLAND_MODES.has(value as GlassIslandMode)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function storedPrevious(value: unknown): GlassIslandLayout['previous'] {
  if (!isRecord(value) || !isIslandMode(value.mode) || value.mode === 'orb') return null
  if (![value.x, value.y, value.width, value.height].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null
  return {
    mode: value.mode,
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number
  }
}

export function createDefaultIslandLayout(id: GlassIslandId, bounds: IslandBounds): GlassIslandLayout {
  const safeWidth = Math.max(640, bounds.width)
  const safeHeight = Math.max(240, bounds.height)
  if (id === 'tools') {
    const height = Math.min(474, safeHeight - EDGE_GAP * 2)
    return { mode: 'floating', x: EDGE_GAP, y: Math.round((safeHeight - height) / 2), width: 58, height, previous: null }
  }
  if (id === 'inspector') {
    const width = safeWidth <= 1160 ? 260 : Math.min(330, safeWidth - 160)
    const height = Math.min(safeWidth <= 1160 ? 520 : 650, safeHeight - 162)
    const layout: GlassIslandLayout = { mode: 'docked-right', x: safeWidth - width - EDGE_GAP, y: 36, width, height, previous: null }
    return bounds.width < 900 ? collapseIsland(layout, 'inspector', bounds) : layout
  }
  const inspectorWidth = safeWidth <= 1160 ? 260 : Math.min(330, safeWidth - 160)
  const inspectorLeft = safeWidth - inspectorWidth - EDGE_GAP
  const width = Math.min(safeWidth <= 1160 ? 600 : 720, safeWidth - 300)
  const height = 216
  const centeredX = Math.round((safeWidth - width) / 2)
  const x = safeWidth < 900 ? centeredX : Math.max(84, Math.min(centeredX, inspectorLeft - EDGE_GAP - width))
  const layout: GlassIslandLayout = { mode: 'floating', x, y: safeHeight - height - EDGE_GAP, width, height, previous: null }
  return bounds.height < 500 ? collapseIsland(layout, 'composer', bounds) : layout
}

export function clampIslandLayout(
  layout: GlassIslandLayout,
  id: GlassIslandId,
  bounds: IslandBounds
): GlassIslandLayout {
  if (layout.mode === 'orb') {
    const x = Math.min(Math.max(EDGE_GAP, finite(layout.x, EDGE_GAP)), Math.max(EDGE_GAP, bounds.width - ORB_SIZE - EDGE_GAP))
    const y = Math.min(Math.max(EDGE_GAP, finite(layout.y, EDGE_GAP)), Math.max(EDGE_GAP, bounds.height - ORB_SIZE - EDGE_GAP))
    return { ...layout, x, y, width: ORB_SIZE, height: ORB_SIZE }
  }
  const minimum = layout.mode === 'docked-top' || layout.mode === 'docked-bottom'
    ? id === 'tools'
      ? { width: 260, height: 102 }
      : id === 'inspector'
        ? { width: 520, height: 190 }
        : { width: 420, height: 184 }
    : ISLAND_MINIMUMS[id]
  const maximumWidth = Math.max(minimum.width, bounds.width - EDGE_GAP * 2)
  const maximumHeight = Math.max(minimum.height, bounds.height - EDGE_GAP * 2)
  const width = Math.min(maximumWidth, Math.max(minimum.width, finite(layout.width, minimum.width)))
  let height = Math.min(maximumHeight, Math.max(minimum.height, finite(layout.height, minimum.height)))
  const x = Math.min(Math.max(EDGE_GAP, finite(layout.x, EDGE_GAP)), Math.max(EDGE_GAP, bounds.width - width - EDGE_GAP))
  let y = Math.min(Math.max(EDGE_GAP, finite(layout.y, EDGE_GAP)), Math.max(EDGE_GAP, bounds.height - height - EDGE_GAP))
  // Reserve the directly visible view controls below the right inspector.
  // Right docking affects fit by width only; this does not shrink the artwork.
  if (id === 'inspector' && layout.mode === 'docked-right') {
    const safeBottom = bounds.height - EDGE_GAP - 96 - 12
    if (y + minimum.height > safeBottom) y = Math.max(EDGE_GAP, safeBottom - minimum.height)
    height = Math.max(minimum.height, Math.min(height, safeBottom - y))
  }
  return { ...layout, x, y, width, height }
}

export function normalizeStoredIslandLayout(value: unknown, id: GlassIslandId, bounds: IslandBounds): GlassIslandLayout {
  const fallback = createDefaultIslandLayout(id, bounds)
  if (!isRecord(value) || !isIslandMode(value.mode)) return fallback
  return clampIslandLayout({
    mode: value.mode,
    x: numberOr(value.x, fallback.x),
    y: numberOr(value.y, fallback.y),
    width: numberOr(value.width, value.mode === 'orb' ? ORB_SIZE : fallback.width),
    height: numberOr(value.height, value.mode === 'orb' ? ORB_SIZE : fallback.height),
    previous: storedPrevious(value.previous)
  }, id, bounds)
}

export function detectDockingMode(rect: IslandRect, bounds: IslandBounds, threshold = 34): Exclude<GlassIslandMode, 'floating' | 'orb'> | null {
  if (rect.y <= threshold) return 'docked-top'
  if (rect.y + rect.height >= bounds.height - threshold) return 'docked-bottom'
  if (rect.x <= threshold) return 'docked-left'
  if (rect.x + rect.width >= bounds.width - threshold) return 'docked-right'
  return null
}

export function detectPointerDockingMode(point: { x: number; y: number }, bounds: IslandBounds, threshold = 34): Exclude<GlassIslandMode, 'floating' | 'orb'> | null {
  const edges = [
    { mode: 'docked-top' as const, distance: Math.abs(point.y) },
    { mode: 'docked-bottom' as const, distance: Math.abs(bounds.height - point.y) },
    { mode: 'docked-left' as const, distance: Math.abs(point.x) },
    { mode: 'docked-right' as const, distance: Math.abs(bounds.width - point.x) }
  ].sort((a, b) => a.distance - b.distance)
  return edges[0]!.distance <= threshold ? edges[0]!.mode : null
}

export function applyIslandMode(
  layout: GlassIslandLayout,
  id: GlassIslandId,
  mode: Exclude<GlassIslandMode, 'orb'>,
  bounds: IslandBounds
): GlassIslandLayout {
  if (mode === 'floating') return clampIslandLayout({ ...layout, mode }, id, bounds)
  if (mode === 'docked-top' || mode === 'docked-bottom') {
    const width = id === 'tools'
      ? Math.min(520, bounds.width - 180)
      : id === 'inspector'
        ? Math.min(820, bounds.width - 180)
        : Math.min(760, bounds.width - 180)
    const height = id === 'tools' ? 102 : id === 'inspector' ? 206 : Math.max(216, layout.height)
    const y = mode === 'docked-top' ? EDGE_GAP : bounds.height - height - EDGE_GAP
    return clampIslandLayout({ ...layout, mode, width, height, x: Math.round((bounds.width - width) / 2), y }, id, bounds)
  }
  const changingOrientation = layout.mode === 'docked-top' || layout.mode === 'docked-bottom'
  const defaults = createDefaultIslandLayout(id, bounds)
  const expandedDefaults = defaults.mode === 'orb' ? defaults.previous ?? defaults : defaults
  const side = id === 'composer' && (changingOrientation || layout.mode === 'floating')
    ? { width: Math.min(380, bounds.width - EDGE_GAP * 2), height: Math.min(360, bounds.height - EDGE_GAP * 2) }
    : changingOrientation ? { width: expandedDefaults.width, height: expandedDefaults.height } : { width: layout.width, height: layout.height }
  const x = mode === 'docked-left' ? EDGE_GAP : bounds.width - side.width - EDGE_GAP
  return clampIslandLayout({ ...layout, ...side, mode, x }, id, bounds)
}

export function detachIslandLayout(layout: GlassIslandLayout, id: GlassIslandId, bounds: IslandBounds): GlassIslandLayout {
  if (layout.mode === 'floating' || layout.mode === 'orb') return clampIslandLayout(layout, id, bounds)
  if (layout.mode === 'docked-top' || layout.mode === 'docked-bottom') {
    const defaultLayout = createDefaultIslandLayout(id, bounds)
    const floating = defaultLayout.mode === 'orb' && defaultLayout.previous !== null ? defaultLayout.previous : defaultLayout
    return clampIslandLayout({
      ...floating,
      previous: null,
      x: layout.x + (layout.width - floating.width) / 2,
      y: layout.y + (layout.height - floating.height) / 2
    }, id, bounds)
  }
  return clampIslandLayout({ ...layout, mode: 'floating' }, id, bounds)
}

export function resizeIslandLayout(
  layout: GlassIslandLayout,
  id: GlassIslandId,
  bounds: IslandBounds,
  dx: number,
  dy: number
): GlassIslandLayout {
  if (layout.mode === 'orb') return layout
  const widthDelta = layout.mode === 'docked-right' ? -dx : dx
  const heightDelta = layout.mode === 'docked-bottom' ? -dy : dy
  let next = clampIslandLayout({
    ...layout,
    width: layout.width + widthDelta,
    height: layout.height + heightDelta
  }, id, bounds)
  if (layout.mode === 'docked-left') next = { ...next, x: EDGE_GAP }
  if (layout.mode === 'docked-right') next = { ...next, x: bounds.width - next.width - EDGE_GAP }
  if (layout.mode === 'docked-top') next = { ...next, y: EDGE_GAP }
  if (layout.mode === 'docked-bottom') next = { ...next, y: bounds.height - next.height - EDGE_GAP }
  return clampIslandLayout(next, id, bounds)
}

export function collapseIsland(layout: GlassIslandLayout, id: GlassIslandId, bounds: IslandBounds): GlassIslandLayout {
  if (layout.mode === 'orb') return layout
  const previous = { x: layout.x, y: layout.y, width: layout.width, height: layout.height, mode: layout.mode }
  return clampIslandLayout({
    mode: 'orb',
    x: layout.x + layout.width - ORB_SIZE,
    y: layout.y,
    width: ORB_SIZE,
    height: ORB_SIZE,
    previous
  }, id, bounds)
}

export function restoreIsland(layout: GlassIslandLayout, id: GlassIslandId, bounds: IslandBounds): GlassIslandLayout {
  if (layout.mode !== 'orb' || layout.previous === null) {
    const fallback = createDefaultIslandLayout(id, bounds)
    return fallback.mode === 'orb' && fallback.previous !== null
      ? clampIslandLayout({ ...fallback.previous, previous: null }, id, bounds) : fallback
  }
  return clampIslandLayout({ ...layout.previous, previous: null }, id, bounds)
}

/** Keep an orb outside other instruments without changing its restore geometry. */
export function avoidIslandOrbOverlap(layout: GlassIslandLayout, id: GlassIslandId, bounds: IslandBounds,
  layouts: Partial<Record<GlassIslandId, GlassIslandLayout>>, utilities: readonly IslandRect[] = []): GlassIslandLayout {
  if (layout.mode !== 'orb') return layout
  const occupied: readonly IslandRect[] = [...Object.entries(layouts).filter(([key]) => key !== id)
    .map(([key, value]) => clampIslandLayout(value, key as GlassIslandId, bounds)), ...utilities]
  const xs = [layout.x, 18, bounds.width - layout.width - 18, ...occupied.flatMap(rect => [rect.x - layout.width - 12, rect.x + rect.width + 12])]
  const ys = [layout.y, 18, bounds.height - layout.height - 18, ...occupied.flatMap(rect => [rect.y - layout.height - 12, rect.y + rect.height + 12])]
  const candidates = xs.flatMap(x => ys.map(y => clampIslandLayout({ ...layout, x, y }, id, bounds)))
    .sort((a, b) => (a.x - layout.x) ** 2 + (a.y - layout.y) ** 2 - (b.x - layout.x) ** 2 - (b.y - layout.y) ** 2)
  for (const next of candidates) {
    if (occupied.every((other) => next.x + next.width + 6 <= other.x || other.x + other.width + 6 <= next.x
      || next.y + next.height + 6 <= other.y || other.y + other.height + 6 <= next.y)) return next
  }
  return layout
}

export function islandBreakpoint(width: number): 'compact' | 'standard' | 'wide' {
  if (width < 270) return 'compact'
  if (width < 520) return 'standard'
  return 'wide'
}

export interface IslandFitInsets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

const BASE_FIT_INSETS: IslandFitInsets = { top: 30, right: 42, bottom: 116, left: 42 }
const FIT_MARGIN = 12
const WORKSPACE_TO_STAGE_TOP = 14

// The artboard fit rect yields to docked islands so artwork never sits
// permanently underneath a panel. Floating islands and orbs stay movable and
// do not displace the canvas. Coordinates translate from the workspace surface
// into the canvas frame (workspace padding 16/14/16/16 around it).
export function islandFitInsets(
  layouts: Partial<Record<GlassIslandId, GlassIslandLayout>>,
  bounds?: IslandBounds
): IslandFitInsets {
  let insets = BASE_FIT_INSETS
  for (const layout of Object.values(layouts)) {
    if (layout === undefined) continue
    if (layout.mode === 'docked-right') insets = { ...insets, right: Math.max(insets.right, layout.width + EDGE_GAP + FIT_MARGIN - 16) }
    else if (layout.mode === 'docked-left') insets = { ...insets, left: Math.max(insets.left, layout.width + EDGE_GAP + FIT_MARGIN - 16) }
    else if (layout.mode === 'docked-top') insets = { ...insets, top: Math.max(insets.top, layout.height + EDGE_GAP + FIT_MARGIN - 14) }
    else if (layout.mode === 'docked-bottom') insets = { ...insets, bottom: Math.max(insets.bottom, layout.height + EDGE_GAP + FIT_MARGIN - 16) }
  }
  const composer = layouts.composer
  if (bounds !== undefined && composer?.mode === 'floating') {
    const composerCenterY = composer.y + composer.height / 2
    if (composerCenterY >= bounds.height / 2) {
      insets = { ...insets, bottom: Math.max(insets.bottom, bounds.height - (composer.y - WORKSPACE_TO_STAGE_TOP) + FIT_MARGIN) }
    } else {
      insets = { ...insets, top: Math.max(insets.top, composer.y - WORKSPACE_TO_STAGE_TOP + composer.height + FIT_MARGIN) }
    }
  }
  return insets
}
