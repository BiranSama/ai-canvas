import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentContextRepository, AgentHarnessRepository, OutboundContextService } from '../../src/main/agent'
import type { AgentContextRepositoryError } from '../../src/main/agent'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []

function idFactory(): () => string {
  let value = 15_000
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ah1-s5-'))
  roots.push(root)
  const ids = idFactory()
  const projectDirectory = join(root, 'context.aicanvas')
  const opened = await ProjectWorkspace.create(projectDirectory, 'Context project', { idFactory: ids })
  const databasePath = join(projectDirectory, 'project.db')
  const harness = new AgentHarnessRepository(databasePath, { idFactory: ids, now: () => '2026-08-22T14:00:00.000+08:00' })
  const context = new AgentContextRepository(databasePath, { idFactory: ids, now: () => '2026-08-22T14:00:00.000+08:00' })
  closers.push(async () => {
    await context.close().catch(() => undefined)
    await harness.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  const projectId = opened.workspace.metadata.id
  const thread = await harness.ensureThread(projectId)
  const turn = await harness.startTurn(thread.id, { goalId: null, inputMessageId: 'run-1', sceneRevisionAtStart: 3 })
  return { context, harness, ids, projectId, thread, turn }
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('AH1 S5 context and memory repository', () => {
  it('uses minimal outbound by default and rejects stale policy writes', async () => {
    const value = await fixture()
    await expect(value.context.getSettings(value.projectId)).resolves.toEqual({ outboundPolicy: 'minimal', version: 1 })
    await expect(value.context.setOutboundPolicy(value.projectId, {
      policy: 'local_only', expectedVersion: 1
    })).resolves.toEqual({ outboundPolicy: 'local_only', version: 2 })
    await expect(value.context.setOutboundPolicy(value.projectId, {
      policy: 'review_each_image', expectedVersion: 1
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' } satisfies Partial<AgentContextRepositoryError>)
  })

  it('versions directives and preserves edited memory as a superseding entry', async () => {
    const value = await fixture()
    const directive = await value.context.createDirective(value.projectId, {
      text: '品牌名必须保留英文', category: 'content', priority: 200, sourceMessageId: 'message-1'
    })
    const changed = await value.context.updateDirective(value.projectId, {
      id: directive.id, expectedVersion: 1, priority: 300
    })
    expect(changed).toMatchObject({ version: 2, priority: 300, enabled: true })
    await expect(value.context.updateDirective(value.projectId, {
      id: directive.id, expectedVersion: 1, enabled: false
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    const memory = await value.context.createMemory(value.projectId, {
      kind: 'direction', content: '采用克制的冷蓝色调', sourceType: 'user', sourceId: 'message-1', confidence: 1,
      supersedesId: null
    })
    const successor = await value.context.updateMemory(value.projectId, {
      id: memory.id, expectedVersion: 1, content: '采用克制的银蓝色调'
    })
    expect(successor).toMatchObject({ version: 2, supersedesId: memory.id, content: '采用克制的银蓝色调' })
    expect(await value.context.listMemories(value.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: memory.id, status: 'disabled', version: 2 }),
      expect.objectContaining({ id: successor.id, status: 'active', supersedesId: memory.id })
    ]))
  })

  it('keeps inferred memory pending until explicit confirmation', async () => {
    const value = await fixture()
    const candidate = await value.context.createCandidate(value.projectId, {
      kind: 'choice', content: '用户可能偏好 4:5', sourceType: 'planner', sourceId: value.turn.id, confidence: 0.72
    })
    expect((await value.context.listMemories(value.projectId)).some((entry) => entry.content.includes('4:5'))).toBe(false)
    const confirmed = await value.context.resolveCandidate(value.projectId, {
      id: candidate.id, expectedVersion: 1, resolution: 'confirm'
    })
    expect(confirmed).toMatchObject({ status: 'confirmed', version: 2, confirmedMemoryId: expect.any(String) })
    expect(await value.context.listMemories(value.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'candidate', sourceId: candidate.id, status: 'active' })
    ]))
  })

  it('persists multiple immutable manifests for replans and records outbound scope without secrets', async () => {
    const value = await fixture()
    const first = await value.context.createManifest({
      projectId: value.projectId,
      threadId: value.thread.id,
      turnId: value.turn.id,
      sceneRevision: 3,
      outboundPolicy: 'minimal',
      entries: [{
        sourceType: 'user', sourceId: 'message-1', version: null, scope: 'current_turn',
        disposition: 'inline', reason: '当前明确请求优先', content: { text: '把标题缩小' }, estimatedBytes: 24
      }],
      estimatedTextBytes: 24,
      imageCount: 0,
      sourceHash: 'a'.repeat(64)
    })
    const second = await value.context.createManifest({
      projectId: value.projectId,
      threadId: value.thread.id,
      turnId: value.turn.id,
      sceneRevision: 4,
      outboundPolicy: 'minimal',
      entries: [{
        sourceType: 'scene', sourceId: 'scene-summary', version: 4, scope: 'current_project',
        disposition: 'inline', reason: '重规划读取最新 Scene revision', content: { revision: 4 }, estimatedBytes: 14
      }],
      estimatedTextBytes: 14,
      imageCount: 0,
      sourceHash: 'b'.repeat(64)
    })
    expect(first.id).not.toBe(second.id)
    await expect(value.context.getLatestManifest(value.projectId)).resolves.toMatchObject({ id: second.id, sceneRevision: 4 })

    const outbound = await value.context.createOutboundRecord({
      projectId: value.projectId, threadId: value.thread.id, turnId: value.turn.id, manifestId: second.id,
      policy: 'minimal', dataTypes: ['user_text', 'scene_summary'], imageAssetIds: [], textBytes: 120,
      imageCount: 0, status: 'prepared', reason: 'Mock planner local contract test'
    })
    expect(JSON.stringify(outbound)).not.toMatch(/api[-_]?key|authorization|bearer/i)
    await expect(value.context.transitionOutboundRecord(outbound.id, 'blocked', '真实 API 未授权')).resolves.toMatchObject({
      status: 'blocked', reason: '真实 API 未授权'
    })
  })

  it('deduplicates compaction by its retained ledger source hash', async () => {
    const value = await fixture()
    const input = {
      projectId: value.projectId, threadId: value.thread.id,
      sourceSequenceFrom: 1, sourceSequenceTo: 7, sourceHash: 'c'.repeat(64),
      summary: '用户建立画布并明确保留英文品牌名。'
    }
    const first = await value.context.createCompaction(input)
    const regenerated = await value.context.createCompaction(input)
    expect(regenerated.id).toBe(first.id)
    expect(await value.context.listCompactions(value.thread.id)).toEqual([first])
    expect((await value.harness.replayEvents(value.thread.id, 0)).length).toBeGreaterThan(0)
  })

  it('records a blocked image scope before any provider adapter could run', async () => {
    const value = await fixture()
    await value.context.setOutboundPolicy(value.projectId, { policy: 'local_only', expectedVersion: 1 })
    const manifest = await value.context.createManifest({
      projectId: value.projectId, threadId: value.thread.id, turnId: value.turn.id,
      sceneRevision: 3, outboundPolicy: 'local_only', estimatedTextBytes: 48, imageCount: 0,
      sourceHash: 'd'.repeat(64),
      entries: [{
        sourceType: 'user', sourceId: 'message-1', version: null, scope: 'current_turn',
        disposition: 'inline', reason: '当前请求', content: { text: '参考这张图' }, estimatedBytes: 48
      }]
    })
    const service = new OutboundContextService(value.context)
    const approval = await value.harness.appendItem(value.turn.id, {
      type: 'decision', status: 'completed', payloadVersion: 1,
      payload: { proposal: { kind: 'clarification' }, optionId: 'apply_once' }
    })
    const record = await service.prepare({
      projectId: value.projectId, threadId: value.thread.id, turnId: value.turn.id, manifestId: manifest.id,
      providerId: 'external-image', model: 'image-1', dataTypes: ['user_text', 'reference_image'],
      imageAssetIds: ['00000000-0000-4000-8000-000000009999'], textBytes: 48,
      imageBytes: 12_345,
      approvalId: approval.id,
      requestCorrelationId: 'tool-call-item-7',
      providerLocal: false, permissionAllowsExternal: true
    })
    expect(record).toMatchObject({
      policy: 'local_only', status: 'blocked', imageCount: 1, imageBytes: 12_345,
      approvalId: approval.id, requestCorrelationId: 'tool-call-item-7'
    })
    expect(await value.context.listOutboundRecords(value.projectId)).toEqual([record])
  })
})
