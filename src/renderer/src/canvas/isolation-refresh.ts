import { createContext, useContext, useLayoutEffect } from 'react'

/** Asks the outermost isolated group around a layer to draw itself again, after something inside changed on its own. */
export const IsolationContext = createContext<(() => void) | null>(null)

/**
 * For layers whose look changes without the clipping stack around them
 * rendering (a picture that finishes loading, styles worked out again):
 * asks the isolated groups around to draw again once this has drawn.
 */
export function useIsolationRefresh(): void {
  const refresh = useContext(IsolationContext)
  useLayoutEffect(() => { refresh?.() })
}
