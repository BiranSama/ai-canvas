import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { ELEMENT_SCHEMA_VERSION, sceneSchema, type BlendMode, type Scene } from '../../src/domain'
import { CompositeReferenceRenderer } from '../../src/main/reference'

/*
 * A clipping stack keeps its base's coverage, as Photoshop's clipping and
 * W3C source-atop do: what is clipped to a half-transparent base shows at
 * the base's transparency rather than adding to it.
 */

const SHAPE = {
  version: ELEMENT_SCHEMA_VERSION, description: '', opacity: 1, visible: true, locked: false, groupId: null,
  semanticRole: 'content', referencePolicy: 'include' as const, role: 'final' as const, shape: 'rectangle' as const,
  stroke: null, strokeWidth: 0, cornerRadius: 0, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }
}

function stack(base: string, clipped: readonly { readonly fill: string; readonly blendMode: BlendMode }[]): Scene {
  return sceneSchema.parse({
    schemaVersion: 1, id: '31000000-0000-4000-8000-000000000001', projectId: '31000000-0000-4000-8000-000000000002', revision: 0,
    canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 64, outputHeight: 64, backgroundColor: '#FFFFFF', transparent: true, globalStyle: '' },
    elements: [
      { ...SHAPE, id: '31000000-0000-4000-8000-000000000010', type: 'shape', name: '底', zIndex: 0, fill: base, blendMode: 'normal' },
      ...clipped.map((layer, index) => ({ ...SHAPE, id: `31000000-0000-4000-8000-00000000002${index}`, type: 'shape', name: `剪贴 ${index}`, zIndex: index + 1, fill: layer.fill, blendMode: layer.blendMode, clipped: true }))
    ],
    relations: [], creativeContext: null, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z'
  })
}

async function center(scene: Scene): Promise<number[]> {
  const rendered = await new CompositeReferenceRenderer().render(scene, 'final')
  const { data, info } = await sharp(rendered.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const offset = (32 * info.width + 32) * 4
  return [...data.subarray(offset, offset + 4)]
}

describe('clipping stacks in Main\'s renderer', () => {
  it('keep the base\'s coverage under what is clipped to it', async () => {
    // Opaque blue over half-transparent red: blue, at the base's alpha.
    expect(await center(stack('#FF000080', [{ fill: '#0000FF', blendMode: 'normal' }]))).toEqual([0, 0, 255, 128])
    // More layers clipped do not make it more opaque.
    expect((await center(stack('#FF000080', [{ fill: '#0000FF80', blendMode: 'normal' }, { fill: '#00FF0080', blendMode: 'normal' }])))[3]).toBe(128)
    // Half-transparent blue over it: halfway between, still at the base's alpha.
    const half = await center(stack('#FF000080', [{ fill: '#0000FF80', blendMode: 'normal' }]))
    expect(half[3]).toBe(128)
    expect(Math.abs(half[0]! - half[2]!)).toBeLessThanOrEqual(2)
    // A blend mode blends with the base's colour.
    expect(await center(stack('#808080FF', [{ fill: '#808080', blendMode: 'multiply' }]))).toEqual([64, 64, 64, 255])
  })
})
