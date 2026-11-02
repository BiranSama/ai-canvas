import { expect, it } from 'vitest'
import { ProviderSettingsService } from '../../src/main/security/provider-settings-service'
import type { ProviderConfigStorePort } from '../../src/main/security/provider-config-store'
import { DEFAULT_PROVIDER_CONFIG, providerConfigFileSchema, type ProviderConfigFile } from '../../src/shared/provider-settings'

class MemoryVault {
  readonly entries = new Map<string, string>()
  async has(id: string): Promise<boolean> { return this.entries.has(id) }
  async set(id: string, secret: string): Promise<void> { this.entries.set(id, secret) }
  async delete(id: string): Promise<void> { this.entries.delete(id) }
}

class MemoryConfigStore implements ProviderConfigStorePort {
  value: ProviderConfigFile = structuredClone(DEFAULT_PROVIDER_CONFIG)
  async read(): Promise<ProviderConfigFile> { return structuredClone(this.value) }
  async write(value: ProviderConfigFile): Promise<void> { this.value = providerConfigFileSchema.parse(value) }
}

const passed = { ok: true, checkedAt: '2026-11-02T01:00:00.000Z', latencyMs: 820, summary: '连上了，工具调用可用。' }

it('reads a v7 file as v8 with no helper models and no checks', () => {
  const v7: Record<string, unknown> = { ...structuredClone(DEFAULT_PROVIDER_CONFIG), version: 7 }
  delete v7.textHelpers
  delete v7.checks
  expect(providerConfigFileSchema.parse(v7)).toMatchObject({ version: 8, textHelpers: { vision: null, backup: null }, checks: {} })
})

it('adds, saves and removes a vision model with its own key, keeping the main one as it was', async () => {
  const vault = new MemoryVault()
  const configs = new MemoryConfigStore()
  const service = new ProviderSettingsService(vault, configs)
  const added = await service.addTextHelper('vision')
  expect(added.textHelpers.vision).toMatchObject({ id: 'text-model-vision', label: '看图模型', baseUrl: '', configured: false, capabilities: { vision: true } })
  expect(added.textHelpers.backup).toBeNull()

  await service.setConfig({ ...added.textHelpers.vision!, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'ark-responses', defaultModel: 'doubao-seed-vision' })
  const keyed = await service.setSecret({ providerId: 'text-model-vision', apiKey: 'vision-key-123456' })
  expect(keyed.textHelpers.vision).toMatchObject({ defaultModel: 'doubao-seed-vision', configured: true })
  expect(keyed.providers[0]).toMatchObject({ id: 'openai-compatible-llm', defaultModel: 'doubao-seed-2-1-turbo-260628' })

  const removed = await service.removeTextHelper('vision')
  expect(removed.textHelpers.vision).toBeNull()
  expect(vault.entries.has('text-model-vision')).toBe(false)
})

it('keeps a check until the address, interface, model or key changes', async () => {
  const service = new ProviderSettingsService(new MemoryVault(), new MemoryConfigStore())
  const checked = await service.recordCheck('openai-compatible-llm', passed)
  expect(checked.checks['openai-compatible-llm']).toEqual(passed)

  // A new name or price is not what was tested.
  const renamed = await service.setConfig({ ...checked.providers[0], label: '主模型' })
  expect(renamed.checks['openai-compatible-llm']).toEqual(passed)

  const moved = await service.setConfig({ ...renamed.providers[0], defaultModel: 'another-model' })
  expect(moved.checks['openai-compatible-llm']).toBeUndefined()

  await service.recordCheck('image-provider', { ...passed, summary: '地址和 Key 可用。' })
  const rekeyed = await service.setSecret({ providerId: 'image-provider', apiKey: 'new-image-key-1' })
  expect(rekeyed.checks['image-provider']).toBeUndefined()
})

it('refuses a helper model under the wrong role and keeps one of each', async () => {
  const configs = new MemoryConfigStore()
  const service = new ProviderSettingsService(new MemoryVault(), configs)
  await service.addTextHelper('backup')
  await service.addTextHelper('backup')
  expect(configs.value.textHelpers.backup?.id).toBe('text-model-backup')
  expect(() => service.addTextHelper('fast')).toThrow()
  const swapped = { ...structuredClone(configs.value), textHelpers: { vision: configs.value.textHelpers.backup, backup: null } }
  expect(providerConfigFileSchema.safeParse(swapped).success).toBe(false)
})
