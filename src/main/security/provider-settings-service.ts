import type {
  ConfigurableProviderId,
  ProviderExecutionPolicy,
  ProviderConfigFile,
  ProviderSettingsSnapshot
} from '../../shared/provider-settings'
import {
  imageProviderConfigSchema,
  llmProviderConfigSchema,
  providerPublicConfigSchema,
  providerExecutionPolicySchema,
  providerSecretInputSchema,
  providerSettingsSnapshotSchema
} from '../../shared/provider-settings'
import type { ProviderConfigStorePort } from './provider-config-store'

interface SecretVaultPort {
  has(id: string): Promise<boolean>
  set(id: string, secret: string): Promise<void>
  delete(id: string): Promise<void>
}

export class ProviderSettingsService {
  readonly #vault: SecretVaultPort
  readonly #configStore: ProviderConfigStorePort
  readonly #realCallsAuthorized: boolean
  #chain = Promise.resolve()

  constructor(
    vault: SecretVaultPort,
    configStore: ProviderConfigStorePort,
    options: { readonly realCallsAuthorized?: boolean } = {}
  ) {
    this.#vault = vault
    this.#configStore = configStore
    this.#realCallsAuthorized = options.realCallsAuthorized ?? true
  }

  async snapshot(): Promise<ProviderSettingsSnapshot> {
    await this.#chain
    return this.#snapshot()
  }

  async #snapshot(): Promise<ProviderSettingsSnapshot> {
    const config = await this.#configStore.read()
    return providerSettingsSnapshotSchema.parse({
      providers: await Promise.all(config.providers.map(async (provider) => ({
        ...provider,
        configured: await this.#vault.has(provider.id)
      }))),
      realCallsAuthorized: this.#realCallsAuthorized,
      executionPolicy: config.executionPolicy
    })
  }

  async setConfig(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const input = providerPublicConfigSchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    const providers = current.providers.map((provider) => provider.id === input.id ? input : provider)
    await this.#configStore.write({ version: 5, providers: [
      llmProviderConfigSchema.parse(providers.find((provider) => provider.kind === 'llm')),
      imageProviderConfigSchema.parse(providers.find((provider) => provider.kind === 'image'))
    ], executionPolicy: current.executionPolicy })
    return this.#snapshot()
    })
  }

  async setExecutionPolicy(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const executionPolicy: ProviderExecutionPolicy = providerExecutionPolicySchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    await this.#configStore.write({ ...current, version: 5, executionPolicy })
    return this.#snapshot()
    })
  }

  async setSecret(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const input = providerSecretInputSchema.parse(inputValue)
    return this.#serialize(async () => {
    await this.#vault.set(input.providerId, input.apiKey)
    return this.#snapshot()
    })
  }

  deleteSecret(providerId: ConfigurableProviderId): Promise<ProviderSettingsSnapshot> {
    return this.#serialize(async () => {
    await this.#vault.delete(providerId)
    return this.#snapshot()
    })
  }

  withStableConfiguration<T>(capture: (config: ProviderConfigFile) => Promise<T>): Promise<T> {
    return this.#serialize(async () => capture(await this.#configStore.read()))
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#chain.then(operation)
    this.#chain = task.then(() => undefined, () => undefined)
    return task
  }
}
