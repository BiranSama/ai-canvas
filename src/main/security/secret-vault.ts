import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const legacyVaultSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().min(1), z.string().base64())
})

const vaultFileSchema = z.object({
  version: z.literal(2),
  aliases: z.record(z.string().min(1), z.string().min(1)),
  slots: z.record(z.string().min(1), z.object({ alias: z.string().min(1), encrypted: z.string().base64(), pinned: z.boolean() }))
})
type VaultFile = z.infer<typeof vaultFileSchema>

export class ElectronSecretVault {
  readonly #filePath: string
  #chain = Promise.resolve()

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async has(id: string): Promise<boolean> {
    await this.#chain
    const vault = await this.#read()
    return vault.slots[vault.aliases[id] ?? ''] !== undefined
  }

  set(id: string, secret: string): Promise<void> {
    return this.#serialize(async () => {
      if (!this.isAvailable()) throw new Error('Operating-system secret encryption is unavailable.')
      const vault = await this.#read()
      // Unreferenced rotations need no history; requests pin the exact version.
      for (const [reference, slot] of Object.entries(vault.slots)) {
        if (slot.alias === id && !slot.pinned) delete vault.slots[reference]
      }
      const reference = randomUUID()
      vault.slots[reference] = { alias: id, encrypted: safeStorage.encryptString(secret).toString('base64'), pinned: false }
      vault.aliases[id] = reference
      await this.#write(vault)
    })
  }

  async get(id: string): Promise<string | null> {
    await this.#chain
    if (!this.isAvailable()) throw new Error('Operating-system secret encryption is unavailable.')
    const vault = await this.#read()
    const encoded = vault.slots[vault.aliases[id] ?? '']?.encrypted
    return encoded === undefined ? null : safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  captureReference(id: string): Promise<string | null> {
    return this.#serialize(async () => {
      const vault = await this.#read()
      const reference = vault.aliases[id]
      if (reference === undefined || vault.slots[reference] === undefined) return null
      vault.slots[reference].pinned = true
      await this.#write(vault)
      return reference
    })
  }

  async hasReference(id: string, reference: string): Promise<boolean> {
    await this.#chain
    return (await this.#read()).slots[reference]?.alias === id
  }

  async getByReference(id: string, reference: string): Promise<string | null> {
    await this.#chain
    if (!this.isAvailable()) throw new Error('Operating-system secret encryption is unavailable.')
    const slot = (await this.#read()).slots[reference]
    return slot?.alias === id ? safeStorage.decryptString(Buffer.from(slot.encrypted, 'base64')) : null
  }

  startBoundRequest(id: string, reference: string, send: (secret: string) => Promise<Response>): Promise<Response> {
    // Release the vault gate as soon as fetch starts, not when the response ends.
    return this.#serialize(async () => {
      if (!this.isAvailable()) throw Object.assign(new Error('原凭据版本不可用。'), { code: 'REQUEST_IDENTITY_UNAVAILABLE' })
      const slot = (await this.#read()).slots[reference]
      if (slot?.alias !== id) throw Object.assign(new Error('原凭据版本已撤销，请求未发送。'), { code: 'REQUEST_IDENTITY_UNAVAILABLE' })
      return { pending: send(safeStorage.decryptString(Buffer.from(slot.encrypted, 'base64'))) }
    }).then(({ pending }) => pending)
  }

  delete(id: string): Promise<void> {
    return this.#serialize(async () => {
      const vault = await this.#read()
      delete vault.aliases[id]
      // Explicit deletion revokes every request bound to this credential alias.
      for (const [reference, slot] of Object.entries(vault.slots)) if (slot.alias === id) delete vault.slots[reference]
      await this.#write(vault)
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#chain.then(operation)
    this.#chain = task.then(() => undefined, () => undefined)
    return task
  }

  async #read(): Promise<VaultFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#filePath, 'utf8'))
      if ((value as { version?: unknown }).version === 1) {
        const legacy = legacyVaultSchema.parse(value)
        const migrated: VaultFile = { version: 2, aliases: {}, slots: {} }
        for (const [alias, encrypted] of Object.entries(legacy.entries)) {
          const reference = createHash('sha256').update(`${alias}:${encrypted}`).digest('hex')
          migrated.aliases[alias] = reference
          migrated.slots[reference] = { alias, encrypted, pinned: false }
        }
        return migrated
      }
      return vaultFileSchema.parse(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, aliases: {}, slots: {} }
      throw error
    }
  }

  async #write(value: VaultFile): Promise<void> {
    const parsed = vaultFileSchema.parse(value)
    await mkdir(dirname(this.#filePath), { recursive: true })
    try {
      const previous = await readFile(this.#filePath, 'utf8')
      if ((JSON.parse(previous) as { version?: unknown }).version === 1) {
        await writeFile(`${this.#filePath}.pre-v2.bak`, previous, { encoding: 'utf8', flag: 'wx' })
      }
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(parsed), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
  }
}
