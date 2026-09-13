import { describe, expect, it } from 'vitest'
import { GenerationProfileRegistry, validateGenerationProfile } from '../../src/main/generation/generation-profiles'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import { ProviderRegistry } from '../../src/main/generation/provider'
import type { GenerationProfile, GenerationProfileRequest } from '../../src/shared/generation'

const allCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
  multipleReferences: true,
  transparentOutput: false,
  maxImages: 4,
  supportedRatios: ['custom'],
  supportedFormats: ['png' as const]
}

function request(profileId = 'mock-draft', confirmed = false): GenerationProfileRequest {
  return {
    profileId,
    confirmed,
    operation: 'generate',
    draft: {
      prompt: 'Quiet botanical editorial poster',
      negativePrompt: 'visual clutter',
      aspect: { width: 4, height: 5 },
      quantity: profileId === 'mock-draft' ? 4 : 2,
      profileId,
      referenceResultIds: [],
      sourceSceneRevision: 2,
      referenceMode: 'hybrid',
      variationInstruction: '',
      preserveConstraints: '',
      expandedSections: ['parameters']
    },
    outputWidth: 1024,
    outputHeight: 1280,
    references: [],
      parameters: { fixture: true },
      sourceMessageId: null,
    parentResultId: null,
    modelOverride: null
  }
}

const configuredProvider = {
  id: 'image-provider',
  label: 'Configured image provider',
  capabilities: allCapabilities,
  generate: async () => [],
  edit: async () => []
}

describe('generation profile registry', () => {
  it('publishes offline profiles without phantom locked profiles when no real provider exists', () => {
    const profiles = new GenerationProfileRegistry(
      new ProviderRegistry([new MockImageProvider('unused')]),
      { mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout'] }
    )
    const snapshot = profiles.snapshot()
    expect(snapshot.realCallsAuthorized).toBe(false)
    expect(snapshot.profiles.filter((entry) => entry.status === 'available').map((entry) => entry.profile.id)).toEqual([
      'local-sketch', 'mock-draft', 'mock-final'
    ])
    expect(snapshot.profiles).toHaveLength(3)
    expect(snapshot.profiles.filter((entry) => entry.status === 'locked')).toHaveLength(0)
  })

  it('publishes dynamic Product profiles for the configured provider and its declared capabilities', () => {
    const profiles = new GenerationProfileRegistry(
      new ProviderRegistry([new MockImageProvider('unused'), configuredProvider]),
      {
        mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout'],
        'image-provider': ['studio-image-1']
      }
    )
    const snapshot = profiles.snapshot()
    expect(snapshot.realCallsAuthorized).toBe(true)
    expect(snapshot.profiles.filter((entry) => entry.status === 'available').map((entry) => entry.profile.id)).toEqual([
      'local-sketch', 'mock-draft', 'mock-final',
      'configured-draft', 'configured-final', 'configured-layer'
    ])
    expect(snapshot.profiles.find((entry) => entry.profile.id === 'configured-final')).toMatchObject({
      profile: { providerId: 'image-provider', modelId: 'studio-image-1', simulated: false }
    })
  })

  it('compiles profile-owned provider, model, budget summary and source facts', () => {
    const profiles = new GenerationProfileRegistry(
      new ProviderRegistry([new MockImageProvider('unused')]),
      { mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout'] }
    )
    expect(profiles.compile(request())).toMatchObject({
      providerId: 'mock',
      model: 'mock-balanced',
      count: 4,
      prompt: 'Quiet botanical editorial poster',
      parameters: {
        fixture: true,
        generationProfileId: 'mock-draft',
        generationProfileTier: 'draft',
        simulatedEstimatedCostCny: .16,
        actualCostCny: 0,
        budgetPolicyId: 'mock-draft-simulation'
      }
    })
  })

  it('requires final confirmation and refuses unavailable profiles, excess batches and unregistered overrides', () => {
    const profiles = new GenerationProfileRegistry(
      new ProviderRegistry([new MockImageProvider('unused')]),
      { mock: ['mock-balanced', 'mock-slow', 'mock-failure', 'mock-timeout'] }
    )
    expect(() => profiles.compile(request('mock-final'))).toThrowError(expect.objectContaining({ code: 'PROFILE_CONFIRMATION_REQUIRED', stage: 'validating' }))
    expect(profiles.compile(request('mock-final', true))).toMatchObject({ count: 2, parameters: { simulatedEstimatedCostCny: .44, actualCostCny: 0 } })
    expect(() => profiles.compile(request('configured-final', true))).toThrowError(expect.objectContaining({ code: 'PROFILE_NOT_FOUND', stage: 'validating' }))
    expect(() => profiles.compile({ ...request(), draft: { ...request().draft, quantity: 5 } })).toThrow()
    expect(() => profiles.compile({ ...request(), modelOverride: 'unregistered-image-model' })).toThrowError(expect.objectContaining({ code: 'PROFILE_MODEL_UNREGISTERED' }))
  })

  it('rejects missing providers, language-only capabilities and invalid image capability claims', () => {
    const base: GenerationProfile = {
      id: 'fixture',
      label: 'Fixture',
      tier: 'draft',
      providerId: 'llm-only',
      modelId: 'text-model',
      supportedOperations: ['generate'],
      defaultQuantity: 1,
      maxQuantity: 1,
      requireConfirmation: false,
      simulated: true,
      estimatedUnitCostCny: 0,
      budgetPolicyId: 'fixture'
    }
    expect(() => validateGenerationProfile(base, [])).toThrowError(expect.objectContaining({ code: 'INVALID_GENERATION_PROFILE' }))
    expect(() => validateGenerationProfile(base, [{ id: 'llm-only', models: ['text-model'], capabilities: { ...allCapabilities, textToImage: false } }]))
      .toThrow(/text-to-image/)
    expect(() => validateGenerationProfile({ ...base, providerId: 'image', modelId: 'unknown' }, [{ id: 'image', models: ['image-model'], capabilities: allCapabilities }]))
      .toThrow(/not registered/)
  })
})
