export const GLASS_ISLAND_STORAGE_KEY = 'ai-canvas.glass-islands.v1'
export const GLASS_ISLAND_RESET_EVENT = 'ai-canvas:reset-glass-islands'
export const GLASS_ISLAND_FOCUS_EVENT = 'ai-canvas:focus-glass-island'

const LEGACY_GLASS_ISLAND_STORAGE_KEY = 'ai-canvas.r2.glass-islands.v1'

// Reads the current key first, then the pre-V1 key so existing layouts survive the rename.
export function readGlassIslandStorage(): string | null {
  return localStorage.getItem(GLASS_ISLAND_STORAGE_KEY) ?? localStorage.getItem(LEGACY_GLASS_ISLAND_STORAGE_KEY)
}

export function resetAllGlassIslands(): void {
  localStorage.removeItem(GLASS_ISLAND_STORAGE_KEY)
  localStorage.removeItem(LEGACY_GLASS_ISLAND_STORAGE_KEY)
  window.dispatchEvent(new Event(GLASS_ISLAND_RESET_EVENT))
}
