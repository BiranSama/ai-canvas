const runtimeAssetUrls = new Map<string, string>()
const missingRuntimeAssets = new Set<string>()
const loadingRuntimeAssets = new Set<string>()
const runtimeAssetListeners = new Set<() => void>()
let runtimeAssetVersion = 0

function notifyRuntimeAssetChange(): void {
  runtimeAssetVersion += 1
  for (const listener of runtimeAssetListeners) listener()
}

function revokeRuntimeAssetUrl(url: string | undefined): void {
  if (url?.startsWith('blob:') === true) URL.revokeObjectURL(url)
}

export function beginRuntimeAssetLoad(assetId: string): boolean {
  if (runtimeAssetUrls.has(assetId) || missingRuntimeAssets.has(assetId) || loadingRuntimeAssets.has(assetId)) return false
  loadingRuntimeAssets.add(assetId)
  notifyRuntimeAssetChange()
  return true
}

export function registerRuntimeAsset(assetId: string, url: string): void {
  const previous = runtimeAssetUrls.get(assetId)
  if (previous !== url) revokeRuntimeAssetUrl(previous)
  runtimeAssetUrls.set(assetId, url)
  loadingRuntimeAssets.delete(assetId)
  missingRuntimeAssets.delete(assetId)
  notifyRuntimeAssetChange()
}

export function getRuntimeAssetUrl(assetId: string): string | null {
  return runtimeAssetUrls.get(assetId) ?? null
}

export function markRuntimeAssetMissing(assetId: string): void {
  revokeRuntimeAssetUrl(runtimeAssetUrls.get(assetId))
  runtimeAssetUrls.delete(assetId)
  loadingRuntimeAssets.delete(assetId)
  missingRuntimeAssets.add(assetId)
  notifyRuntimeAssetChange()
}

export function isRuntimeAssetMissing(assetId: string): boolean {
  return missingRuntimeAssets.has(assetId)
}

export function isRuntimeAssetLoading(assetId: string): boolean {
  return loadingRuntimeAssets.has(assetId)
}

export function getRuntimeAssetVersion(): number {
  return runtimeAssetVersion
}

export function subscribeRuntimeAssets(listener: () => void): () => void {
  runtimeAssetListeners.add(listener)
  return () => runtimeAssetListeners.delete(listener)
}

export function clearRuntimeAssets(): void {
  for (const url of runtimeAssetUrls.values()) {
    revokeRuntimeAssetUrl(url)
  }
  runtimeAssetUrls.clear()
  missingRuntimeAssets.clear()
  loadingRuntimeAssets.clear()
  notifyRuntimeAssetChange()
}
