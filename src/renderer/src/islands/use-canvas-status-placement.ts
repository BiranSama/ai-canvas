import { type CSSProperties, type RefObject, useLayoutEffect, useState } from 'react'
import { useIslandLayoutStore } from './island-layout-store'

interface Rect { x: number; y: number; width: number; height: number }
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width + 8 && a.x + a.width + 8 > b.x && a.y < b.y + b.height + 8 && a.y + a.height + 8 > b.y
}

/** Keep view controls in free instrument space after a user commits a dock/move. */
export function useCanvasStatusPlacement(workspaceRef: RefObject<HTMLElement | null>, statusRef: RefObject<HTMLDivElement | null>, sizeRef: RefObject<HTMLDivElement | null>, focusMode: boolean): { status: CSSProperties; size: CSSProperties } | undefined {
  const layouts = useIslandLayoutStore(state => state.layouts)
  const [position, setPosition] = useState<{ status: CSSProperties; size: CSSProperties }>()
  useLayoutEffect(() => {
    if (focusMode) return
    const workspace = workspaceRef.current
    const status = statusRef.current
    const size = sizeRef.current
    if (workspace === null || status === null || size === null) return
    const measure = (): void => {
      const bounds = workspace.getBoundingClientRect()
      const own = status.getBoundingClientRect()
      const sizeBounds = size.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0 || own.width <= 0 || own.height <= 0) return
      // Fixed view entries take free space first; collapsed orbs yield to these
      // reservations. Expanded instruments keep the user's exact geometry.
      const obstacles = [...workspace.querySelectorAll<HTMLElement>('.glass-island:not(.glass-island-orb), .runtime-pill')]
        .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible')
        .map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height } })
      const place = (preferred: Rect): Rect => {
        const xs = [preferred.x, 18, ...obstacles.flatMap(rect => [rect.x - preferred.width - 12, rect.x + rect.width + 12])]
        const ys = [preferred.y, 18, ...obstacles.flatMap(rect => [rect.y - preferred.height - 12, rect.y + rect.height + 12])]
        const candidates = xs.flatMap(x => ys.map(y => ({ ...preferred, x, y })))
          .filter(rect => rect.x >= 18 && rect.y >= 18 && rect.x + rect.width <= bounds.width - 18 && rect.y + rect.height <= bounds.height - 18)
          .filter(rect => obstacles.every(obstacle => !intersects(rect, obstacle)))
          .sort((a, b) => (a.x - preferred.x) ** 2 + (a.y - preferred.y) ** 2 - (b.x - preferred.x) ** 2 - (b.y - preferred.y) ** 2)
        return candidates[0] ?? preferred
      }
      const sizePosition = place({ x: 104, y: 30, width: sizeBounds.width, height: sizeBounds.height })
      obstacles.push(sizePosition)
      const statusPosition = place({ x: bounds.width - own.width - 18, y: bounds.height - own.height - 18, width: own.width, height: own.height })
      const next = { size: { left: sizePosition.x, top: sizePosition.y, right: 'auto', bottom: 'auto' }, status: { left: statusPosition.x, top: statusPosition.y, right: 'auto', bottom: 'auto' } }
      setPosition(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
      useIslandLayoutStore.getState().publishUtilities([sizePosition, statusPosition])
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    observer.observe(status)
    observer.observe(size)
    for (const island of workspace.querySelectorAll('.glass-island')) observer.observe(island)
    workspace.addEventListener('transitionend', measure)
    return () => { observer.disconnect(); workspace.removeEventListener('transitionend', measure) }
  }, [focusMode, layouts, sizeRef, statusRef, workspaceRef])
  return focusMode ? undefined : position
}
