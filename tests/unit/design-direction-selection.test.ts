import { describe, expect, it } from 'vitest'
import { CommandBus, createScene, type Scene } from '../../src/domain'
import {
  compileDesignDirectionSelection,
  DeterministicMockPlanner,
  selectCreativeDirection
} from '../../src/main/agent'
import { deterministicFixtureIds, fixtureAgentRequest } from '../helpers/semantic-fixtures'

const AMBIGUOUS_REQUEST = '创建一个 4:5 的视觉封面，主体保持中性，标题是 WIND TRACE，先不要生成图片。'

function blankScene(): Scene {
  return createScene({
    id: '73000000-0000-4000-8000-000000000001',
    projectId: '73000000-0000-4000-8000-000000000002',
    now: '2026-09-01T00:00:00.000Z'
  })
}

async function plannedScene(prefix = '73'): Promise<Scene> {
  const scene = blankScene()
  const planner = new DeterministicMockPlanner({ delayMs: 0, idFactory: deterministicFixtureIds(prefix) })
  const plan = await planner.plan(fixtureAgentRequest(scene, AMBIGUOUS_REQUEST), new AbortController().signal)
  const tool = plan.tools.find((candidate) => candidate.kind === 'scene_batch')
  if (tool?.kind !== 'scene_batch') throw new Error('Expected a creative Scene batch.')
  const bus = new CommandBus(scene)
  const result = bus.execute({
    id: `${prefix}000000-0000-4000-8000-000000000998`,
    origin: 'agent',
    summary: tool.summary,
    commands: tool.commands
  })
  if (!result.ok) throw new Error(result.error.message)
  return result.scene
}

describe('C-S1 explicit design direction selection', () => {
  it('compiles three deterministic and materially distinct plans with consistent direction provenance', async () => {
    const scene = await plannedScene('73')
    const current = scene.creativeContext
    if (current?.directions === undefined) throw new Error('Expected design directions.')
    expect(current.directions).toHaveLength(3)

    const selected = current.directions.map((direction, index) => selectCreativeDirection(
      current,
      direction.id,
      deterministicFixtureIds(String(74 + index).padStart(2, '0'))
    ))
    expect(new Set(selected.map((context) => JSON.stringify(
      context.plan.elements.find((element) => element.semanticRole === 'subject')?.normalizedBounds
    ))).size).toBe(3)
    for (const [index, context] of selected.entries()) {
      const direction = current.directions[index]!
      expect(context.selectedDirectionId).toBe(direction.id)
      expect(context.plan.directionId).toBe(direction.id)
      expect(context.plan.elements.every((element) => element.provenance?.sourceDirectionId === direction.id)).toBe(true)
    }
  })

  it('returns to the saved baseline without accumulating transform drift', async () => {
    let scene = await plannedScene('77')
    const original = scene.creativeContext
    if (original?.directions === undefined || original.selectedDirectionId === undefined) throw new Error('Expected design directions.')
    const originalSubject = original.plan.elements.find((element) => element.semanticRole === 'subject')?.normalizedBounds
    const sequence = [original.directions[1]!, original.directions[2]!, original.directions[0]!]

    for (const [index, direction] of sequence.entries()) {
      const compiled = compileDesignDirectionSelection(scene, {
        sourceRunId: '77000000-0000-4000-8000-000000000900',
        briefId: original.brief.id,
        directionId: direction.id,
        expectedSceneRevision: scene.revision,
        resolution: 'strict'
      }, deterministicFixtureIds(String(78 + index).padStart(2, '0')))
      expect(compiled.status).toBe('ready')
      if (compiled.status !== 'ready') throw new Error(compiled.message)
      const bus = new CommandBus(scene)
      const result = bus.execute({
        id: `${String(78 + index).padStart(2, '0')}000000-0000-4000-8000-000000000999`,
        origin: 'agent',
        summary: compiled.summary,
        commands: compiled.commands
      })
      if (!result.ok) throw new Error(result.error.message)
      scene = result.scene
    }

    expect(scene.creativeContext?.selectedDirectionId).toBe(original.selectedDirectionId)
    expect(scene.creativeContext?.plan.elements.find((element) => element.semanticRole === 'subject')?.normalizedBounds).toEqual(originalSubject)
  })

  it('rejects unknown and cross-Brief direction identities without producing commands', async () => {
    const scene = await plannedScene('81')
    const context = scene.creativeContext!
    const base = {
      sourceRunId: '81000000-0000-4000-8000-000000000900',
      expectedSceneRevision: scene.revision,
      resolution: 'strict' as const
    }
    expect(compileDesignDirectionSelection(scene, {
      ...base,
      briefId: '81000000-0000-4000-8000-000000000901',
      directionId: context.directions![1]!.id
    }, deterministicFixtureIds('82'))).toMatchObject({ status: 'rejected', code: 'BRIEF_MISMATCH' })
    expect(compileDesignDirectionSelection(scene, {
      ...base,
      briefId: context.brief.id,
      directionId: '81000000-0000-4000-8000-000000000902'
    }, deterministicFixtureIds('83'))).toMatchObject({ status: 'rejected', code: 'DIRECTION_NOT_FOUND' })
  })

  it('surfaces stale, manual, locked and protect-mask conflicts instead of overwriting', async () => {
    const scene = await plannedScene('84')
    const context = scene.creativeContext!
    const direction = context.directions![1]!
    const input = {
      sourceRunId: '84000000-0000-4000-8000-000000000900',
      briefId: context.brief.id,
      directionId: direction.id,
      expectedSceneRevision: scene.revision,
      resolution: 'strict' as const
    }
    expect(compileDesignDirectionSelection(scene, { ...input, expectedSceneRevision: scene.revision - 1 }, deterministicFixtureIds('85')))
      .toMatchObject({ status: 'conflict', code: 'SCENE_REVISION_CHANGED' })

    const subject = scene.elements.find((element) => element.semanticRole === 'subject')!
    const manualScene = structuredClone(scene)
    manualScene.elements.find((element) => element.id === subject.id)!.transform.x += 0.04
    expect(compileDesignDirectionSelection(manualScene, input, deterministicFixtureIds('86')))
      .toMatchObject({ status: 'conflict', code: 'MANUAL_SCENE_CHANGES' })

    const lockedScene = structuredClone(scene)
    lockedScene.elements.find((element) => element.id === subject.id)!.locked = true
    expect(compileDesignDirectionSelection(lockedScene, input, deterministicFixtureIds('87')))
      .toMatchObject({ status: 'conflict', code: 'PROTECTED_SCENE_CONTENT' })

    const protectedScene = structuredClone(scene)
    protectedScene.elements.push({
      id: '84000000-0000-4000-8000-000000000950',
      version: 1,
      type: 'mask',
      name: '保护主体',
      description: '',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      zIndex: protectedScene.elements.length,
      opacity: 1,
      visible: true,
      locked: false,
      groupId: null,
      semanticRole: 'mask',
      referencePolicy: 'exclude',
      mode: 'protect',
      targetElementId: subject.id,
      paths: [{ id: '84000000-0000-4000-8000-000000000951', points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .2, y: .4 }], closed: true }],
      feather: .1
    })
    expect(compileDesignDirectionSelection(protectedScene, input, deterministicFixtureIds('88')))
      .toMatchObject({ status: 'conflict', code: 'PROTECTED_SCENE_CONTENT' })
  })
})

