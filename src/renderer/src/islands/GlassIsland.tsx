import {
  CircleDot,
  GripHorizontal,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  RotateCcw
} from 'lucide-react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  applyIslandMode,
  avoidIslandOrbOverlap,
  clampIslandLayout,
  collapseIsland,
  createDefaultIslandLayout,
  detachIslandLayout,
  detectPointerDockingMode,
  islandBreakpoint,
  normalizeStoredIslandLayout,
  resizeIslandLayout,
  restoreIsland,
  type GlassIslandId,
  type GlassIslandLayout,
  type GlassIslandMode,
  type IslandBounds
} from './island-layout'
import { GLASS_ISLAND_FOCUS_EVENT, GLASS_ISLAND_RESET_EVENT, GLASS_ISLAND_STORAGE_KEY, readGlassIslandStorage } from './island-events'
import { useIslandLayoutStore } from './island-layout-store'

interface IslandControls {
  readonly collapse: () => void
  readonly layout: GlassIslandLayout
}

interface GlassIslandProps {
  readonly id: GlassIslandId
  readonly label: string
  readonly icon: LucideIcon
  readonly containerRef: React.RefObject<HTMLElement | null>
  readonly resizable?: boolean
  readonly status?: 'idle' | 'active'
  readonly children: ReactNode | ((controls: IslandControls) => ReactNode)
}

type StoredLayouts = Partial<Record<GlassIslandId, unknown>>

function readStoredLayout(id: GlassIslandId): unknown {
  try {
    const value = JSON.parse(readGlassIslandStorage() ?? '{}') as StoredLayouts
    return value[id] ?? null
  } catch {
    return null
  }
}

function storeLayout(id: GlassIslandId, layout: GlassIslandLayout): void {
  try {
    const current = JSON.parse(readGlassIslandStorage() ?? '{}') as StoredLayouts
    localStorage.setItem(GLASS_ISLAND_STORAGE_KEY, JSON.stringify({ ...current, [id]: layout }))
  } catch {
    // Layout persistence is a convenience; the editor remains fully usable without it.
  }
}

interface PointerSession {
  readonly kind: 'move' | 'resize'
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly layout: GlassIslandLayout
  readonly captureEl: HTMLElement
}

// Releasing capture is best-effort: a stale pointer id or a detached element
// may make the platform throw, and that must never take the renderer down.
function releaseSessionCapture(session: PointerSession): void {
  try {
    if (session.captureEl.hasPointerCapture(session.pointerId)) {
      session.captureEl.releasePointerCapture(session.pointerId)
    }
  } catch {
    // Capture release failure leaves no renderer-side state behind.
  }
}

export function GlassIsland({
  id,
  label,
  icon: Icon,
  containerRef,
  resizable = true,
  status = 'idle',
  children
}: GlassIslandProps): React.JSX.Element | null {
  const initialStoredLayout = useMemo(() => readStoredLayout(id), [id])
  const initialBounds = useMemo<IslandBounds>(() => ({
    // The workspace owns the full viewport width; its padding is inside its
    // border box. Subtracting that padding here made the first layout 32 px
    // narrower than the measured container and shifted every initial target.
    width: Math.max(640, window.innerWidth),
    height: Math.max(240, window.innerHeight - (window.innerWidth <= 900 ? 100 : 60))
  }), [])
  const [bounds, setBounds] = useState<IslandBounds>(initialBounds)
  const boundsRef = useRef<IslandBounds>(initialBounds)
  const [layout, setLayout] = useState<GlassIslandLayout>(() =>
    normalizeStoredIslandLayout(initialStoredLayout, id, initialBounds)
  )
  const [preview, setPreview] = useState<Exclude<GlassIslandMode, 'floating' | 'orb'> | null>(null)
  const [interacting, setInteracting] = useState(false)
  const [foreground, setForeground] = useState(false)
  const focusIsland = (): void => { window.dispatchEvent(new CustomEvent(GLASS_ISLAND_FOCUS_EVENT, { detail: id })) }
  useEffect(() => {
    const receiveFocus = (event: Event): void => setForeground((event as CustomEvent<GlassIslandId>).detail === id)
    window.addEventListener(GLASS_ISLAND_FOCUS_EVENT, receiveFocus)
    return () => window.removeEventListener(GLASS_ISLAND_FOCUS_EVENT, receiveFocus)
  }, [id])
  const [isResponsiveDefault, setIsResponsiveDefault] = useState(initialStoredLayout === null)
  const layoutRef = useRef(layout)
  const previewRef = useRef<typeof preview>(preview)
  const pointerSession = useRef<PointerSession | null>(null)
  const moved = useRef(false)
  const opticalFrame = useRef<number | null>(null)
  const responsiveDefault = useRef(initialStoredLayout === null)

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  const updateLayout = useCallback((next: GlassIslandLayout): void => {
    layoutRef.current = next
    setLayout(next)
  }, [])

  const updatePreview = useCallback((next: typeof preview): void => {
    previewRef.current = next
    setPreview(next)
  }, [])

  const commit = useCallback((requested: GlassIslandLayout): void => {
    const next = avoidIslandOrbOverlap(requested, id, bounds, useIslandLayoutStore.getState().layouts, useIslandLayoutStore.getState().utilities)
    responsiveDefault.current = false
    setIsResponsiveDefault(false)
    updateLayout(next)
    storeLayout(id, next)
    useIslandLayoutStore.getState().publish(id, next)
  }, [bounds, id, updateLayout])

  // Publish the settled layout so the canvas fit rect can yield to docked
  // islands. Transient drag frames never publish; only commits do.
  useEffect(() => {
    useIslandLayoutStore.getState().publish(id, layoutRef.current)
  }, [id])

  useEffect(() => useIslandLayoutStore.subscribe(({ layouts, utilities }) => {
    const current = layoutRef.current
    if (current.mode !== 'orb' || pointerSession.current !== null) return
    const next = avoidIslandOrbOverlap(current, id, boundsRef.current, layouts, utilities)
    if (next.x === current.x && next.y === current.y) return
    updateLayout(next)
    storeLayout(id, next)
    useIslandLayoutStore.getState().publish(id, next)
  }), [id, updateLayout])

  const reset = useCallback((): void => {
    if (bounds.width <= 0 || bounds.height <= 0) return
    const next = createDefaultIslandLayout(id, bounds)
    commit(next)
    responsiveDefault.current = true
    setIsResponsiveDefault(true)
  }, [bounds, commit, id])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = (): void => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const nextBounds = { width: rect.width, height: rect.height }
      const previousBounds = boundsRef.current
      boundsRef.current = nextBounds
      setBounds(nextBounds)
      if (responsiveDefault.current) {
        const next = avoidIslandOrbOverlap(createDefaultIslandLayout(id, nextBounds), id, nextBounds, useIslandLayoutStore.getState().layouts)
        updateLayout(next)
        useIslandLayoutStore.getState().publish(id, next)
        return
      }
      const current = layoutRef.current
      const bottomGap = previousBounds.height - current.y - current.height
      const centeredDistance = Math.abs(current.x + current.width / 2 - previousBounds.width / 2)
      const responsiveFloating = id === 'composer' && current.mode === 'floating'
        ? {
            ...current,
            x: centeredDistance <= 40 ? current.x + (nextBounds.width - previousBounds.width) / 2 : current.x,
            y: bottomGap <= 40 ? current.y + nextBounds.height - previousBounds.height : current.y
          }
        : current
      const projected = responsiveFloating.mode === 'floating' || responsiveFloating.mode === 'orb'
        ? clampIslandLayout(responsiveFloating, id, nextBounds)
        : resizeIslandLayout(responsiveFloating, id, nextBounds, 0, 0)
      const next = avoidIslandOrbOverlap(projected, id, nextBounds, useIslandLayoutStore.getState().layouts)
      updateLayout(next)
      useIslandLayoutStore.getState().publish(id, next)
    }
    if (typeof ResizeObserver === 'undefined') return
    // Reconcile as soon as the parent ref is available. The initial state uses
    // the viewport-sized workspace and responsive defaults have transitions
    // disabled, so this correction cannot create a moving pointer target.
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(document.documentElement)
    // BrowserWindow/Playwright viewport changes can update the outer workspace
    // without delivering a ResizeObserver record for every absolutely
    // positioned child. The window event is a narrow, deterministic fallback
    // and keeps default islands attached to their intended edge on resize.
    let resizeFrame: number | null = null
    const scheduleMeasure = (): void => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null
        measure()
      })
    }
    window.addEventListener('resize', scheduleMeasure)
    window.visualViewport?.addEventListener('resize', scheduleMeasure)
    return () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      window.visualViewport?.removeEventListener('resize', scheduleMeasure)
    }
  }, [containerRef, id, updateLayout])

  useEffect(() => {
    const handleReset = (): void => reset()
    window.addEventListener(GLASS_ISLAND_RESET_EVENT, handleReset)
    return () => window.removeEventListener(GLASS_ISLAND_RESET_EVENT, handleReset)
  }, [reset])

  useEffect(() => {
    const cancel = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || pointerSession.current === null) return
      const session = pointerSession.current
      releaseSessionCapture(session)
      updateLayout(session.layout)
      updatePreview(null)
      pointerSession.current = null
      moved.current = false
      setInteracting(false)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [updateLayout, updatePreview])

  // Window blur must release an in-flight pointer session; otherwise the island
  // would stay captured and jump when the pointer returns at a new position.
  useEffect(() => {
    const releaseOnBlur = (): void => {
      const session = pointerSession.current
      if (session === null) return
      releaseSessionCapture(session)
      pointerSession.current = null
      moved.current = false
      updatePreview(null)
      setInteracting(false)
      updateLayout(session.layout)
    }
    window.addEventListener('blur', releaseOnBlur)
    return () => window.removeEventListener('blur', releaseOnBlur)
  }, [updateLayout, updatePreview])

  // Unmounting mid-gesture must not leave a live pointer capture behind.
  useEffect(() => () => {
    const session = pointerSession.current
    if (session !== null) releaseSessionCapture(session)
    pointerSession.current = null
    if (opticalFrame.current !== null) cancelAnimationFrame(opticalFrame.current)
  }, [])

  const updateOpticalLight = (event: ReactPointerEvent<HTMLElement>): void => {
    if (opticalFrame.current !== null) return
    const element = event.currentTarget
    const clientX = event.clientX
    const clientY = event.clientY
    opticalFrame.current = requestAnimationFrame(() => {
      opticalFrame.current = null
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const x = Math.min(100, Math.max(0, (clientX - rect.left) / rect.width * 100))
      const y = Math.min(100, Math.max(0, (clientY - rect.top) / rect.height * 100))
      element.style.setProperty('--glass-light-x', `${x}%`)
      element.style.setProperty('--glass-light-y', `${y}%`)
    })
  }

  const beginPointer = (event: ReactPointerEvent<HTMLElement>, kind: PointerSession['kind']): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerSession.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, layout: layoutRef.current, captureEl: event.currentTarget }
    moved.current = false
    setInteracting(true)
  }

  // Pointer capture is not equally reliable across every Electron/Windows
  // boundary (for example when a resize cursor crosses another island). Keep a
  // window-level session listener as the authority so move/up/cancel cannot be
  // lost even when the original element stops receiving pointer events.
  useEffect(() => {
    const updatePointer = (event: PointerEvent): void => {
      const session = pointerSession.current
      if (session === null || session.pointerId !== event.pointerId) return
      const currentBounds = boundsRef.current
      const dx = event.clientX - session.startX
      const dy = event.clientY - session.startY
      if (Math.abs(dx) + Math.abs(dy) <= 4) return
      moved.current = true
      if (session.kind === 'resize') {
        updateLayout(resizeIslandLayout(session.layout, id, currentBounds, dx, dy))
        updatePreview(null)
        return
      }
      const base = session.layout.mode === 'floating' || session.layout.mode === 'orb'
        ? session.layout
        : detachIslandLayout(session.layout, id, currentBounds)
      const next = clampIslandLayout({ ...base, x: base.x + dx, y: base.y + dy }, id, currentBounds)
      updateLayout(next)
      const container = containerRef.current?.getBoundingClientRect()
      updatePreview(next.mode === 'orb' || container === undefined ? null : detectPointerDockingMode({ x: event.clientX - container.left, y: event.clientY - container.top }, currentBounds))
    }
    const finishPointer = (event: PointerEvent): void => {
      const session = pointerSession.current
      if (session === null || session.pointerId !== event.pointerId) return
      releaseSessionCapture(session)
      const current = layoutRef.current
      const next = previewRef.current === null
        ? current
        : applyIslandMode(current, id, previewRef.current, boundsRef.current)
      pointerSession.current = null
      updatePreview(null)
      setInteracting(false)
      commit(next)
    }
    const cancelPointer = (event: PointerEvent): void => {
      const session = pointerSession.current
      if (session === null || session.pointerId !== event.pointerId) return
      releaseSessionCapture(session)
      pointerSession.current = null
      updatePreview(null)
      setInteracting(false)
      updateLayout(session.layout)
    }
    window.addEventListener('pointermove', updatePointer, true)
    window.addEventListener('pointerup', finishPointer, true)
    window.addEventListener('pointercancel', cancelPointer, true)
    return () => {
      window.removeEventListener('pointermove', updatePointer, true)
      window.removeEventListener('pointerup', finishPointer, true)
      window.removeEventListener('pointercancel', cancelPointer, true)
    }
  }, [commit, containerRef, id, updateLayout, updatePreview])

  const collapse = useCallback((): void => {
    commit(collapseIsland(layout, id, bounds))
  }, [bounds, commit, id, layout])

  const setMode = (mode: Exclude<GlassIslandMode, 'orb'>): void => {
    commit(applyIslandMode(layoutRef.current, id, mode, bounds))
  }

  const handleResizeKey = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return
    const step = event.shiftKey ? 1 : 10
    const delta: [number, number] | null = event.key === 'ArrowLeft' ? [-step, 0]
      : event.key === 'ArrowRight' ? [step, 0]
        : event.key === 'ArrowUp' ? [0, -step]
          : event.key === 'ArrowDown' ? [0, step]
            : null
    if (delta === null) return
    event.preventDefault()
    event.stopPropagation()
    commit(resizeIslandLayout(layoutRef.current, id, bounds, delta[0], delta[1]))
  }

  const handleGripKey = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation()
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); setMode('docked-top'); return }
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); setMode('docked-bottom'); return }
    if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); setMode('docked-left'); return }
    if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); setMode('docked-right'); return }
    const movement = event.shiftKey ? 1 : 10
    const delta: [number, number] | null = event.key === 'ArrowLeft' ? [-movement, 0]
      : event.key === 'ArrowRight' ? [movement, 0]
        : event.key === 'ArrowUp' ? [0, -movement]
          : event.key === 'ArrowDown' ? [0, movement]
            : null
    if (delta === null) return
    event.preventDefault()
    const current = layoutRef.current
    const base = current.mode === 'floating' || current.mode === 'orb' ? current : detachIslandLayout(current, id, bounds)
    commit(clampIslandLayout({ ...base, x: base.x + delta[0], y: base.y + delta[1] }, id, bounds))
  }

  const breakpoint = useMemo(() => islandBreakpoint(layout.width), [layout])

  const style = {
    '--island-x': `${layout.x}px`,
    '--island-y': `${layout.y}px`,
    '--island-width': `${layout.width}px`,
    '--island-height': `${layout.height}px`
  } as CSSProperties

  if (layout.mode === 'orb') {
    return (
      <div
        className={`glass-island glass-surface glass-island-orb island-${id}`}
        style={style}
        data-island-id={id}
        data-island-mode="orb"
        data-island-foreground={foreground ? 'true' : 'false'}
        onPointerDownCapture={focusIsland}
        onFocusCapture={focusIsland}
        data-island-interacting={interacting ? 'true' : 'false'}
        data-island-responsive-default={isResponsiveDefault ? 'true' : 'false'}
        onPointerMove={updateOpticalLight}
      >
        <button
          type="button"
          aria-label={`展开${label}`}
          title={`${label}（点击展开，拖动移动）`}
          onPointerDown={(event) => beginPointer(event, 'move')}
          onClick={() => { if (!moved.current) commit(restoreIsland(layoutRef.current, id, bounds)); moved.current = false }}
          onKeyDown={handleGripKey}
        >
          <Icon size={21} strokeWidth={1.55} />
          <span className={`island-status-dot is-${status}`} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const controls: IslandControls = { collapse, layout }
  return (
    <>
      {preview !== null && <div className={`island-dock-preview preview-${preview}`} aria-hidden="true" />}
      <section
        className={`glass-island glass-surface island-${id}`}
        style={style}
        aria-label={label}
        data-island-id={id}
        data-island-mode={layout.mode}
        data-island-foreground={foreground ? 'true' : 'false'}
        onPointerDownCapture={focusIsland}
        onFocusCapture={focusIsland}
        data-island-breakpoint={breakpoint}
        data-island-interacting={interacting ? 'true' : 'false'}
        data-island-responsive-default={isResponsiveDefault ? 'true' : 'false'}
        onPointerMove={updateOpticalLight}
      >
        <div
          className="island-grip"
          role="toolbar"
          aria-label={`${label}布局控制`}
          tabIndex={0}
          title="拖动；Alt + 方向键停靠；方向键微移"
          onPointerDown={(event) => beginPointer(event, 'move')}
          onKeyDown={handleGripKey}
        >
          <GripHorizontal size={13} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <div className="island-layout-actions">
          <button type="button" title="停靠左侧" aria-label={`${label}停靠左侧`} onClick={() => setMode('docked-left')}><PanelLeft size={12} /></button>
          <button type="button" title="停靠顶部" aria-label={`${label}停靠顶部`} onClick={() => setMode('docked-top')}><PanelTop size={12} /></button>
          <button type="button" title="停靠右侧" aria-label={`${label}停靠右侧`} onClick={() => setMode('docked-right')}><PanelRight size={12} /></button>
          <button type="button" title="停靠底部" aria-label={`${label}停靠底部`} onClick={() => setMode('docked-bottom')}><PanelBottom size={12} /></button>
          <button type="button" title="还原这个工具岛" aria-label={`还原${label}`} onClick={reset}><RotateCcw size={12} /></button>
          <button type="button" title="收成圆球" aria-label={`收起${label}为圆球`} onClick={collapse}><CircleDot size={12} /></button>
        </div>
        {/* The render prop only passes collapse to Inspector's event handler.
            Its commit updates pointer refs on activation, never while rendering. */}
        {/* eslint-disable-next-line react-hooks/refs */}
        <div className="glass-island-body">{typeof children === 'function' ? children(controls) : children}</div>
        {resizable && (
          <span
            className="island-resize-handle"
            role="separator"
            aria-label={`调整${label}大小`}
            aria-orientation="horizontal"
            aria-valuetext={`${Math.round(layout.width)} × ${Math.round(layout.height)}`}
            tabIndex={0}
            title="拖动调整大小；方向键微调"
            onPointerDown={(event) => beginPointer(event, 'resize')}
            onKeyDown={handleResizeKey}
          />
        )}
      </section>
    </>
  )
}
