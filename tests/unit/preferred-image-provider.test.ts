import { expect, it } from 'vitest'
import { chooseImageProvider } from '../../src/renderer/src/generation/preferred-provider'
import { DEFAULT_PROVIDER_CONFIG, type ProviderSettingsSnapshot } from '../../src/shared/provider-settings'
import type { GenerationProfileSnapshot } from '../../src/shared/generation'

const [llm, primary] = DEFAULT_PROVIDER_CONFIG.providers
const grok = { ...primary, id: 'image-provider-grok1', label: 'Grok Imagine', protocol: 'openai-images' as const, defaultModel: 'grok-imagine-image', baseUrl: 'https://api.x.ai/v1' }

function settings(defaultImageProviderId = 'image-provider-grok1'): ProviderSettingsSnapshot {
  return {
    providers: [{ ...llm, configured: true }, { ...primary, configured: true }, { ...grok, configured: true }],
    defaultImageProviderId,
    realCallsAuthorized: true,
    executionPolicy: DEFAULT_PROVIDER_CONFIG.executionPolicy,
    textHelpers: { vision: null, backup: null },
    checks: {}
  }
}

function profiles(entries: ReadonlyArray<{ readonly providerId: string; readonly operations: readonly string[] }>): GenerationProfileSnapshot {
  return {
    realCallsAuthorized: true,
    profiles: entries.map(({ providerId, operations }) => ({ status: 'available', profile: { id: `${providerId}-draft`, providerId, supportedOperations: operations } }))
  } as unknown as GenerationProfileSnapshot
}

const both = profiles([{ providerId: 'image-provider-grok1', operations: ['generate'] }, { providerId: 'image-provider', operations: ['generate', 'reference', 'edit'] }])

it('uses the default service when it can do the job', () => {
  expect(chooseImageProvider('generate', settings(), both)).toMatchObject({ providerId: 'image-provider-grok1', confirmed: true, note: null })
})

it('uses another set-up service that can, and says so, when the default cannot', () => {
  expect(chooseImageProvider('edit', settings(), both)).toMatchObject({
    providerId: 'image-provider', profileId: 'image-provider-draft', confirmed: true,
    note: '默认的Grok Imagine不能做局部修改，这次用火山方舟 · Seedream 5.0。'
  })
})

it('falls back to the local sketch, and says why, only when no service can', () => {
  const generateOnly = profiles([{ providerId: 'image-provider-grok1', operations: ['generate'] }])
  expect(chooseImageProvider('edit', settings(), generateOnly)).toMatchObject({ providerId: 'mock', confirmed: false, note: '设置里的生图服务都不能做局部修改，这次用本地草图。' })
  const unsetUp = { ...settings(), providers: settings().providers.map((provider) => ({ ...provider, configured: false })) }
  expect(chooseImageProvider('edit', unsetUp, both)).toMatchObject({ providerId: 'mock', note: null })
})
