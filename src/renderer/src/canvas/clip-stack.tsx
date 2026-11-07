import type Konva from 'konva'
import type { FilterFunction } from 'konva/lib/Node'
import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { Group } from 'react-konva'
import { IsolationContext } from './isolation-refresh'

/*
 * Photoshop's clipping masks as Konva draws them. A clipping stack is drawn
 * into a picture of its own first (the base at full strength, then each
 * clipped layer cut to the base's content and laid over in its own mode),
 * and that picture is laid over the layers below with the base's opacity and
 * mode. Each clipped layer is likewise drawn alone first, with the base's
 * content drawn over it with destination-in to cut it. Main's renderer does
 * the same in pixels, so the canvas, the export and the reference agree.
 */

/** The most pixels an isolated group is drawn into on the canvas. */
const ISOLATED_PIXELS = 16_000_000

/**
 * A group drawn into its own picture before it is laid over what is below,
 * so what it holds blends only with itself. It is drawn again whenever it
 * renders, and while one of its layers is dragged or transformed.
 */
/**
 * Lets go of a group's own cached picture. Konva's clearCache would drop
 * every cached picture inside the group too (the isolated groups, masked
 * boxes and styled layers in it), which then would draw without theirs.
 */
function releaseOwnCache(group: Konva.Group): void {
  const caches = (group as unknown as { _cache: Map<string, unknown> })._cache
  const own = caches.get('canvas') as Record<'scene' | 'filter' | 'hit', { _canvas: HTMLCanvasElement }> | undefined
  if (own === undefined) return
  caches.delete('canvas')
  for (const canvas of [own.scene, own.filter, own.hit]) {
    canvas._canvas.width = 0
    canvas._canvas.height = 0
  }
}

function cacheOne(group: Konva.Group, pixelRatio: number, maxPixels: number): void {
  releaseOwnCache(group)
  // A cut is drawn over all its parent holds: the browser composites a picture only where it lies, so
  // destination-in would leave what lies past the cut's own content.
  const parent = group.getParent()
  // A warped layer names the area it is drawn into: its box and where its corners take it.
  const fixed = group.getAttr('cacheRect') as { x: number; y: number; width: number; height: number } | undefined
  const rect = fixed ?? (group.getAttr('coverParent') === true && parent !== null ? parent : group).getClientRect({ skipTransform: true })
  if (rect.width < 1 || rect.height < 1) return
  group.cache({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, pixelRatio: Math.min(pixelRatio, Math.sqrt(maxPixels / (rect.width * rect.height))) })
}

/** Draws a group into its own picture again, the isolated groups inside it first (deepest first: they come after their parents). */
function cacheIsolated(group: Konva.Group, pixelRatio: number, maxPixels: number): void {
  for (const inner of group.find<Konva.Group>('.isolated-group').reverse()) cacheOne(inner, pixelRatio, maxPixels)
  cacheOne(group, pixelRatio, maxPixels)
}

export function IsolatedGroup({ operation, opacity = 1, pixelRatio, maxPixels = ISOLATED_PIXELS, coverParent = false, cacheRect, listening, attrs, clipFunc, filters, beforeRedraw, children }: {
  /** How the group's picture is laid over what is below. */
  readonly operation: GlobalCompositeOperation
  /** Drawn over the whole of what its parent holds, transparent past its content: for a cut laid on with destination-in. */
  readonly coverParent?: boolean
  /** The area drawn into, in the group's units, when it is not what the group holds. */
  readonly cacheRect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Off when something else takes the group's clicks. */
  readonly listening?: boolean
  /** More attributes for its filters to read. */
  readonly attrs?: Record<string, unknown>
  /** Cuts what is drawn, and where it can be clicked, to a path. */
  readonly clipFunc?: (context: Konva.Context, group: Konva.Group) => void
  /** Konva filters on its cached picture. */
  readonly filters?: FilterFunction[]
  readonly opacity?: number
  /** Raster pixels per unit of the group. */
  readonly pixelRatio: number
  /** The most pixels it is drawn into; past that it is drawn coarser. An export passes its own size. */
  readonly maxPixels?: number
  /** Runs before a drag or transform draws the group again, to bring copies of a moving layer along. */
  readonly beforeRedraw?: (group: Konva.Group) => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<Konva.Group>(null)
  const outer = useContext(IsolationContext)
  const pending = useRef<number | null>(null)
  const redraw = useCallback((): void => {
    const group = ref.current
    if (group === null) return
    beforeRedraw?.(group)
    // A drag inside redraws every isolated group within, since a copy of the moving layer may sit in another.
    cacheIsolated(group, pixelRatio, maxPixels)
  }, [pixelRatio, maxPixels, beforeRedraw])
  // The outermost group draws everything inside again, once a frame at most.
  const refresh = useMemo(() => outer ?? ((): void => {
    if (pending.current !== null) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      const group = ref.current
      if (group === null) return
      cacheIsolated(group, pixelRatio, maxPixels)
      group.getLayer()?.batchDraw()
    })
  }), [outer, pixelRatio, maxPixels])
  useLayoutEffect(() => () => { if (pending.current !== null) cancelAnimationFrame(pending.current) }, [])
  useLayoutEffect(() => {
    const group = ref.current
    if (group === null) return
    // On a render the groups inside have just drawn themselves.
    cacheOne(group, pixelRatio, maxPixels)
    group.getLayer()?.batchDraw()
  })
  return (
    <IsolationContext.Provider value={refresh}>
    <Group ref={ref} name="isolated-group" coverParent={coverParent} {...(cacheRect === undefined ? {} : { cacheRect })} {...(listening === undefined ? {} : { listening })} {...attrs} {...(filters === undefined ? {} : { filters })} {...(clipFunc === undefined ? {} : { clipFunc: (context: Konva.Context) => { if (ref.current !== null) clipFunc(context, ref.current) } })} opacity={opacity} {...(operation === 'source-over' ? {} : { globalCompositeOperation: operation })}
      // The outermost group draws everything inside it again; one inside it would only repeat part of that.
      {...(outer === null ? { onDragMove: redraw, onTransform: redraw } : {})}>
      {children}
    </Group>
    </IsolationContext.Provider>
  )
}
