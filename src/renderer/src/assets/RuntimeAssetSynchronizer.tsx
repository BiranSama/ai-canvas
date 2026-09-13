import { useEffect } from 'react'
import type { DesktopApi } from '../../../shared/desktop-api'
import { useWorkspaceStore } from '../store/workspace-store'
import { projectGeneration } from '../store/project-context-lifecycle'
import {
  beginRuntimeAssetLoad,
  markRuntimeAssetMissing,
  registerRuntimeAsset
} from './runtime-assets'

/**
 * Keeps Main-authoritative Scene image references and Renderer display assets in sync.
 * This is deliberately renderer-wide so Agent/Main placements behave the same as
 * placements initiated from the Generate view.
 */
export function RuntimeAssetSynchronizer(): null {
  const scene = useWorkspaceStore((state) => state.scene)
  const assetIds = [...new Set(scene.elements
    .filter((element) => element.type === 'image')
    .map((element) => element.assetId))]
  const assetKey = assetIds.slice().sort().join('\u0000')

  useEffect(() => {
    const desktop = window.desktop as Partial<DesktopApi> | undefined
    if (desktop?.readGenerationAsset === undefined) return
    const generation = projectGeneration()
    const isCurrent = (): boolean => projectGeneration() === generation && useWorkspaceStore.getState().scene.projectId === scene.projectId

    for (const assetId of assetIds) {
      if (!beginRuntimeAssetLoad(assetId)) continue
      void desktop.readGenerationAsset(assetId, false, scene.projectId)
        .then((url) => { if (isCurrent()) registerRuntimeAsset(assetId, url) })
        .catch(() => { if (isCurrent()) markRuntimeAssetMissing(assetId) })
    }
  // assetKey is the stable semantic dependency; scene revisions without image changes
  // must not restart local asset reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetKey, scene.projectId])

  return null
}
