import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAgentPlanner, ArkResponsesLlmProtocol, ConfiguredAgentPlanner, CredentialAwareAgentPlanner } from '../../src/main/agent'
import { ArkSeedreamImageProvider, ARK_SEEDREAM_MODEL } from '../../src/main/generation/ark-seedream-provider'
import { ArkSeedreamProtocol } from '../../src/main/generation/ark-seedream-protocol'
import { ArkHttpClient } from '../../src/main/security/ark-http-client'
import { G2UsageLedger } from '../../src/main/security/g2-usage-ledger'
import type { AgentPlanner } from '../../src/main/agent/planner'
import type { AgentRequest } from '../../src/shared/agent'
import type { EditRequest, GenerationRequest } from '../../src/shared/generation'
import type { AssetMetadata } from '../../src/main/storage/project-repository'
import { DEFAULT_PROVIDER_CONFIG } from '../../src/shared/provider-settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-g2-'))
  roots.push(root)
  return root
}

function agentRequest(text = '请生成一张克制的香水海报'): AgentRequest {
  return {
    text,
    sceneSummary: {
      revision: 0,
      canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, globalStyle: '雅致、柔和光影' },
      elementCount: 0,
      elements: []
    },
    selectedIds: [],
    selectedElements: [],
    attachments: [],
    autoGenerate: false,
    ephemeralAnnotation: null,
    activeGenerationJobId: null
  }
}

function generationRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: '透明香水瓶放在珍珠色台面上，克制、雅致、柔和轮廓光',
    negativePrompt: '杂乱，低清晰度',
    aspectWidth: 4,
    aspectHeight: 5,
    outputWidth: 1024,
    outputHeight: 1280,
    count: 1,
    providerId: 'image-provider',
    model: ARK_SEEDREAM_MODEL,
    references: [],
    parameters: {},
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '',
    ...overrides
  }
}

function metadata(id: string, fileName: string, width: number, height: number, contentHash: string): AssetMetadata {
  return {
    id,
    projectId: '00000000-0000-4000-8000-000000000001',
    relativePath: fileName,
    thumbnailRelativePath: fileName,
    contentHash,
    width,
    height,
    format: 'png',
    hasAlpha: true,
    sourceType: 'imported',
    sourceId: null,
    status: 'available',
    createdAt: '2026-08-10T00:00:00.000Z'
  }
}

describe('G2 Ark live boundary without external requests', () => {
  it('persists request, image and conservative cost reservations across restarts', async () => {
    const root = await temporaryRoot()
    const filePath = join(root, 'g2-usage.json')
    const first = new G2UsageLedger(filePath)
    await first.reserve({ requests: 1, images: 2, costCeilingCny: 2 })
    await first.reserve({ requests: 1, images: 1, costCeilingCny: 1.25 })

    const restarted = new G2UsageLedger(filePath)
    expect(await restarted.snapshot()).toMatchObject({
      authorization: 'volcengine-ark-g2-2026-08-10',
      maxRequests: 5,
      maxImages: 4,
      maxCostCny: 5,
      usedRequests: 2,
      reservedImages: 3,
      reservedCostCny: 3.25
    })
    await expect(restarted.reserve({ requests: 1, images: 2, costCeilingCny: 1 })).rejects.toMatchObject({ code: 'G2_BUDGET_EXCEEDED' })
    await expect(restarted.reserve({ requests: 1, images: 1, costCeilingCny: 2 })).rejects.toMatchObject({ code: 'G2_BUDGET_EXCEEDED' })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ usedRequests: 2, reservedImages: 3 })
  })

  it('rejects unapproved destinations before reading a key, and a missing key before reserving budget', async () => {
    const root = await temporaryRoot()
    const ledger = new G2UsageLedger(join(root, 'ledger.json'))
    const secrets = { get: vi.fn(async () => null) }
    const fetcher = vi.fn<typeof fetch>()
    const client = new ArkHttpClient({ secrets, ledger, fetcher })
    const signal = new AbortController().signal

    await expect(client.postJson({
      url: 'https://example.test/api/v3/responses',
      body: {},
      secretId: 'openai-compatible-llm',
      expectedImages: 0,
      costCeilingCny: 0.25,
      signal,
      timeoutMs: 1_000
    })).rejects.toMatchObject({ code: 'PROVIDER_DESTINATION_DENIED' })
    expect(secrets.get).not.toHaveBeenCalled()

    await expect(client.postJson({
      url: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      expectedImages: 0,
      costCeilingCny: 0.25,
      signal,
      timeoutMs: 1_000
    })).rejects.toMatchObject({ code: 'PROVIDER_KEY_MISSING' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await ledger.snapshot()).toMatchObject({ usedRequests: 0, reservedImages: 0, reservedCostCny: 0 })
  })

  it('reserves before fetch and injects a Main-only bearer header', async () => {
    const root = await temporaryRoot()
    const ledger = new G2UsageLedger(join(root, 'ledger.json'))
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(await ledger.snapshot()).toMatchObject({ usedRequests: 1, reservedCostCny: 0.25 })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-g2-key')
      return new Response(JSON.stringify({ id: 'resp-1', status: 'completed', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const client = new ArkHttpClient({ secrets: { get: async () => 'synthetic-g2-key' }, ledger, fetcher })
    await expect(client.postJson({
      url: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      body: { model: 'fixture' },
      secretId: 'openai-compatible-llm',
      expectedImages: 0,
      costCeilingCny: 0.25,
      signal: new AbortController().signal,
      timeoutMs: 1_000
    })).resolves.toMatchObject({ id: 'resp-1' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses Responses Function Calling for a validated plan and falls back only when no LLM key exists', async () => {
    const protocol = new ArkResponsesLlmProtocol({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-turbo-260628'
    })
    const postJson = vi.fn(async (request: unknown) => {
      expect(request).toMatchObject({ expectedImages: 0, costCeilingCny: 0.25 })
      return {
        id: 'resp-plan',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call-plan',
          name: 'submitAgentPlan',
          arguments: JSON.stringify({
            summary: '生成香水海报',
            response: '已准备创建一张香水海报。',
            nextAction: null,
            tools: [{ kind: 'canvas_generation', originalRequirement: '生成香水海报', providerId: 'wrong', model: 'wrong', count: 1, sourceMessageId: null }]
          })
        }]
      }
    })
    const live = new ArkAgentPlanner({
      protocol,
      http: { postJson },
      assets: { resolveAsset: async () => { throw new Error('No attachment expected') } },
      timeoutMs: 30_000
    })
    const fallback: AgentPlanner = { plan: vi.fn(async () => ({ summary: '离线', response: '离线计划', nextAction: null, tools: [] })) }

    const liveSwitch = new CredentialAwareAgentPlanner({ secrets: { has: async () => true }, live, fallback })
    await expect(liveSwitch.plan(agentRequest(), new AbortController().signal)).resolves.toMatchObject({
      tools: [{ providerId: 'image-provider', model: ARK_SEEDREAM_MODEL }]
    })
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(fallback.plan).not.toHaveBeenCalled()

    const offlineSwitch = new CredentialAwareAgentPlanner({ secrets: { has: async () => false }, live, fallback })
    await expect(offlineSwitch.plan(agentRequest('只聊聊'), new AbortController().signal)).resolves.toMatchObject({ summary: '离线' })
    expect(fallback.plan).toHaveBeenCalledTimes(1)
  })

  it('keeps the LLM available for canvas work but strips paid image tools when the image module is unconfigured', async () => {
    const planner = new ArkAgentPlanner({
      protocol: new ArkResponsesLlmProtocol({
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-seed-2-1-turbo-260628'
      }),
      http: {
        postJson: vi.fn(async () => ({
          id: 'resp-no-image-provider',
          status: 'completed',
          output: [{
            type: 'function_call',
            call_id: 'call-no-image-provider',
            name: 'submitAgentPlan',
            arguments: JSON.stringify({
              summary: '准备生成',
              response: '准备生成一张图片。',
              nextAction: null,
              tools: [{
                kind: 'canvas_generation',
                originalRequirement: '生成一张图片',
                providerId: 'image-provider',
                model: 'unconfigured',
                count: 1,
                sourceMessageId: null
              }]
            })
          }]
        }))
      },
      assets: { resolveAsset: async () => { throw new Error('No attachment expected') } },
      timeoutMs: 30_000,
      imageModel: '',
      imageGenerationAvailable: false
    })

    await expect(planner.plan(agentRequest(), new AbortController().signal)).resolves.toMatchObject({
      tools: [],
      response: expect.stringContaining('图片模型尚未完成配置'),
      nextAction: '在设置中配置图片模型后继续生成。'
    })
  })

  it('reads Product Provider configuration per turn and applies the global auto-generation boundary', async () => {
    const livePlan = vi.fn<AgentPlanner['plan']>(async () => ({ summary: '在线', response: '已规划', nextAction: null, tools: [] }))
    const createLive = vi.fn((): AgentPlanner => ({ plan: livePlan }))
    const config = structuredClone(DEFAULT_PROVIDER_CONFIG)
    config.executionPolicy = { ...config.executionPolicy, autoGenerate: false, maxImagesPerJob: 2 }
    const planner = new ConfiguredAgentPlanner({
      secrets: { has: async () => true },
      config: { read: async () => config },
      createLive,
      fallback: { plan: vi.fn(async () => ({ summary: '离线', response: '离线', nextAction: null, tools: [] })) }
    })

    await expect(planner.plan({ ...agentRequest(), autoGenerate: true }, new AbortController().signal)).resolves.toMatchObject({ summary: '在线' })
    expect(createLive).toHaveBeenCalledWith(config.providers[0], config.providers[1], 2, true)
    expect(livePlan).toHaveBeenCalledWith(expect.objectContaining({ autoGenerate: false }), expect.any(AbortSignal))

    config.providers[1] = { ...config.providers[1], protocol: 'unconfigured' }
    await expect(planner.plan(agentRequest('调整画布构图'), new AbortController().signal)).resolves.toMatchObject({ summary: '在线' })
    expect(createLive).toHaveBeenLastCalledWith(config.providers[0], config.providers[1], 2, false)

    config.providers[1] = { ...config.providers[1], protocol: 'task-images' }
    config.executionPolicy = { ...config.executionPolicy, maxRequestsPerJob: 2 }
    await expect(planner.plan(agentRequest('调整画布构图'), new AbortController().signal)).resolves.toMatchObject({ summary: '在线' })
    expect(createLive).toHaveBeenLastCalledWith(config.providers[0], config.providers[1], 2, false)

    config.providers[0] = { ...config.providers[0], capabilities: { ...config.providers[0].capabilities, toolCalling: false } }
    await expect(planner.plan(agentRequest('调整画布构图'), new AbortController().signal)).resolves.toMatchObject({ summary: '离线' })
  })

  it('runs text generation and visual-guided edit through one bounded Seedream endpoint contract', async () => {
    const root = await temporaryRoot()
    const resultBytes = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 230, g: 220, b: 210, alpha: 1 } }
    }).png().toBuffer()
    const calls: Array<Record<string, unknown>> = []
    const provider = new ArkSeedreamImageProvider({
      protocol: new ArkSeedreamProtocol({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }),
      http: {
        postJson: vi.fn(async (request) => {
          calls.push(request as unknown as Record<string, unknown>)
          return { data: [{ b64_json: resultBytes.toString('base64'), size: '8x8' }], usage: { generated_images: 1 } }
        })
      },
      stagingDirectory: join(root, 'staging'),
      timeoutMs: 120_000
    })
    const stages: string[] = []
    const context = {
      signal: new AbortController().signal,
      onStage: async (stage: 'submitting' | 'generating' | 'localizing') => { stages.push(stage) },
      onExternalTaskId: async () => undefined,
      resolveAsset: async (): Promise<{ asset: AssetMetadata; filePath: string }> => { throw new Error('No asset expected') }
    }
    const generated = await provider.generate(generationRequest(), context)
    expect(generated).toHaveLength(1)
    expect((await sharp(generated[0]!.filePath).metadata()).format).toBe('png')
    expect(calls[0]).toMatchObject({ expectedImages: 1, costCeilingCny: 1 })
    expect(calls[0]?.body).toMatchObject({ model: ARK_SEEDREAM_MODEL, size: '2K', response_format: 'b64_json' })
    expect(stages).toEqual(['submitting', 'generating', 'localizing'])

    const sourcePath = join(root, 'source.png')
    const maskPath = join(root, 'mask.png')
    await writeFile(sourcePath, await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } }
    }).png().toBuffer())
    await writeFile(maskPath, await sharp(Buffer.alloc(8 * 8, 255), { raw: { width: 8, height: 8, channels: 1 } }).png().toBuffer())
    const assets = new Map([
      ['source', { asset: metadata('source', 'source.png', 8, 8, createHash('sha256').update(await readFile(sourcePath)).digest('hex')), filePath: sourcePath }],
      ['mask', { asset: metadata('mask', 'mask.png', 8, 8, createHash('sha256').update(await readFile(maskPath)).digest('hex')), filePath: maskPath }]
    ])
    const editContext = {
      ...context,
      onStage: async () => undefined,
      onExternalTaskId: async () => undefined,
      resolveAsset: async (assetId: string) => {
        const resolved = assets.get(assetId)
        if (resolved === undefined) throw new Error('Unknown asset')
        return resolved
      }
    }
    const edit: EditRequest = {
      ...generationRequest(),
      kind: 'edit',
      prompt: '只把蒙版区域改成珍珠材质',
      sourceAssetId: 'source',
      maskAssetId: 'mask',
      references: [
        { assetId: 'source', intent: 'edit-source', strength: 1 },
        { assetId: 'mask', intent: 'mask', strength: 1 }
      ]
    }
    await expect(provider.edit(edit, editContext)).resolves.toHaveLength(1)
    expect(calls[1]?.body).toMatchObject({ image: expect.any(Array) })
    expect((calls[1]?.body as { image: unknown[] }).image).toHaveLength(2)
    expect(JSON.stringify(calls[1]?.body)).not.toContain('"mask"')
    expect((calls[1]?.body as { prompt: string }).prompt).toContain('红色半透明标记')
  })
})
