import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileProviderConfigStore } from '../../src/main/security/provider-config-store'
import {
  DEFAULT_PROVIDER_CONFIG,
  inferImageProtocol,
  providerConfigFileSchema,
  resolveImageProtocolEndpoint,
  type ProviderConfigFile
} from '../../src/shared/provider-settings'

function asLegacyV3(baseUrl: string): Record<string, unknown> {
  const value = structuredClone(DEFAULT_PROVIDER_CONFIG) as unknown as Record<string, unknown>
  value.version = 3
  const providers = value.providers as Array<Record<string, unknown>>
  delete providers[0]!.reasoningEffort
  delete providers[0]!.imageDetail
  delete providers[0]!.maxOutputTokens
  delete (providers[0]!.capabilities as Record<string, unknown>).vision
  delete providers[1]!.protocol
  providers[1]!.baseUrl = baseUrl
  return value
}

describe('Provider v5 configuration contracts', () => {
  it('keeps exactly one LLM slot and one image slot with explicit protocols', () => {
    expect(DEFAULT_PROVIDER_CONFIG.version).toBe(5)
    expect(DEFAULT_PROVIDER_CONFIG.providers).toHaveLength(2)
    expect(DEFAULT_PROVIDER_CONFIG.providers[0]).toMatchObject({
      kind: 'llm',
      protocol: 'ark-responses',
      reasoningEffort: 'auto',
      imageDetail: 'auto',
      maxOutputTokens: 4_096,
      transport: { mode: 'auto', connectTimeoutMs: 20_000, firstEventTimeoutMs: 30_000, idleTimeoutMs: 30_000 },
      capabilities: { vision: true }
    })
    expect(DEFAULT_PROVIDER_CONFIG.providers[1]).toMatchObject({ kind: 'image', protocol: 'ark-seedream' })
  })

  it('migrates known legacy image endpoints without changing their public values', () => {
    const ark = providerConfigFileSchema.parse(asLegacyV3('https://ark.cn-beijing.volces.com/api/v3'))
    const task = providerConfigFileSchema.parse(asLegacyV3('https://api.krill-ai.net/v1'))

    expect(ark.version).toBe(5)
    expect(ark.providers[1]).toMatchObject({
      protocol: 'ark-seedream',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
    })
    expect(task.providers[1]).toMatchObject({
      protocol: 'task-images',
      baseUrl: 'https://api.krill-ai.net/v1'
    })
  })

  it('does not guess an implementation for an unknown legacy image endpoint', () => {
    const migrated = providerConfigFileSchema.parse(asLegacyV3('https://images.example.test/v1'))
    expect(migrated.version).toBe(5)
    expect(migrated.providers[1]).toMatchObject({
      protocol: 'unconfigured',
      baseUrl: 'https://images.example.test/v1'
    })
    expect(inferImageProtocol('https://images.example.test/v1')).toBe('unconfigured')
  })

  it('reads a legacy file into v5 memory without rewriting the saved file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-provider-v4-'))
    try {
      const filePath = join(root, 'provider-settings.json')
      const legacy = JSON.stringify(asLegacyV3('https://images.example.test/v1'), null, 2)
      await writeFile(filePath, legacy, 'utf8')
      const migrated = await new FileProviderConfigStore(filePath).read()

      expect(migrated).toMatchObject({ version: 5, providers: [{ kind: 'llm' }, { kind: 'image', protocol: 'unconfigured' }] })
      expect(migrated.providers[0]).toMatchObject({
        reasoningEffort: 'auto',
        imageDetail: 'auto',
        maxOutputTokens: 4_096,
        transport: { mode: 'auto', connectTimeoutMs: 20_000, firstEventTimeoutMs: 30_000, idleTimeoutMs: 30_000 },
        capabilities: { vision: false }
      })
      await expect(readFile(filePath, 'utf8')).resolves.toBe(legacy)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps non-streaming v4 capability to buffered and rejects local deadlines above total', () => {
    const legacy = structuredClone(DEFAULT_PROVIDER_CONFIG) as unknown as Record<string, unknown>
    legacy.version = 4
    const providers = legacy.providers as Array<Record<string, unknown>>
    delete providers[0]!.transport
    ;(providers[0]!.capabilities as Record<string, unknown>).streaming = false
    providers[0]!.timeoutMs = 10_000
    const migrated = providerConfigFileSchema.parse(legacy)
    expect(migrated.providers[0].transport).toEqual({
      mode: 'buffered', connectTimeoutMs: 10_000, firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000
    })
    const invalid = structuredClone(DEFAULT_PROVIDER_CONFIG)
    invalid.providers[0].transport.connectTimeoutMs = invalid.providers[0].timeoutMs + 1_000
    expect(() => providerConfigFileSchema.parse(invalid)).toThrow(/局部超时/)
  })

  it('accepts arbitrary labels and models while preserving the two stable credential slot ids', () => {
    const configured: ProviderConfigFile = providerConfigFileSchema.parse({
      ...structuredClone(DEFAULT_PROVIDER_CONFIG),
      version: 5,
      providers: [
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.providers[0]),
          label: 'DeepSeek Planner',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          protocol: 'openai-chat-completions',
          reasoningEffort: 'max',
          imageDetail: 'low',
          maxOutputTokens: 16_384,
          capabilities: { streaming: true, toolCalling: true, vision: true }
        },
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.providers[1]),
          label: 'My Image Relay',
          baseUrl: 'https://relay.example.test/v1',
          defaultModel: 'studio-image-latest',
          protocol: 'openai-images'
        }
      ]
    })
    expect(configured.providers.map((provider) => provider.id)).toEqual([
      'openai-compatible-llm',
      'image-provider'
    ])
    expect(configured.providers[0]).toMatchObject({
      label: 'DeepSeek Planner',
      defaultModel: 'deepseek-chat',
      reasoningEffort: 'max',
      imageDetail: 'low',
      maxOutputTokens: 16_384,
      capabilities: { vision: true }
    })
    expect(configured.providers[1]).toMatchObject({ label: 'My Image Relay', defaultModel: 'studio-image-latest' })
  })

  it('resolves generation and edit endpoints from a version root or direct endpoint', () => {
    expect(resolveImageProtocolEndpoint('https://relay.example.test/v1', 'openai-images', 'generate'))
      .toBe('https://relay.example.test/v1/images/generations')
    expect(resolveImageProtocolEndpoint('https://relay.example.test/v1/images/generations', 'openai-images', 'generate'))
      .toBe('https://relay.example.test/v1/images/generations')
    expect(resolveImageProtocolEndpoint('https://relay.example.test/v1', 'openai-images', 'edit'))
      .toBe('https://relay.example.test/v1/images/edits')
    expect(resolveImageProtocolEndpoint('https://relay.example.test/v1', 'task-images', 'status', 'task-42'))
      .toBe('https://relay.example.test/v1/images/task-42')
    expect(resolveImageProtocolEndpoint('https://relay.example.test/v1', 'task-images', 'content', 'task-42'))
      .toBe('https://relay.example.test/v1/images/task-42/content')
  })
})
