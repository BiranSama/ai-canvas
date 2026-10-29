import { afterEach, expect, it, vi } from 'vitest'
import { IDS, makeAllElementTypesScene } from '../fixtures/scene-fixtures'

const drawn: string[][] = []
vi.mock('../../src/renderer/src/canvas/layer-render', () => ({
  renderLayersAsDrawn: vi.fn(async (ids: readonly string[]) => { drawn.push([...ids]); return null })
}))

const { samplePixels } = await import('../../src/renderer/src/selection/selection-sampling')
const { resetWorkspace } = await import('../../src/renderer/src/store/workspace-store')

afterEach(() => { drawn.length = 0; resetWorkspace() })

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
