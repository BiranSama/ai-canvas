import { afterEach, describe, expect, it } from 'vitest'
import { createScene, type SceneElement } from '../../src/domain'
import { invertMask, rectMask } from '../../src/shared/mask-raster'
import { selectionAnnotation } from '../../src/renderer/src/selection/selection-annotation'
import { setSelectionMask } from '../../src/renderer/src/selection/selection-store'
import { resetWorkspace, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'

const PHOTO = '20000000-0000-4000-8000-000000000011'

function photo(transform: SceneElement['transform']): SceneElement {
  return {
    id: PHOTO, version: 1, type: 'image', name: '照片', description: '', transform, zIndex: 0, opacity: 1, blendMode: 'normal',
    visible: true, locked: false, groupId: null, semanticRole: 'content', referencePolicy: 'include',
    assetId: '20000000-0000-4000-8000-000000000012', crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general'
  } as SceneElement
}

afterEach(() => setSelectionMask(null))

describe('the selection told to the Agent', () => {
  it('is nothing without a selection, and its outlines on the picture they fall on with one', () => {
    const base = createScene({ id: '20000000-0000-4000-8000-000000000001', projectId: '20000000-0000-4000-8000-000000000002', now: '2026-10-25T00:00:00.000Z' })
    resetWorkspace({ ...base, canvas: { ...base.canvas, outputWidth: 200, outputHeight: 100 }, elements: [photo({ x: 0, y: 0, width: 0.5, height: 1, rotation: 0 })] })
    expect(selectionAnnotation()).toBeNull()

    // Two squares, the larger one first; the left one lies on the photo.
    const left = rectMask(200, 100, { x: 10, y: 10, width: 60, height: 60 })
    const right = rectMask(200, 100, { x: 150, y: 20, width: 20, height: 20 })
    for (let index = 0; index < left.data.length; index += 1) left.data[index] = Math.max(left.data[index]!, right.data[index]!)
    setSelectionMask(left)
    const annotation = selectionAnnotation()!
    expect(annotation.regions).toHaveLength(2)
    expect(annotation.regions!.every((region) => region.mode === 'edit' && region.closed)).toBe(true)
    const xs = annotation.regions![0]!.points.map((point) => point.x)
    const ys = annotation.regions![0]!.points.map((point) => point.y)
    // Traced between pixel centres, so within a pixel of the square's edges.
    const edges = [Math.min(...xs) * 200, Math.max(...xs) * 200, Math.min(...ys) * 100, Math.max(...ys) * 100]
    for (const [found, edge] of edges.map((value, index) => [value, [10, 70, 10, 70][index]!] as const)) expect(Math.abs(found - edge)).toBeLessThanOrEqual(1)
    expect(annotation.targetElementId).toBe(PHOTO)

    // With the photo moved away, nothing is under the selection.
    useWorkspaceStore.setState((state) => ({ scene: { ...state.scene, elements: [photo({ x: 0.9, y: 0.9, width: 0.1, height: 0.1, rotation: 0 })] } }))
    expect(selectionAnnotation()!.targetElementId).toBeNull()
  })

  it('sends a hole in the selection as a part to keep as it is', () => {
    const base = createScene({ id: '20000000-0000-4000-8000-000000000001', projectId: '20000000-0000-4000-8000-000000000002', now: '2026-10-25T00:00:00.000Z' })
    resetWorkspace({ ...base, canvas: { ...base.canvas, outputWidth: 200, outputHeight: 100 }, elements: [] })
    // An inverted rectangle: everything but the middle.
    setSelectionMask(invertMask(rectMask(200, 100, { x: 60, y: 30, width: 80, height: 40 })))
    const regions = selectionAnnotation()!.regions!
    expect(regions.map((region) => region.mode)).toEqual(['edit', 'protect'])
    const xs = regions[1]!.points.map((point) => point.x * 200)
    expect(Math.abs(Math.min(...xs) - 60)).toBeLessThanOrEqual(1)
    expect(Math.abs(Math.max(...xs) - 140)).toBeLessThanOrEqual(1)
  })
})
