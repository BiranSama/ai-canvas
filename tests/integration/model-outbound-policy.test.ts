import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentContextRepository,
  AgentHarnessRepository,
  DeterministicCreativePlannerAdapter,
  PersistentAgentLoop
} from '../../src/main/agent'
import { ArkAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { ResponsesLlmProtocol } from '../../src/main/agent/ark-responses-protocol'
import { isLocalModelEndpoint } from '../../src/main/agent/model-outbound-gate'
import type { AssetMetadata } from '../../src/main/storage/project-repository'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { agentRequestSchema, type AgentRequest } from '../../src/shared/agent'
import type { OutboundContextPolicy } from '../../src/shared/agent-context'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
const ASSET_ID = '00000000-0000-4000-8000-0000000a55e7'

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function idFactory(start: number): () => string {
  let value = start
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function request(withImage: boolean): AgentRequest {
  return agentRequestSchema.parse({
    text: '看看这张参考图，聊聊构图',
    sceneSummary: {
      revision: 0,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: withImage ? [{ kind: 'asset', id: ASSET_ID, name: '参考图' }] : [],
    ephemeralAnnotation: null,
    autoGenerate: false,
    activeGenerationJobId: null
  })
}

const PLAN_RESPONSE = {
  id: 'resp-outbound',
  status: 'completed',
  output: [{
    type: 'function_call',
    call_id: 'call-plan',
    name: 'submitAgentPlan',
    arguments: JSON.stringify({ summary: '讨论构图', response: '主体可以再往下放一点。', nextAction: null, tools: [] })
  }]
}

async function fixture(policy: OutboundContextPolicy, endpoint = 'https://llm.example.test/v1/responses', startId = 31_000) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-model-outbound-'))
  roots.push(root)
  const ids = idFactory(startId)
  const directory = join(root, 'outbound.aicanvas')
  const opened = await ProjectWorkspace.create(directory, 'Outbound policy', { idFactory: ids })
  const databasePath = join(directory, 'project.db')
  const harness = new AgentHarnessRepository(databasePath, { idFactory: ids })
  const context = new AgentContextRepository(databasePath, { idFactory: ids })
  const projectId = opened.workspace.metadata.id
  if (policy !== 'minimal') await context.setOutboundPolicy(projectId, { policy, expectedVersion: 1 })
  const imagePath = join(root, 'reference.png')
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64'))
  const sent: Record<string, unknown>[] = []
  const postLlmJson = vi.fn(async (body: { readonly body: Record<string, unknown>; readonly observe?: (event: never) => unknown }) => {
    sent.push(body.body)
    await body.observe?.({ phase: 'connecting', elapsedMs: 0, lastTransportActivityAt: null, lastSemanticProgressAt: null,
      receivedBytes: 0, recognizedEventCount: 0, providerResponseId: null, httpStatus: null, failureCode: null } as never)
    return PLAN_RESPONSE
  })
  const planner = new ArkAgentPlanner({
    protocol: new ResponsesLlmProtocol({ baseUrl: 'https://llm.example.test/v1', model: 'fixture-model', vision: true, streaming: false }),
    http: { postJson: async () => { throw new Error('unused') }, postLlmJson },
    assets: { resolveAsset: async () => ({ asset: { format: 'png' } as AssetMetadata, filePath: imagePath }) },
    timeoutMs: 30_000,
    model: 'fixture-model',
    endpoint
  })
  const loop = new PersistentAgentLoop({
    projectId,
    repository: harness,
    contextRepository: context,
    planner: new DeterministicCreativePlannerAdapter(planner),
    executeTool: async (_tool, toolContext) => ({
      toolIndex: toolContext.toolIndex, ok: true, batchId: null, jobId: null, affectedElementIds: [], message: 'unused'
    }),
    loadRequest: async () => request(true),
    allowedTools: ['scene.get_summary', 'scene.get_elements', 'scene.apply_batch']
  })
  await loop.initialize()
  closers.push(async () => {
    await loop.close().catch(() => undefined)
    await opened.workspace.close(true).catch(() => undefined)
  })
  const run = async (withImage: boolean) => {
    const turn = await loop.start({ legacyRunId: ids(), sourceMessageId: 'message-outbound', request: request(withImage) })
    await loop.waitForIdle()
    return (await loop.snapshot()).turns.find((candidate) => candidate.id === turn.id)!
  }
  return { run, sent, postLlmJson, context, projectId }
}

function sentImages(body: Record<string, unknown>): number {
  return JSON.stringify(body.input).split('"input_image"').length - 1
}

describe('outbound policy on text-model calls', () => {
  it('sends nothing under local_only and explains why', async () => {
    const value = await fixture('local_only')
    const turn = await value.run(true)
    expect(value.postLlmJson).not.toHaveBeenCalled()
    expect(turn).toMatchObject({ status: 'failed', errorCode: 'OUTBOUND_POLICY_BLOCKED' })
    expect(turn.errorMessage).toContain('仅本地')
    expect(await value.context.listOutboundRecords(value.projectId)).toEqual([
      expect.objectContaining({ policy: 'local_only', status: 'blocked', providerId: 'openai-compatible-llm', imageCount: 1 })
    ])
  })

  it('lets a model on this machine through under local_only', async () => {
    const value = await fixture('local_only', 'https://127.0.0.1:8443/v1/responses', 32_000)
    const turn = await value.run(false)
    expect(value.postLlmJson).toHaveBeenCalledTimes(1)
    expect(turn.status).not.toBe('failed')
    expect(await value.context.listOutboundRecords(value.projectId)).toEqual([expect.objectContaining({ status: 'sent' })])
  })

  it('keeps unreviewed images local under per-image review and still sends the text', async () => {
    const value = await fixture('review_each_image', undefined, 33_000)
    await value.run(true)
    expect(value.postLlmJson).toHaveBeenCalledTimes(1)
    expect(sentImages(value.sent[0]!)).toBe(0)
    const records = await value.context.listOutboundRecords(value.projectId)
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'blocked', imageCount: 1 }),
      expect.objectContaining({ status: 'sent', imageCount: 0 })
    ]))
  })

  it('records and sends images under the default policy', async () => {
    const value = await fixture('minimal', undefined, 34_000)
    await value.run(true)
    expect(sentImages(value.sent[0]!)).toBe(1)
    expect(await value.context.listOutboundRecords(value.projectId)).toEqual([
      expect.objectContaining({ policy: 'minimal', status: 'sent', imageCount: 1, dataTypes: expect.arrayContaining(['user_text', 'reference_image']) })
    ])
  })

  it('treats only loopback addresses as local', () => {
    expect(isLocalModelEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalModelEndpoint('https://127.0.0.1/v1')).toBe(true)
    expect(isLocalModelEndpoint('http://[::1]:8080/v1')).toBe(true)
    expect(isLocalModelEndpoint('https://192.168.1.20/v1')).toBe(false)
    expect(isLocalModelEndpoint('https://localhost.example.com/v1')).toBe(false)
  })
})
