import {
  generationProfileRequestSchema,
  generationProfileSchema,
  generationProfileSnapshotSchema,
  type GenerationProfile,
  type GenerationProfileRequest,
  type GenerationProfileSnapshot,
  type GenerationRequest,
  type ProviderCapabilities
} from '../../shared/generation'
import { ProviderError, type ProviderRegistry } from './provider'

export interface ProfileProviderDescriptor {
  readonly id: string
  readonly models: readonly string[]
  readonly capabilities: ProviderCapabilities
}

const LOCAL_PROFILES: readonly GenerationProfile[] = [
  {
    id: 'local-sketch', label: '本地草图', tier: 'local-sketch', providerId: 'mock', modelId: 'mock-balanced',
    supportedOperations: ['generate', 'reference', 'edit', 'multi-image'], defaultQuantity: 1, maxQuantity: 4,
    requireConfirmation: false, simulated: true, estimatedUnitCostCny: 0, budgetPolicyId: 'local-zero-cost'
  },
  {
    id: 'mock-draft', label: '本地草稿', tier: 'draft', providerId: 'mock', modelId: 'mock-balanced',
    supportedOperations: ['generate', 'reference', 'edit', 'multi-image'], defaultQuantity: 4, maxQuantity: 4,
    requireConfirmation: false, simulated: true, estimatedUnitCostCny: .04, budgetPolicyId: 'mock-draft-simulation'
  },
  {
    id: 'mock-final', label: '本地定稿预演', tier: 'final', providerId: 'mock', modelId: 'mock-balanced',
    supportedOperations: ['generate', 'reference', 'edit', 'multi-image'], defaultQuantity: 2, maxQuantity: 4,
    requireConfirmation: true, simulated: true, estimatedUnitCostCny: .22, budgetPolicyId: 'mock-final-simulation'
  }
].map((profile) => generationProfileSchema.parse(profile))

function productProfiles(provider: ProfileProviderDescriptor, singleRealProvider: boolean): readonly GenerationProfile[] {
  const modelId = provider.models[0]
  if (modelId === undefined || !provider.capabilities.textToImage) return []
  const prefix = singleRealProvider ? 'configured' : provider.id
  const operations: GenerationProfile['supportedOperations'][number][] = ['generate']
  if (provider.capabilities.imageReferences) operations.push('reference')
  if (provider.capabilities.maskEditing) operations.push('edit')
  if (provider.capabilities.multipleReferences && provider.capabilities.maxImages > 1) operations.push('multi-image')
  const maxQuantity = Math.max(1, provider.capabilities.maxImages)
  const profiles: GenerationProfile[] = [
    generationProfileSchema.parse({
      id: `${prefix}-draft`, label: maxQuantity > 1 ? '多候选探索' : '单张生成', tier: 'draft', providerId: provider.id, modelId,
      supportedOperations: operations, defaultQuantity: Math.min(4, maxQuantity), maxQuantity,
      requireConfirmation: false, simulated: false, estimatedUnitCostCny: null,
      budgetPolicyId: 'product-provider-policy'
    }),
    generationProfileSchema.parse({
      id: `${prefix}-final`, label: '单张生成', tier: 'final', providerId: provider.id, modelId,
      supportedOperations: operations, defaultQuantity: 1, maxQuantity: 1,
      requireConfirmation: true, simulated: false, estimatedUnitCostCny: null,
      budgetPolicyId: 'product-provider-policy'
    })
  ]
  if (provider.capabilities.imageReferences && provider.capabilities.maskEditing) {
    profiles.push(generationProfileSchema.parse({
      id: `${prefix}-layer`, label: '局部编辑', tier: 'final', providerId: provider.id, modelId,
      supportedOperations: ['reference', 'edit'], defaultQuantity: 1, maxQuantity: 1,
      requireConfirmation: true, simulated: false, estimatedUnitCostCny: null,
      budgetPolicyId: 'product-provider-policy'
    }))
  }
  return profiles
}

function validateAgainstProvider(profile: GenerationProfile, provider: ProfileProviderDescriptor | undefined): string | null {
  if (provider === undefined) return `Profile “${profile.label}” does not reference an available image provider.`
  if (!provider.models.includes(profile.modelId)) return `Profile “${profile.label}” references a model that is not registered for its image provider.`
  if (profile.maxQuantity > provider.capabilities.maxImages) return `Profile “${profile.label}” exceeds the provider image limit.`
  if (profile.supportedOperations.includes('generate') && !provider.capabilities.textToImage) return `Profile “${profile.label}” requires text-to-image capability.`
  if (profile.supportedOperations.includes('reference') && !provider.capabilities.imageReferences) return `Profile “${profile.label}” requires image-reference capability.`
  if (profile.supportedOperations.includes('edit') && !provider.capabilities.maskEditing) return `Profile “${profile.label}” requires mask-edit capability.`
  if (profile.supportedOperations.includes('multi-image') && (!provider.capabilities.multipleReferences || provider.capabilities.maxImages < 2)) return `Profile “${profile.label}” requires multi-image capability.`
  return null
}

export function validateGenerationProfile(profileValue: unknown, providers: readonly ProfileProviderDescriptor[]): GenerationProfile {
  const profile = generationProfileSchema.parse(profileValue)
  const problem = validateAgainstProvider(profile, providers.find((provider) => provider.id === profile.providerId))
  if (problem !== null) throw new ProviderError('INVALID_GENERATION_PROFILE', problem, 'validating')
  return profile
}

export class GenerationProfileRegistry {
  readonly #providerRegistry: ProviderRegistry
  readonly #providerModels: Map<string, readonly string[]>

  constructor(providerRegistry: ProviderRegistry, providerModels: Readonly<Record<string, readonly string[]>>) {
    this.#providerRegistry = providerRegistry
    this.#providerModels = new Map(Object.entries(providerModels))
    const descriptors = this.#descriptors()
    for (const profile of LOCAL_PROFILES) validateGenerationProfile(profile, descriptors)
  }

  setProviderModels(providerId: string, models: readonly string[]): void {
    this.#providerModels.set(providerId, [...new Set(models)])
  }

  #descriptors(): readonly ProfileProviderDescriptor[] {
    return this.#providerRegistry.list().map((provider) => ({
      id: provider.id,
      models: this.#providerModels.get(provider.id) ?? [],
      capabilities: provider.capabilities
    }))
  }

  snapshot(): GenerationProfileSnapshot {
    const descriptors = this.#descriptors()
    const realProviders = descriptors.filter((provider) => provider.id !== 'mock')
    const dynamicProfiles = realProviders.flatMap((provider) => productProfiles(provider, realProviders.length === 1))
    return generationProfileSnapshotSchema.parse({
      realCallsAuthorized: realProviders.length > 0,
      profiles: [
        ...LOCAL_PROFILES.map((profile) => {
          const problem = validateAgainstProvider(profile, descriptors.find((provider) => provider.id === profile.providerId))
          return { profile, status: problem === null ? 'available' as const : 'invalid' as const, reason: problem, actualUnitCostCny: 0 }
        }),
        ...dynamicProfiles.map((profile) => {
          const problem = validateAgainstProvider(profile, descriptors.find((provider) => provider.id === profile.providerId))
          return {
            profile,
            status: problem === null ? 'available' as const : 'invalid' as const,
            reason: problem,
            actualUnitCostCny: null
          }
        })
      ]
    })
  }

  compile(inputValue: unknown): GenerationRequest {
    const input: GenerationProfileRequest = generationProfileRequestSchema.parse(inputValue)
    const availability = this.snapshot().profiles.find((candidate) => candidate.profile.id === input.profileId)
    if (availability === undefined) throw new ProviderError('PROFILE_NOT_FOUND', `Generation profile “${input.profileId}” does not exist.`, 'validating')
    if (availability.status !== 'available') throw new ProviderError('PROFILE_LOCKED', availability.reason ?? 'This generation profile is unavailable.', 'validating')
    const profile = validateGenerationProfile(availability.profile, this.#descriptors())
    if (!profile.supportedOperations.includes(input.operation)) throw new ProviderError('PROFILE_OPERATION_UNSUPPORTED', `${profile.label} does not support ${input.operation}.`, 'validating')
    if (input.draft.quantity > profile.maxQuantity) throw new ProviderError('PROFILE_QUANTITY_EXCEEDED', `${profile.label} allows at most ${profile.maxQuantity} images.`, 'validating')
    if (profile.requireConfirmation && !input.confirmed) throw new ProviderError('PROFILE_CONFIRMATION_REQUIRED', `${profile.label} requires explicit confirmation.`, 'validating')
    const provider = this.#providerRegistry.get(profile.providerId)
    if (input.references.length > 0 && !provider.capabilities.imageReferences) throw new ProviderError('PROFILE_REFERENCE_UNSUPPORTED', `${profile.label} does not support references.`, 'validating')
    if (input.references.length > 1 && !provider.capabilities.multipleReferences) throw new ProviderError('PROFILE_MULTI_REFERENCE_UNSUPPORTED', `${profile.label} does not support multiple references.`, 'validating')
    const model = input.modelOverride ?? profile.modelId
    if (!(this.#providerModels.get(profile.providerId) ?? []).includes(model)) {
      throw new ProviderError('PROFILE_MODEL_UNREGISTERED', `Model “${model}” is not registered for ${profile.label}.`, 'validating')
    }
    return {
      prompt: input.draft.prompt,
      negativePrompt: input.draft.negativePrompt,
      aspectWidth: input.draft.aspect.width,
      aspectHeight: input.draft.aspect.height,
      outputWidth: input.outputWidth,
      outputHeight: input.outputHeight,
      count: input.draft.quantity,
      providerId: profile.providerId,
      model,
      references: input.references,
      parameters: {
        ...Object.fromEntries(Object.entries(input.parameters).filter(([key]) => !['actualCostCny', 'simulatedEstimatedCostCny'].includes(key))),
        generationProfileId: profile.id,
        generationProfileLabel: profile.label,
        generationProfileTier: profile.tier,
        ...(profile.simulated ? { simulatedEstimatedCostCny: Number(((profile.estimatedUnitCostCny ?? 0) * input.draft.quantity).toFixed(2)), actualCostCny: 0 } : {}),
        budgetPolicyId: profile.budgetPolicyId
      },
      sourceMessageId: input.sourceMessageId,
      parentResultId: input.parentResultId,
      referenceMode: input.draft.referenceMode,
      variationInstruction: input.draft.variationInstruction,
      preserveConstraints: input.draft.preserveConstraints
    }
  }
}
