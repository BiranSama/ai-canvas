import { describe, expect, it } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene } from '../../src/domain'
import { compilePromptIr, elementPresentation, ProviderPromptCompiler } from '../../src/main/reference'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'

function sceneWithOcclusion(): Scene {
  const scene = createNightVeilScene()
  return sceneSchema.parse({
    ...scene,
    elements: [
      ...scene.elements,
      {
        id: '10000000-0000-4000-8000-000000000099',
        version: ELEMENT_SCHEMA_VERSION,
        type: 'shape',
        name: '前景薄雾',
        description: '瓶身前方的低位薄雾',
        transform: { x: .25, y: .67, width: .5, height: .12, rotation: 0 },
        zIndex: 4,
        opacity: .7,
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'foreground-atmosphere',
        referencePolicy: 'include',
        shape: 'ellipse',
        fill: '#B9D5F2',
        stroke: null,
        strokeWidth: 0,
        role: 'final'
      }
    ],
    relations: [{
      id: '10000000-0000-4000-8000-000000000098',
      type: 'illuminates',
      sourceElementId: NIGHT_VEIL_IDS.light,
      targetElementId: NIGHT_VEIL_IDS.bottle,
      description: '蓝色柔光从后方勾勒瓶身'
    }]
  })
}

describe('Prompt IR and provider prompt compiler', () => {
  it('preserves canvas, text, light, relations, protection and explicit occlusion semantics', () => {
    const scene = sceneWithOcclusion()
    const ir = compilePromptIr(scene, '保持克制的深蓝香水广告', '2026-08-10T00:00:00.000Z')
    expect(ir.canvas).toMatchObject({ aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280 })
    expect(ir.elements.find((element) => element.id === NIGHT_VEIL_IDS.title)).toMatchObject({
      type: 'text',
      attributes: { content: 'NIGHT VEIL', accuracy: 'strict' }
    })
    expect(ir.elements.find((element) => element.id === NIGHT_VEIL_IDS.light)).toMatchObject({
      type: 'light',
      attributes: { color: '#7BB5FF', intensity: .72, targetElementIds: [NIGHT_VEIL_IDS.bottle] }
    })
    expect(ir.protectedElementIds).toContain(NIGHT_VEIL_IDS.background)
    expect(ir.relations).toHaveLength(1)
    expect(ir.occlusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ frontElementId: '10000000-0000-4000-8000-000000000099', behindElementId: NIGHT_VEIL_IDS.bottle })
    ]))
    expect(ir.occlusions[0]?.instruction).toContain('不要把任一物体误解为透明材质')

    const compiled = new ProviderPromptCompiler().compile(ir, 'mock', {
      textToImage: true,
      imageReferences: true,
      maskEditing: true,
      multipleReferences: true,
      transparentOutput: false,
      maxImages: 4,
      supportedRatios: ['4:5'],
      supportedFormats: ['png']
    })
    expect(compiled.prompt).toContain('4:5')
    expect(compiled.prompt).toContain('NIGHT VEIL')
    expect(compiled.prompt).toContain('光影')
    expect(compiled.prompt).toContain('真实遮挡')
    expect(compiled.negativePrompt).toContain('选择框')
    expect(compiled.referenceStrategy).toBe('composite')
  })

  it('defines distinct editing, reference and final representations', () => {
    const scene = createNightVeilScene()
    const placeholder = scene.elements.find((element) => element.type === 'placeholder')
    const light = scene.elements.find((element) => element.type === 'light')
    const title = scene.elements.find((element) => element.type === 'text')
    if (placeholder === undefined || light === undefined || title === undefined) throw new Error('Fixture is incomplete.')
    expect(elementPresentation(placeholder, 'editing')).toBe('editing')
    expect(elementPresentation(placeholder, 'reference')).toBe('reference')
    expect(elementPresentation(placeholder, 'final')).toBe('omit')
    expect(elementPresentation(light, 'reference')).toBe('reference')
    expect(elementPresentation(light, 'final')).toBe('omit')
    expect(elementPresentation(title, 'final')).toBe('final')
  })

  it('encodes Group membership as semantic composition context for the image provider', () => {
    const source = createNightVeilScene()
    const childIds = [NIGHT_VEIL_IDS.bottle, NIGHT_VEIL_IDS.title]
    const groupId = '10000000-0000-4000-8000-000000000097'
    const result = new CommandBus(source).execute({
      id: '10000000-0000-4000-8000-000000000096',
      origin: 'agent',
      summary: '建立主体组件',
      commands: [{
        kind: 'element.group',
        elementIds: childIds,
        group: {
          id: groupId,
          version: ELEMENT_SCHEMA_VERSION,
          type: 'group',
          name: '香水主体组件',
          description: '保持共同语义并允许独立编辑',
          transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
          zIndex: 0,
          opacity: 1,
          visible: true,
          locked: false,
          groupId: null,
          semanticRole: 'subject-assembly',
          referencePolicy: 'include',
          childIds
        }
      }]
    })
    if (!result.ok) throw result.error
    const prompt = new ProviderPromptCompiler().compile(
      compilePromptIr(result.scene, '生成完整海报', '2026-08-10T00:00:00.000Z'),
      'mock',
      {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: true,
        transparentOutput: false,
        maxImages: 4,
        supportedRatios: ['4:5'],
        supportedFormats: ['png']
      }
    ).prompt

    expect(prompt).toContain('语义组件')
    expect(prompt).toContain('香水主体组件')
    expect(prompt).toContain('香水瓶')
    expect(prompt).toContain('NIGHT VEIL')
    expect(prompt).toContain('每个子元素理解为可独立呈现的视觉对象')
  })

  it('carries blend intent through Prompt IR and provider copy without leaking renderer protocol names', () => {
    const source = createNightVeilScene()
    const light = source.elements.find((element) => element.type === 'light')
    if (light?.type !== 'light') throw new Error('Light fixture is missing.')
    const scene = sceneSchema.parse({
      ...source,
      elements: source.elements.map((element) => element.id === light.id ? { ...element, blendMode: 'screen' } : element)
    })
    const ir = compilePromptIr(scene, '让背光更轻盈', '2026-08-10T00:00:00.000Z')
    const compiled = new ProviderPromptCompiler().compile(ir, 'mock', {
      textToImage: true,
      imageReferences: true,
      maskEditing: true,
      multipleReferences: true,
      transparentOutput: false,
      maxImages: 4,
      supportedRatios: ['4:5'],
      supportedFormats: ['png']
    })

    expect(ir.elements.find((element) => element.id === light.id)?.blendMode).toBe('screen')
    expect(ir.elements.find((element) => element.blendMode === undefined)).toBeUndefined()
    expect(compiled.prompt).toContain('滤色')
    expect(compiled.prompt).not.toContain('globalCompositeOperation')
    expect(compiled.prompt).not.toContain('mix-blend-mode')
  })
})
