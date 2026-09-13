import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type BlendMode, type Scene } from '../../src/domain'
import { CompositeReferenceRenderer } from '../../src/main/reference'

const IDS = {
  scene: '30000000-0000-4000-8000-000000000001',
  project: '30000000-0000-4000-8000-000000000002',
  back: '30000000-0000-4000-8000-000000000003',
  front: '30000000-0000-4000-8000-000000000004'
} as const

function sceneFor(blendMode: BlendMode): Scene {
  const base = {
    version: ELEMENT_SCHEMA_VERSION,
    description: '',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'content',
    referencePolicy: 'include' as const,
    role: 'final' as const,
    shape: 'rectangle' as const,
    stroke: null,
    strokeWidth: 0,
    cornerRadius: 0
  }
  return sceneSchema.parse({
    schemaVersion: 1,
    id: IDS.scene,
    projectId: IDS.project,
    revision: 0,
    canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 64, outputHeight: 64, backgroundColor: '#F5F7FA', transparent: false, globalStyle: '' },
    elements: [
      { ...base, id: IDS.back, type: 'shape', name: '底色', zIndex: 0, fill: '#315B8A', blendMode: 'normal' },
      { ...base, id: IDS.front, type: 'shape', name: '叠色', zIndex: 1, fill: '#D3A75F', blendMode }
    ],
    relations: [],
    creativeContext: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  })
}

async function centerPixel(blendMode: BlendMode): Promise<readonly number[]> {
  const rendered = await new CompositeReferenceRenderer().render(sceneFor(blendMode), 'final')
  const { data, info } = await sharp(rendered.buffer).raw().toBuffer({ resolveWithObject: true })
  const offset = (32 * info.width + 32) * info.channels
  return [...data.subarray(offset, offset + info.channels)]
}

describe('E-S4 Appearance Composite blend modes', () => {
  it('renders five stable, distinguishable composites instead of silently flattening to normal', async () => {
    const entries = await Promise.all((['normal', 'multiply', 'screen', 'overlay', 'soft-light'] as const).map(async (blendMode) => [blendMode, await centerPixel(blendMode)] as const))
    const pixels = Object.fromEntries(entries)

    expect(new Set(Object.values(pixels).map((value) => value.join(','))).size).toBe(5)
    expect(pixels).toMatchInlineSnapshot(`
      {
        "multiply": [
          41,
          60,
          51,
          255,
        ],
        "normal": [
          211,
          167,
          95,
          255,
        ],
        "overlay": [
          81,
          119,
          108,
          255,
        ],
        "screen": [
          219,
          198,
          182,
          255,
        ],
        "soft-light": [
          90,
          110,
          122,
          255,
        ],
      }
    `)
  })
})
