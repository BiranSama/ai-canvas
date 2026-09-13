import { describe, expect, it } from 'vitest'
import { blendModeCommandViolation, compileAtomicSceneCommands } from '../../src/main/agent/atomic-scene-tools'
import { AgentToolRegistry } from '../../src/main/agent/agent-tool-registry'
import { agentToolPlanSchema } from '../../src/shared/agent'
import { makeAllElementTypesScene } from '../fixtures/scene-fixtures'

const ID = '00000000-0000-4000-8000-000000000001'

describe('AT1 atomic Scene tools', () => {
  it('publishes all ten approved tools as available', () => {
    const registry = new AgentToolRegistry()
    const names = [
      'scene.get_summary',
      'scene.get_elements',
      'scene.set_canvas',
      'scene.create_elements',
      'scene.update_elements',
      'scene.reorder_elements',
      'scene.group_elements',
      'scene.remove_elements',
      'history.undo_batch',
      'result.place_on_canvas'
    ]
    for (const name of names) expect(registry.require(name).implementation).toBe('available')
  })

  it('rejects arbitrary update fields and compiles supported fields to Scene commands', () => {
    const valid = agentToolPlanSchema.parse({
      kind: 'scene.update_elements',
      expectedSceneRevision: 4,
      summary: '移动主体',
      updates: [{ elementId: ID, changes: { opacity: 0.8, transform: { x: .2, y: .3, width: .4, height: .5, rotation: 0 } } }]
    })
    expect(valid.kind).toBe('scene.update_elements')
    if (valid.kind !== 'scene.update_elements') throw new Error('Expected atomic update tool.')
    expect(compileAtomicSceneCommands(valid)).toEqual([{
      kind: 'element.update',
      elementId: ID,
      changes: { opacity: 0.8, transform: { x: .2, y: .3, width: .4, height: .5, rotation: 0 } }
    }])

    expect(agentToolPlanSchema.safeParse({
      kind: 'scene.update_elements',
      expectedSceneRevision: 4,
      summary: '越权字段',
      updates: [{ elementId: ID, changes: { arbitraryJsonPatch: true } }]
    }).success).toBe(false)
  })

  it('allows only the approved blend modes through the controlled Scene update tool', () => {
    for (const blendMode of ['normal', 'multiply', 'screen', 'overlay', 'soft-light'] as const) {
      const parsed = agentToolPlanSchema.safeParse({
        kind: 'scene.update_elements',
        expectedSceneRevision: 4,
        summary: '调整图层混合',
        updates: [{ elementId: ID, changes: { blendMode } }]
      })
      expect(parsed.success).toBe(true)
    }
    expect(agentToolPlanSchema.safeParse({
      kind: 'scene.update_elements',
      expectedSceneRevision: 4,
      summary: '非法混合',
      updates: [{ elementId: ID, changes: { blendMode: 'difference' } }]
    }).success).toBe(false)
  })

  it('rejects non-normal Group, Mask and Placeholder blending before an Agent write', () => {
    const scene = makeAllElementTypesScene()
    const image = scene.elements.find((element) => element.type === 'image')
    if (image === undefined) throw new Error('Missing image fixture.')
    const sceneWithGroup = {
      ...scene,
      elements: [...scene.elements, {
        ...image,
        id: '00000000-0000-4000-8000-000000000099',
        type: 'group' as const,
        name: '测试组合',
        childIds: [image.id]
      }]
    }
    for (const type of ['group', 'mask', 'placeholder'] as const) {
      const target = sceneWithGroup.elements.find((element) => element.type === type)
      if (target === undefined) throw new Error(`Missing ${type} fixture.`)
      expect(blendModeCommandViolation(sceneWithGroup, [{ kind: 'element.update', elementId: target.id, changes: { blendMode: 'screen' } }])).toContain(type)
    }
    expect(blendModeCommandViolation(sceneWithGroup, [{ kind: 'element.update', elementId: image.id, changes: { blendMode: 'screen' } }])).toBeNull()
  })
})
