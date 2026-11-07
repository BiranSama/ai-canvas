import { produce } from 'immer'
import { afterEach, expect, it, vi } from 'vitest'
import { applySceneCommand } from '../../src/domain/commands/apply-command'
import type { Scene, SceneCommand, SceneElement } from '../../src/domain'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'
import type * as PixelLayers from '../../src/renderer/src/canvas/pixel-layers'
import type * as AppNotice from '../../src/renderer/src/components/app-notice'

const pixels = vi.hoisted(() => ({ source: null as HTMLCanvasElement | null }))
vi.mock('../../src/renderer/src/canvas/pixel-layers', async (importOriginal) => ({
  ...await importOriginal<typeof PixelLayers>(),
  pixelLayerCanvas: () => pixels.source,
  layerSourceImage: () => null
}))

const notices = vi.hoisted(() => [] as string[])
vi.mock('../../src/renderer/src/components/app-notice', async (importOriginal) => ({
  ...await importOriginal<typeof AppNotice>(),
  showAppNotice: (message: string) => { notices.push(message) }
}))

const { createAdjustmentLayer, layerHistogram } = await import('../../src/renderer/src/adjustments/adjustment-actions')
const { rasterizeLayer } = await import('../../src/renderer/src/canvas/layer-actions')
const { resetWorkspace, useWorkspaceStore } = await import('../../src/renderer/src/store/workspace-store')

afterEach(() => { pixels.source = null; resetWorkspace() })

/** Records what each step would do to the scene, instead of sending it to Main. */
function recording(scene: Scene): SceneCommand[][] {
  const steps: SceneCommand[][] = []
  resetWorkspace(scene)
  useWorkspaceStore.setState({
    execute: (async (_summary: string, commands: SceneCommand[] | ((scene: Scene) => SceneCommand[] | null)) => {
      const list = typeof commands === 'function' ? commands(useWorkspaceStore.getState().scene) : commands
      if (list === null) return false
      steps.push(list)
      return true
    }) as never
  })
  return steps
}

it('puts a new adjustment layer above a selected group\'s layers, not under them', async () => {
  const base = createMerchantExampleScene('coffee-poster')
  const title = base.elements.find((element) => element.name === '标题')!
  const subtitle = base.elements.find((element) => element.name === '副标题')!
  const scene = produce(base, (draft) => {
    applySceneCommand(draft, {
      kind: 'element.group', elementIds: [title.id, subtitle.id],
      group: { ...title, id: '0f0f0f0f-0000-4000-8000-0000000000c3', type: 'group', name: '标题组', childIds: [title.id, subtitle.id] } as unknown as Extract<SceneElement, { type: 'group' }>
    })
  })
  const steps = recording(scene)
  useWorkspaceStore.getState().setSelection(['0f0f0f0f-0000-4000-8000-0000000000c3'])
  expect(await createAdjustmentLayer('invert')).not.toBeNull()
  const reorder = steps[0]!.find((command) => command.kind === 'element.reorder')
  const top = Math.max(...scene.elements.filter((element) => element.id === title.id || element.id === subtitle.id).map((element) => element.zIndex))
  expect(reorder).toMatchObject({ toIndex: top + 1 })
})

it('refuses to rasterize a composition placeholder instead of replacing it with nothing', async () => {
  const base = createMerchantExampleScene('coffee-poster')
  const shape = base.elements.find((element) => element.type === 'shape')!
  const scene = { ...base, elements: base.elements.map((element) => element.id === shape.id ? { ...element, role: 'placeholder' } as SceneElement : element) }
  const steps = recording(scene)
  expect(await rasterizeLayer(shape.id)).toBe(false)
  expect(steps).toEqual([])
  expect(notices.at(-1)).toContain('构图占位')
})

it('measures a picture after its colour match, as it is drawn', () => {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 1
  const values = [0, 100]
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage: () => undefined,
    getImageData: () => ({ width: 2, height: 1, data: new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255])) })
  } as never)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'canvas' ? canvas : document.createElementNS('http://www.w3.org/1999/xhtml', tag)) as never)
  pixels.source = canvas
  const image = createMerchantExampleScene('coffee-poster').elements.find((element) => element.type === 'image' || element.type === 'placeholder')!
  const element = { ...image, type: 'image', assetId: '0f0f0f0f-0000-4000-8000-0000000000c4', crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'fill', referenceRole: 'general',
    effects: { colorMatch: { gain: [1, 1, 1], offset: [100, 100, 100] }, feather: 0, shadow: null } } as unknown as Extract<SceneElement, { type: 'image' }>
  const counts = layerHistogram(element, '')!
  expect(counts.red[100]).toBe(1)
  expect(counts.red[200]).toBe(1)
  expect(counts.red[0]).toBe(0)
  vi.restoreAllMocks()
})
