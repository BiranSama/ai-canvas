import { afterEach, expect, it, vi } from 'vitest'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

const drawn: string[][] = []
const asked: Record<string, unknown>[] = []
vi.mock('../../src/renderer/src/canvas/layer-render', () => ({
  renderLayersAsDrawn: vi.fn(async (ids: readonly string[], options: Record<string, unknown> = {}) => { drawn.push([...ids]); asked.push(options); return null })
}))

const { samplePixels } = await import('../../src/renderer/src/selection/selection-sampling')
const { resetWorkspace } = await import('../../src/renderer/src/store/workspace-store')

afterEach(() => { drawn.length = 0; asked.length = 0; resetWorkspace() })

it('samples a sketch kept in the final picture with the other layers, and never an editing mark', async () => {
  const scene = makeAllElementTypesScene()
  resetWorkspace(scene)
  await samplePixels(true)
  expect(drawn.at(-1)).not.toContain(IDS.sketch)
  resetWorkspace({ ...scene, revision: scene.revision + 1, elements: scene.elements.map((element) => element.id === IDS.sketch ? { ...element, finalVisible: true } : element) })
  await samplePixels(true)
  expect(drawn.at(-1)).toContain(IDS.sketch)
  expect(drawn.at(-1)).toContain(IDS.image)
})

it('samples all layers through the adjustment layers over them, as the picture shows them', async () => {
  const scene = makeAllElementTypesScene()
  const adjustment = {
    id: '0f0f0f0f-0000-4000-8000-0000000000c1', version: 1, type: 'adjustment', name: '反相 1', description: '',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, zIndex: scene.elements.length, opacity: 1, blendMode: 'normal', visible: true, locked: false,
    groupId: null, semanticRole: 'adjustment', referencePolicy: 'include', settings: { kind: 'invert' }, mask: null
  } as const
  resetWorkspace({ ...scene, revision: scene.revision + 2, elements: [...scene.elements, adjustment] })
  await samplePixels(true)
  expect(drawn.at(-1)).toContain(adjustment.id)
  // The canvas colour is drawn under the layers, so the adjustment layer changes it as it does on the canvas.
  expect(asked.at(-1)).toMatchObject({ canvasBackground: true })
})
