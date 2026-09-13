import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, sceneSchema } from '../../../src/domain'
import { IDS, makeAllElementTypesScene, makeImage, makeText } from '../../fixtures/scene-fixtures'

const TIMES = [
  '2026-08-10T00:00:01.000Z',
  '2026-08-10T00:00:02.000Z',
  '2026-08-10T00:00:03.000Z',
  '2026-08-10T00:00:04.000Z'
]

function makeBus(): CommandBus {
  let index = 0
  return new CommandBus(
    createScene({ id: IDS.scene, projectId: IDS.project, now: '2026-08-10T00:00:00.000Z' }),
    { now: () => TIMES[index++] ?? '2026-08-10T00:00:09.000Z' }
  )
}

describe('CommandBus', () => {
  it('commits several changes as one atomic undo batch', () => {
    const bus = makeBus()
    const result = bus.execute({
      id: IDS.batch1,
      origin: 'agent',
      summary: '创建香水海报布局',
      commands: [
        { kind: 'element.add', element: makeImage(99) },
        { kind: 'element.add', element: makeText(99) },
        { kind: 'element.update', elementId: IDS.text, changes: { letterSpacing: 28 } },
        { kind: 'element.update', elementId: IDS.image, changes: { transform: { y: 0.38 } } }
      ]
    })

    expect(result.ok).toBe(true)
    expect(bus.getScene().elements).toHaveLength(2)
    expect(bus.getScene().elements[0]?.zIndex).toBe(0)
    expect(bus.getScene().elements[1]?.zIndex).toBe(1)
    expect(bus.undoDepth).toBe(1)

    expect(bus.undo()?.summary).toBe('创建香水海报布局')
    expect(bus.getScene().elements).toHaveLength(0)
    expect(bus.canRedo).toBe(true)

    bus.redo()
    expect(bus.getScene().elements).toHaveLength(2)
    expect(bus.getScene().elements[1]).toMatchObject({ type: 'text', letterSpacing: 28 })
    expect(bus.getScene().revision).toBe(3)
  })

  it('rejects an invalid later command without partially committing earlier commands', () => {
    const bus = makeBus()
    const before = bus.getScene()
    const result = bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '无效批次',
      commands: [
        { kind: 'element.add', element: makeImage(0) },
        { kind: 'element.update', elementId: IDS.text, changes: { name: '不存在' } }
      ]
    })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: { code: 'ELEMENT_NOT_FOUND' } })
    expect(bus.getScene()).toBe(before)
    expect(bus.getScene().elements).toHaveLength(0)
    expect(bus.canUndo).toBe(false)
  })

  it('changes output resolution without changing normalized element geometry', () => {
    const bus = makeBus()
    bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '加入标题',
      commands: [{ kind: 'element.add', element: makeText(0) }]
    })
    const transform = bus.getScene().elements[0]?.transform
    const result = bus.execute({
      id: IDS.batch2,
      origin: 'user',
      summary: '调整输出分辨率',
      commands: [
        {
          kind: 'scene.set-canvas',
          canvas: { ...bus.getScene().canvas, outputWidth: 2048, outputHeight: 2560 }
        }
      ]
    })

    expect(result.ok).toBe(true)
    expect(bus.getScene().elements[0]?.transform).toEqual(transform)
  })

  it('keeps a legacy element unattributed until an explicit edit writes normal blend semantics', () => {
    const legacy = makeAllElementTypesScene()
    expect(legacy.elements[0]?.blendMode).toBeUndefined()
    const bus = new CommandBus(legacy, { now: () => '2026-08-10T00:00:05.000Z' })
    const result = bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '明确修改旧元素',
      commands: [{ kind: 'element.update', elementId: IDS.image, changes: { opacity: .86 } }]
    })

    expect(result.ok).toBe(true)
    expect(bus.getScene().elements.find((element) => element.id === IDS.image)?.blendMode).toBe('normal')
    expect(bus.getScene().elements.find((element) => element.id === IDS.text)?.blendMode).toBeUndefined()
  })

  it('groups, reorders and ungroups elements while preserving canonical order', () => {
    const bus = makeBus()
    bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '加入元素',
      commands: [
        { kind: 'element.add', element: makeImage(0) },
        { kind: 'element.add', element: makeText(1) }
      ]
    })
    const group = {
      id: IDS.group,
      version: 1 as const,
      type: 'group' as const,
      name: '标题与商品',
      description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      zIndex: 0,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'composition',
      referencePolicy: 'include' as const,
      childIds: [IDS.image, IDS.text]
    }
    const grouped = bus.execute({
      id: IDS.batch2,
      origin: 'user',
      summary: '组合标题与商品',
      commands: [{ kind: 'element.group', group, elementIds: [IDS.image, IDS.text] }]
    })

    expect(grouped.ok).toBe(true)
    expect(sceneSchema.safeParse(bus.getScene()).success).toBe(true)
    expect(bus.getScene().elements.find((element) => element.id === IDS.image)?.groupId).toBe(IDS.group)

    const ungrouped = bus.execute({
      id: '00000000-0000-4000-8000-000000000017',
      origin: 'user',
      summary: '取消组合',
      commands: [{ kind: 'element.ungroup', groupId: IDS.group }]
    })
    expect(ungrouped.ok).toBe(true)
    expect(bus.getScene().elements.map((element) => element.zIndex)).toEqual([0, 1])
    expect(bus.getScene().elements.every((element) => element.groupId === null)).toBe(true)
  })

  it('does not mutate a locked element until it is explicitly unlocked', () => {
    const bus = makeBus()
    bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '加入锁定标题',
      commands: [{ kind: 'element.add', element: { ...makeText(0), locked: true } }]
    })
    const failed = bus.execute({
      id: IDS.batch2,
      origin: 'agent',
      summary: '移动标题',
      commands: [{ kind: 'element.update', elementId: IDS.text, changes: { transform: { x: 0.2 } } }]
    })
    expect(failed).toMatchObject({ ok: false, error: { code: 'ELEMENT_LOCKED' } })

    const unlocked = bus.execute({
      id: '00000000-0000-4000-8000-000000000017',
      origin: 'user',
      summary: '解锁标题',
      commands: [{ kind: 'element.update', elementId: IDS.text, changes: { locked: false } }]
    })
    expect(unlocked.ok).toBe(true)
  })

  it('removes attached masks and relationships with their deleted target', () => {
    const bus = new CommandBus(makeAllElementTypesScene(), {
      now: () => '2026-08-10T00:00:05.000Z'
    })
    const addedRelation = bus.execute({
      id: IDS.batch1,
      origin: 'user',
      summary: '关联标题与商品',
      commands: [
        {
          kind: 'relation.add',
          relation: {
            id: IDS.relation,
            type: 'above',
            sourceElementId: IDS.text,
            targetElementId: IDS.image,
            description: '标题位于商品上方'
          }
        }
      ]
    })
    expect(addedRelation.ok).toBe(true)

    const removed = bus.execute({
      id: IDS.batch2,
      origin: 'user',
      summary: '删除商品',
      commands: [{ kind: 'element.remove', elementId: IDS.image }]
    })

    expect(removed.ok).toBe(true)
    expect(bus.getScene().elements.some((element) => element.id === IDS.image)).toBe(false)
    expect(bus.getScene().elements.some((element) => element.id === IDS.mask)).toBe(false)
    expect(bus.getScene().relations).toHaveLength(0)
    expect(sceneSchema.safeParse(bus.getScene()).success).toBe(true)
  })
})
