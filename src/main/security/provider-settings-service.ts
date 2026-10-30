import { randomUUID } from 'node:crypto'
import type {
  ConfigurableProviderId,
  ProviderExecutionPolicy,
  ProviderConfigFile,
  ProviderPublicConfig,
  ProviderSettingsSnapshot
} from '../../shared/provider-settings'
import {
  imageProviderConfigs,
  imageProviderIdSchema,
  MAX_IMAGE_PROVIDERS,
  newImageProviderConfig,
  PRIMARY_IMAGE_PROVIDER_ID,
  PROVIDER_CONFIG_VERSION,
  providerConfigFileSchema,
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
      defaultImageProviderId: config.defaultImageProviderId,
      realCallsAuthorized: this.#realCallsAuthorized,
      executionPolicy: config.executionPolicy
    })
  }

  /** Writes the providers in order, keeping or replacing the default image service. */
  async #writeProviders(current: ProviderConfigFile, providers: readonly ProviderPublicConfig[], defaultImageProviderId = current.defaultImageProviderId): Promise<void> {
    await this.#configStore.write(providerConfigFileSchema.parse({
      version: PROVIDER_CONFIG_VERSION,
      providers,
      defaultImageProviderId,
      executionPolicy: current.executionPolicy
    }))
  }

  async setConfig(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const input = providerPublicConfigSchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    if (!current.providers.some((provider) => provider.id === input.id)) throw new Error('这个服务已经不存在，请刷新设置后再改。')
    await this.#writeProviders(current, current.providers.map((provider) => provider.id === input.id ? input : provider))
    return this.#snapshot()
    })
  }

  async setExecutionPolicy(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const executionPolicy: ProviderExecutionPolicy = providerExecutionPolicySchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    await this.#configStore.write({ ...current, version: PROVIDER_CONFIG_VERSION, executionPolicy })
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

  /** Adds an empty image service under a new id; it sends nothing until it is filled in and has a key. */
  addImageProvider(): Promise<ProviderSettingsSnapshot> {
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    if (imageProviderConfigs(current).length >= MAX_IMAGE_PROVIDERS) throw new Error(`最多保存 ${MAX_IMAGE_PROVIDERS} 个生图服务。`)
    let id: string
    do id = `${PRIMARY_IMAGE_PROVIDER_ID}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    while (current.providers.some((provider) => provider.id === id))
    await this.#writeProviders(current, [...current.providers, newImageProviderConfig(id)])
    return this.#snapshot()
    })
  }

  /** Removes an added image service and its key. The primary service stays; it can be emptied instead. */
  removeImageProvider(idValue: unknown): Promise<ProviderSettingsSnapshot> {
    const id = imageProviderIdSchema.parse(idValue)
    return this.#serialize(async () => {
    if (id === PRIMARY_IMAGE_PROVIDER_ID) throw new Error('第一个生图服务不能删除；不用时可以清空它的配置。')
    const current = await this.#configStore.read()
    if (!current.providers.some((provider) => provider.id === id)) return this.#snapshot()
    await this.#writeProviders(
      current,
      current.providers.filter((provider) => provider.id !== id),
      current.defaultImageProviderId === id ? PRIMARY_IMAGE_PROVIDER_ID : current.defaultImageProviderId
    )
    await this.#vault.delete(id)
    return this.#snapshot()
    })
  }

  setDefaultImageProvider(idValue: unknown): Promise<ProviderSettingsSnapshot> {
    const id = imageProviderIdSchema.parse(idValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    if (!imageProviderConfigs(current).some((image) => image.id === id)) throw new Error('这个生图服务已经不存在，请刷新设置。')
    await this.#writeProviders(current, current.providers, id)
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
