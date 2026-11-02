import { randomUUID } from 'node:crypto'
import type {
  ConfigurableProviderId,
  ProviderCheck,
  ProviderExecutionPolicy,
  ProviderConfigFile,
  ProviderPublicConfig,
  ProviderSettingsSnapshot,
  TextHelperRole
} from '../../shared/provider-settings'
import {
  configurableProviderIdSchema,
  newTextHelperConfig,
  providerCheckSchema,
  TEXT_HELPER_IDS,
  textHelperRoleOf,
  textHelperRoleSchema,
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
    const helper = async (role: TextHelperRole) => {
      const saved = config.textHelpers[role]
      return saved === null ? null : { ...saved, configured: await this.#vault.has(saved.id) }
    }
    return providerSettingsSnapshotSchema.parse({
      providers: await Promise.all(config.providers.map(async (provider) => ({
        ...provider,
        configured: await this.#vault.has(provider.id)
      }))),
      defaultImageProviderId: config.defaultImageProviderId,
      realCallsAuthorized: this.#realCallsAuthorized,
      executionPolicy: config.executionPolicy,
      textHelpers: { vision: await helper('vision'), backup: await helper('backup') },
      checks: config.checks
    })
  }

  /** Writes the file with these changes; every other field stays as it is. */
  async #write(current: ProviderConfigFile, changes: Partial<Omit<ProviderConfigFile, 'version'>>): Promise<void> {
    await this.#configStore.write(providerConfigFileSchema.parse({ ...current, ...changes, version: PROVIDER_CONFIG_VERSION }))
  }

  /** Writes the providers in order, keeping or replacing the default image service. */
  async #writeProviders(current: ProviderConfigFile, providers: readonly ProviderPublicConfig[], defaultImageProviderId = current.defaultImageProviderId): Promise<void> {
    await this.#write(current, { providers: providers as ProviderConfigFile['providers'], defaultImageProviderId })
  }

  /** The checks without this service's: what was tested is no longer what is saved. */
  static #withoutCheck(checks: ProviderConfigFile['checks'], id: string): ProviderConfigFile['checks'] {
    return Object.fromEntries(Object.entries(checks).filter(([key]) => key !== id))
  }

  async setConfig(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const input = providerPublicConfigSchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    const role = textHelperRoleOf(input.id)
    const before = role === null ? current.providers.find((provider) => provider.id === input.id) : current.textHelpers[role]
    if (role === null && before === undefined) throw new Error('这个服务已经不存在，请刷新设置后再改。')
    const changed = before === undefined || before === null || before.baseUrl !== input.baseUrl || before.protocol !== input.protocol || before.defaultModel !== input.defaultModel
    const checks = changed ? ProviderSettingsService.#withoutCheck(current.checks, input.id) : current.checks
    if (role !== null) {
      if (input.kind !== 'llm') throw new Error('看图模型和备用模型必须是文字模型。')
      await this.#write(current, { textHelpers: { ...current.textHelpers, [role]: input }, checks })
    } else {
      await this.#write(current, { providers: current.providers.map((provider) => provider.id === input.id ? input : provider) as ProviderConfigFile['providers'], checks })
    }
    return this.#snapshot()
    })
  }

  /** Adds an empty vision or backup text model; it sends nothing until it is filled in and has a key. */
  addTextHelper(roleValue: unknown): Promise<ProviderSettingsSnapshot> {
    const role = textHelperRoleSchema.parse(roleValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    if (current.textHelpers[role] === null) await this.#write(current, { textHelpers: { ...current.textHelpers, [role]: newTextHelperConfig(role) } })
    return this.#snapshot()
    })
  }

  /** Removes a vision or backup text model, its key and its check. */
  removeTextHelper(roleValue: unknown): Promise<ProviderSettingsSnapshot> {
    const role = textHelperRoleSchema.parse(roleValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    const id = TEXT_HELPER_IDS[role]
    await this.#write(current, { textHelpers: { ...current.textHelpers, [role]: null }, checks: ProviderSettingsService.#withoutCheck(current.checks, id) })
    await this.#vault.delete(id)
    return this.#snapshot()
    })
  }

  /** Keeps how a service's 测试 went, until its settings or key change. */
  recordCheck(idValue: unknown, checkValue: unknown): Promise<ProviderSettingsSnapshot> {
    const id = configurableProviderIdSchema.parse(idValue)
    const check: ProviderCheck = providerCheckSchema.parse(checkValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    await this.#write(current, { checks: { ...current.checks, [id]: check } })
    return this.#snapshot()
    })
  }

  async setExecutionPolicy(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const executionPolicy: ProviderExecutionPolicy = providerExecutionPolicySchema.parse(inputValue)
    return this.#serialize(async () => {
    const current = await this.#configStore.read()
    await this.#write(current, { executionPolicy })
    return this.#snapshot()
    })
  }

  async setSecret(inputValue: unknown): Promise<ProviderSettingsSnapshot> {
    const input = providerSecretInputSchema.parse(inputValue)
    return this.#serialize(async () => {
    await this.#vault.set(input.providerId, input.apiKey)
    await this.#dropCheck(input.providerId)
    return this.#snapshot()
    })
  }

  deleteSecret(providerId: ConfigurableProviderId): Promise<ProviderSettingsSnapshot> {
    return this.#serialize(async () => {
    await this.#vault.delete(providerId)
    await this.#dropCheck(providerId)
    return this.#snapshot()
    })
  }

  async #dropCheck(id: string): Promise<void> {
    const current = await this.#configStore.read()
    if (current.checks[id] !== undefined) await this.#write(current, { checks: ProviderSettingsService.#withoutCheck(current.checks, id) })
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
    await this.#write(current, {
      providers: current.providers.filter((provider) => provider.id !== id) as ProviderConfigFile['providers'],
      defaultImageProviderId: current.defaultImageProviderId === id ? PRIMARY_IMAGE_PROVIDER_ID : current.defaultImageProviderId,
      checks: ProviderSettingsService.#withoutCheck(current.checks, id)
    })
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
