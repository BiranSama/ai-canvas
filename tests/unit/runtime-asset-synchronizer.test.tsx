import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import { RuntimeAssetSynchronizer } from '../../src/renderer/src/assets/RuntimeAssetSynchronizer'
import {
  clearRuntimeAssets,
  getRuntimeAssetUrl,
  isRuntimeAssetLoading,
  isRuntimeAssetMissing,
  subscribeRuntimeAssets
} from '../../src/renderer/src/assets/runtime-assets'
import { resetWorkspace, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'

const ASSET_ID = '31000000-0000-4000-8000-000000000001'
const ELEMENT_ID = '31000000-0000-4000-8000-000000000002'
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

function sceneWithImage() {
  const scene = structuredClone(useWorkspaceStore.getState().scene)
  scene.elements = [{
    id: ELEMENT_ID,
    version: ELEMENT_SCHEMA_VERSION,
    type: 'image' as const,
    name: 'Agent 生成结果',
    description: '由 Agent 放入画布的生成结果',
    transform: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'generated-result',
    referencePolicy: 'include' as const,
    provenance: {
      origin: 'mock-generated' as const,
      sourceBriefId: null,
      sourceDirectionId: null,
      sourceAssetId: ASSET_ID
    },
    assetId: ASSET_ID,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    fit: 'contain' as const,
    referenceRole: 'general' as const
  }]
  return scene
}

describe('runtime asset synchronization', () => {
  beforeEach(() => {
    clearRuntimeAssets()
    resetWorkspace()
  })

  afterEach(() => {
    clearRuntimeAssets()
  })

  it('loads an image introduced by a live Scene update without reopening the project', async () => {
    const readGenerationAsset = vi.fn().mockResolvedValue(DATA_URL)
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { readGenerationAsset }
    })
    const versions: number[] = []
    const unsubscribe = subscribeRuntimeAssets(() => versions.push(versions.length + 1))
    const view = render(<RuntimeAssetSynchronizer />)

    resetWorkspace(sceneWithImage())

    await waitFor(() => expect(readGenerationAsset).toHaveBeenCalledWith(ASSET_ID, false, useWorkspaceStore.getState().scene.projectId))
    await waitFor(() => expect(getRuntimeAssetUrl(ASSET_ID)).toBe(DATA_URL))
    expect(isRuntimeAssetLoading(ASSET_ID)).toBe(false)
    expect(isRuntimeAssetMissing(ASSET_ID)).toBe(false)
    expect(versions.length).toBeGreaterThanOrEqual(2)

    unsubscribe()
    view.unmount()
  })

  it('deduplicates reads while a newly introduced asset is still loading', async () => {
    let resolveRead: ((url: string) => void) | undefined
    const readGenerationAsset = vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
      resolveRead = resolve
    }))
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { readGenerationAsset }
    })
    const view = render(<RuntimeAssetSynchronizer />)

    const scene = sceneWithImage()
    resetWorkspace(scene)
    useWorkspaceStore.setState({ scene: { ...scene, revision: scene.revision + 1 } })

    await waitFor(() => expect(readGenerationAsset).toHaveBeenCalledTimes(1))
    expect(isRuntimeAssetLoading(ASSET_ID)).toBe(true)
    resolveRead?.(DATA_URL)
    await waitFor(() => expect(getRuntimeAssetUrl(ASSET_ID)).toBe(DATA_URL))

    view.unmount()
  })
})
