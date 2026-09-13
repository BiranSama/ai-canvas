import { describe, expect, it } from 'vitest'
import { createScene } from '../../src/domain'
import { compileDesignDirectionSelection, DeterministicMockPlanner } from '../../src/main/agent'
import { SceneService } from '../../src/main/scene'
import type { SceneServiceOptions } from '../../src/main/scene/scene-service'
import { deterministicFixtureIds, fixtureAgentRequest } from '../helpers/semantic-fixtures'

async function initializedService(save: SceneServiceOptions['save']) {
  const scene = createScene({
    id: '89000000-0000-4000-8000-000000000001',
    projectId: '89000000-0000-4000-8000-000000000002',
    now: '2026-09-01T00:00:00.000Z'
  })
  const service = new SceneService(scene, { save })
  const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds('89') })
  const plan = await planner.plan(fixtureAgentRequest(scene, '创建一个 4:5 的视觉封面，主体保持中性，标题是 WIND TRACE，先不要生成图片。'), new AbortController().signal)
  const tool = plan.tools.find((candidate) => candidate.kind === 'scene_batch')
  if (tool?.kind !== 'scene_batch') throw new Error('Expected a Scene batch.')
  const initial = await service.execute({
    expectedSceneRevision: 0,
    batch: { id: '89000000-0000-4000-8000-000000000990', origin: 'agent', summary: tool.summary, commands: tool.commands }
  })
  if (!initial.ok) throw new Error(initial.error.message)
  return service
}

describe('C-S1 Main-authoritative direction transaction', () => {
  it('commits exactly one reversible batch and restores the prior direction with Undo', async () => {
    const saved: number[] = []
    const service = await initializedService(async (scene) => { saved.push(scene.revision) })
    const before = service.state().scene
    const direction = before.creativeContext!.directions![1]!
    const compiled = compileDesignDirectionSelection(before, {
      sourceRunId: '89000000-0000-4000-8000-000000000900',
      briefId: before.creativeContext!.brief.id,
      directionId: direction.id,
      expectedSceneRevision: before.revision,
      resolution: 'strict'
    }, deterministicFixtureIds('90'))
    if (compiled.status !== 'ready') throw new Error(compiled.message)

    const changed = await service.execute({
      expectedSceneRevision: before.revision,
      batch: { id: '90000000-0000-4000-8000-000000000990', origin: 'agent', summary: compiled.summary, commands: compiled.commands }
    })
    expect(changed.ok).toBe(true)
    if (!changed.ok) throw new Error(changed.error.message)
    expect(changed.receipt.batch?.revisionBefore).toBe(before.revision)
    expect(changed.receipt.batch?.revisionAfter).toBe(before.revision + 1)
    expect(changed.receipt.state.scene.creativeContext?.selectedDirectionId).toBe(direction.id)
    expect(changed.receipt.state.scene.creativeContext?.plan.directionId).toBe(direction.id)

    const undone = await service.undo({
      expectedSceneRevision: changed.receipt.state.scene.revision,
      batchId: changed.receipt.affectedBatchId
    })
    expect(undone.ok).toBe(true)
    if (!undone.ok) throw new Error(undone.error.message)
    expect(undone.receipt.state.scene.creativeContext?.selectedDirectionId).toBe(before.creativeContext?.selectedDirectionId)
    expect(undone.receipt.state.scene.elements).toEqual(before.elements)
    expect(saved).toEqual([1, 2, 3])
  })

  it('rolls back the whole selection when durable Scene persistence fails', async () => {
    let fail = false
    const service = await initializedService(async () => {
      if (fail) throw new Error('simulated persistence failure')
    })
    const before = service.state().scene
    const direction = before.creativeContext!.directions![1]!
    const compiled = compileDesignDirectionSelection(before, {
      sourceRunId: '89000000-0000-4000-8000-000000000901',
      briefId: before.creativeContext!.brief.id,
      directionId: direction.id,
      expectedSceneRevision: before.revision,
      resolution: 'strict'
    }, deterministicFixtureIds('91'))
    if (compiled.status !== 'ready') throw new Error(compiled.message)
    fail = true
    const result = await service.execute({
      expectedSceneRevision: before.revision,
      batch: { id: '91000000-0000-4000-8000-000000000990', origin: 'agent', summary: compiled.summary, commands: compiled.commands }
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'SCENE_PERSIST_FAILED' } })
    expect(service.state().scene).toEqual(before)
    expect(service.state().canUndo).toBe(true)
  })
})
