import { describe, expect, it } from 'vitest'
import { createMerchantExampleScene, MERCHANT_EXAMPLE_KEYS, MERCHANT_EXAMPLES } from '../../src/renderer/src/fixtures/merchant-examples'

describe('merchant examples', () => {
  it.each(MERCHANT_EXAMPLE_KEYS)('builds %s as a valid, editable scene with a subject to generate into', (key) => {
    const scene = createMerchantExampleScene(key, { projectId: '70000000-0000-4000-8000-000000000001', sceneId: '70000000-0000-4000-8000-000000000002' })
    const [width, height] = MERCHANT_EXAMPLES[key].ratio.split(':').map(Number)
    expect(scene.canvas).toMatchObject({ aspectWidth: width, aspectHeight: height })
    expect(scene.elements.filter((element) => element.type === 'placeholder' && element.semanticRole === 'subject')).toHaveLength(1)
    expect(scene.elements.some((element) => element.type === 'text' && element.semanticRole === 'title')).toBe(true)
    expect(scene.elements.every((element) => !element.locked)).toBe(true)
    expect(new Set(scene.elements.map((element) => element.id)).size).toBe(scene.elements.length)
    expect(MERCHANT_EXAMPLES[key].prompts).toHaveLength(3)
  })
})
