import { describe, expect, it, vi } from 'vitest'
import { SceneService } from '../../src/main/scene'
import { createHundredElementScene } from '../../src/renderer/src/fixtures/hundred-elements'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'

describe('Main SceneService authority', () => {
  it('serializes user and Agent batches against one revision and publishes monotonic events', async () => {
    const saved: Array<{ revision: number; batchId: string | null }> = []
    const service = new SceneService(createNightVeilScene(), {
      save: async (scene, batch) => {
        saved.push({ revision: scene.revision, batchId: batch?.id ?? null })
      },
      now: () => '2026-08-22T12:00:00.000+08:00'
    })
    const events: number[] = []
    service.subscribe((event) => events.push(event.state.sequence))

    const user = await service.execute({
      expectedSceneRevision: 0,
      batch: {
        id: '31000000-0000-4000-8000-000000000001',
        origin: 'user',
        summary: '用户调整标题',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: 0.8 } }]
      }
    })
    const agent = await service.execute({
      expectedSceneRevision: 1,
      batch: {
        id: '31000000-0000-4000-8000-000000000002',
        origin: 'agent',
        summary: 'Agent 调整主体',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.bottle, changes: { opacity: 0.7 } }]
      }
    })

    expect(user.ok).toBe(true)
    expect(agent.ok).toBe(true)
    expect(service.state()).toMatchObject({ sequence: 2, canUndo: true, canRedo: false, scene: { revision: 2 } })
    expect(saved).toEqual([
      { revision: 1, batchId: '31000000-0000-4000-8000-000000000001' },
      { revision: 2, batchId: '31000000-0000-4000-8000-000000000002' }
    ])
    expect(events).toEqual([1, 2])
  })

  it('rejects stale commands without persisting or changing history', async () => {
    const save = vi.fn(async () => undefined)
    const service = new SceneService(createNightVeilScene(), { save })

    const result = await service.execute({
      expectedSceneRevision: 99,
      batch: {
        id: '31000000-0000-4000-8000-000000000003',
        origin: 'user',
        summary: '过期修改',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: 0.5 } }]
      }
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'SCENE_REVISION_STALE', recoverable: true } })
    expect(service.state()).toMatchObject({ sequence: 0, canUndo: false, scene: { revision: 0 } })
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps one-batch undo semantics and refuses to undo a non-latest Agent batch', async () => {
    const service = new SceneService(createNightVeilScene(), { save: async () => undefined })
    await service.execute({
      expectedSceneRevision: 0,
      batch: {
        id: '31000000-0000-4000-8000-000000000004', origin: 'agent', summary: '第一批',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: 0.8 } }]
      }
    })
    await service.execute({
      expectedSceneRevision: 1,
      batch: {
        id: '31000000-0000-4000-8000-000000000005', origin: 'user', summary: '第二批',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.bottle, changes: { opacity: 0.7 } }]
      }
    })

    const refused = await service.undo({
      expectedSceneRevision: 2,
      batchId: '31000000-0000-4000-8000-000000000004'
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'SCENE_BATCH_NOT_LATEST' } })

    const undone = await service.undo({ expectedSceneRevision: 2, batchId: null })
    expect(undone).toMatchObject({
      ok: true,
      receipt: { action: 'undo', affectedBatchId: '31000000-0000-4000-8000-000000000005' }
    })
    expect(service.state()).toMatchObject({ canUndo: true, canRedo: true, scene: { revision: 3 } })
  })

  it('restores Scene and history exactly when durable persistence fails', async () => {
    let fail = true
    const service = new SceneService(createNightVeilScene(), {
      save: async () => {
        if (fail) throw new Error('disk unavailable')
      }
    })

    const failed = await service.execute({
      expectedSceneRevision: 0,
      batch: {
        id: '31000000-0000-4000-8000-000000000006', origin: 'user', summary: '失败批次',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: 0.4 } }]
      }
    })
    expect(failed).toMatchObject({ ok: false, error: { code: 'SCENE_PERSIST_FAILED' } })
    expect(service.state()).toMatchObject({ sequence: 0, canUndo: false, canRedo: false, scene: { revision: 0 } })

    fail = false
    const retried = await service.execute({
      expectedSceneRevision: 0,
      batch: {
        id: '31000000-0000-4000-8000-000000000007', origin: 'user', summary: '重试批次',
        commands: [{ kind: 'element.update', elementId: NIGHT_VEIL_IDS.title, changes: { opacity: 0.4 } }]
      }
    })
    expect(retried).toMatchObject({ ok: true, receipt: { state: { sequence: 1, scene: { revision: 1 } } } })
  })

  it('executes a 100-element update without a renderer-owned CommandBus', async () => {
    const scene = createHundredElementScene()
    const target = scene.elements[99]
    if (target === undefined) throw new Error('100-element fixture is incomplete.')
    const service = new SceneService(scene, { save: async () => undefined })
    const startedAt = performance.now()
    const result = await service.execute({
      expectedSceneRevision: scene.revision,
      batch: {
        id: '31000000-0000-4000-8000-000000000008', origin: 'user', summary: '更新第 100 个元素',
        commands: [{ kind: 'element.update', elementId: target.id, changes: { name: '已调整元素' } }]
      }
    })
    const elapsed = performance.now() - startedAt

    expect(result).toMatchObject({ ok: true, receipt: { state: { scene: { revision: scene.revision + 1 } } } })
    expect(service.state().scene.elements[99]?.name).toBe('已调整元素')
    expect(elapsed).toBeLessThan(500)
  })
})
