import type Konva from 'konva'

/**
 * Lets go of a group's own cached picture. Konva's clearCache would drop
 * every cached picture inside the group too (the isolated groups, masked
 * boxes and styled layers in it), which then would draw without theirs.
 */
export function releaseOwnCache(group: Konva.Group): void {
  const caches = (group as unknown as { _cache: Map<string, unknown> })._cache
  const own = caches.get('canvas') as Record<'scene' | 'filter' | 'hit', { _canvas: HTMLCanvasElement }> | undefined
  if (own === undefined) return
  caches.delete('canvas')
  for (const canvas of [own.scene, own.filter, own.hit]) {
    canvas._canvas.width = 0
    canvas._canvas.height = 0
  }
}
