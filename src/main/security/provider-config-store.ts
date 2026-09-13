import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_PROVIDER_CONFIG,
  providerConfigFileSchema,
  type ProviderConfigFile
} from '../../shared/provider-settings'

export interface ProviderConfigStorePort {
  read(): Promise<ProviderConfigFile>
  write(value: ProviderConfigFile): Promise<void>
}

export class FileProviderConfigStore implements ProviderConfigStorePort {
  readonly #filePath: string

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async read(): Promise<ProviderConfigFile> {
    try {
      return providerConfigFileSchema.parse(JSON.parse(await readFile(this.#filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_PROVIDER_CONFIG)
      throw error
    }
  }

  async write(value: ProviderConfigFile): Promise<void> {
    const parsed = providerConfigFileSchema.parse(value)
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
  }
}
