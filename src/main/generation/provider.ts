import type { EditRequest, GenerationRequest, GenerationStage, ProviderCapabilities } from '../../shared/generation'
import type { AssetMetadata } from '../storage/project-repository'
import type { ProviderCostReceipt } from '../../shared/generation-cost'

export interface ProviderOutput {
  readonly filePath: string
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}

export interface ProviderGenerateContext {
  readonly signal: AbortSignal
  readonly onStage: (stage: Extract<GenerationStage, 'submitting' | 'generating' | 'localizing'>) => Promise<void>
  readonly onExternalTaskId: (taskId: string) => Promise<void>
  /** Main-only settlement evidence. Request parameters cannot supply it. */
  readonly onCostReceipt?: (receipt: ProviderCostReceipt) => Promise<void>
  readonly resolveAsset: (assetId: string) => Promise<{ readonly asset: AssetMetadata; readonly filePath: string }>
}

export interface ImageProvider {
  readonly id: string
  readonly label: string
  readonly capabilities: ProviderCapabilities
  generate(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]>
  edit(request: EditRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]>
  resume?(request: GenerationRequest | EditRequest, externalTaskId: string, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]>
}

export class ProviderError extends Error {
  readonly code: string
  readonly stage: GenerationStage

  constructor(code: string, message: string, stage: GenerationStage = 'generating') {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.stage = stage
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ImageProvider>()

  constructor(providers: readonly ImageProvider[] = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: ImageProvider): void {
    if (this.#providers.has(provider.id)) throw new Error(`Provider ${provider.id} is already registered.`)
    this.#providers.set(provider.id, provider)
  }

  replace(provider: ImageProvider): void {
    this.#providers.set(provider.id, provider)
  }

  remove(providerId: string): boolean {
    return this.#providers.delete(providerId)
  }

  get(providerId: string): ImageProvider {
    const provider = this.#providers.get(providerId)
    if (provider === undefined) throw new ProviderError('PROVIDER_NOT_FOUND', `Provider “${providerId}” is not available.`, 'validating')
    return provider
  }

  list(): readonly ImageProvider[] {
    return [...this.#providers.values()]
  }
}
