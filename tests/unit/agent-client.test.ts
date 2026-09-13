import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, type SceneElement } from '../../src/domain'
import type { DesktopApi } from '../../src/shared/desktop-api'
import { buildTransientAnnotationMasks } from '../../src/shared/ephemeral-annotation'
import { createAgentRequest } from '../../src/renderer/src/agent/agent-client'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'
import { resetWorkspace, useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'

afterEach(() => resetWorkspace())

function imageElement(): Extract<SceneElement, { readonly type: 'image' }> {
  return {
    id: '20000000-0000-4000-8000-000000000081',
    version: ELEMENT_SCHEMA_VERSION,
    type: 'image',
    name: '可编辑原图',
    description: '',
    transform: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'content',
    referencePolicy: 'include',
    assetId: '20000000-0000-4000-8000-000000000082',
    crop: { x: 0, y: 0, width: 1, height: 1 },
    fit: 'cover',
    referenceRole: 'general'
  }
}

describe('renderer Agent request boundary', () => {
  it('only composes a scoped request and leaves tool execution to Main', async () => {
    const target = imageElement()
    resetWorkspace({ ...createNightVeilScene(), elements: [target], relations: [] })
    useWorkspaceStore.getState().setSelection([target.id])
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        listGenerationJobs: vi.fn(async () => [{ id: 'active-job', status: 'generating', results: [] }])
      } as unknown as DesktopApi
    })

    const request = await createAgentRequest('调整选中图片', false, 'selection')
    expect(request).toMatchObject({
      text: '调整选中图片',
      selectedIds: [target.id],
      selectedElements: [target],
      activeGenerationJobId: 'active-job'
    })
    expect(request.attachments).toEqual([
      { kind: 'selection', id: target.id, name: target.name },
      { kind: 'asset', id: target.assetId, name: `${target.name} · 图片参考` }
    ])
  })

  it('builds transient edit/generate/protect masks without mutating Scene state', () => {
    const target = imageElement()
    const scene = { ...createNightVeilScene(), elements: [target], relations: [] }
    const region = (id: string, mode: 'edit' | 'generate' | 'protect') => ({
      id, mode, points: [{ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.6, y: 0.7 }], closed: true, width: 0.015
    })
    const regions = [
      region('21000000-0000-4000-8000-000000000084', 'protect'),
      region('21000000-0000-4000-8000-000000000085', 'edit'),
      region('21000000-0000-4000-8000-000000000086', 'generate')
    ]
    let ids = 90
    const masks = buildTransientAnnotationMasks(scene, target.id, {
      ...regions[0]!,
      targetElementId: target.id,
      regions
    }, () => `21000000-0000-4000-8000-${String(ids++).padStart(12, '0')}`)

    expect(masks.map((mask) => mask.type === 'mask' ? mask.mode : null)).toEqual(['edit', 'generate', 'protect'])
    expect(scene.elements).toEqual([target])
  })

  it('summarizes real Group child IDs so the planner can address the complete hierarchy', async () => {
    const scene = createNightVeilScene()
    const childIds = scene.elements.slice(0, 2).map((element) => element.id)
    const groupId = '20000000-0000-4000-8000-000000000083'
    const bus = new CommandBus(scene)
    const grouped = bus.execute({
      id: '20000000-0000-4000-8000-000000000084',
      origin: 'user',
      summary: '建立语义组件',
      commands: [{
        kind: 'element.group',
        elementIds: childIds,
        group: {
          id: groupId,
          version: ELEMENT_SCHEMA_VERSION,
          type: 'group',
          name: '主体组件',
          description: '需要整体控制、也允许组内编辑的主体组件',
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
    if (!grouped.ok) throw grouped.error
    resetWorkspace(grouped.scene)
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { listGenerationJobs: vi.fn(async () => []) } as unknown as DesktopApi
    })

    const request = await createAgentRequest('调整主体组件', false, 'canvas')
    const summary = request.sceneSummary.elements.find((element) => element.id === groupId)
    expect(summary).toMatchObject({ type: 'group', groupId: null, childIds })
  })
})
