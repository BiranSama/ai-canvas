import { randomUUID } from 'node:crypto'
import type { ProviderSecretVault } from '../../security/secret-vault'

/**
 * In-memory stand-in for the operating-system vault, for eval runs only.
 * Secrets come from the caller (the eval reads them from environment
 * variables), are never written to disk and are never part of any log.
 */
export class InMemorySecretVault implements ProviderSecretVault {
  readonly #aliases = new Map<string, string>()
  readonly #slots = new Map<string, { readonly alias: string; readonly secret: string }>()

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [id, secret] of Object.entries(initial)) this.#store(id, secret)
  }

  isAvailable(): boolean {
    return true
  }

  async has(id: string): Promise<boolean> {
    return this.#aliases.has(id)
  }

  async set(id: string, secret: string): Promise<void> {
    this.#store(id, secret)
  }

  async get(id: string): Promise<string | null> {
    const reference = this.#aliases.get(id)
    return reference === undefined ? null : this.#slots.get(reference)?.secret ?? null
  }

  async captureReference(id: string): Promise<string | null> {
    return this.#aliases.get(id) ?? null
  }

  async hasReference(id: string, reference: string): Promise<boolean> {
    return this.#slots.get(reference)?.alias === id
  }

  async getByReference(id: string, reference: string): Promise<string | null> {
    const slot = this.#slots.get(reference)
    return slot?.alias === id ? slot.secret : null
  }

  async startBoundRequest(id: string, reference: string, send: (secret: string) => Promise<Response>): Promise<Response> {
    const slot = this.#slots.get(reference)
    if (slot?.alias !== id) throw Object.assign(new Error('原凭据版本已撤销，请求未发送。'), { code: 'REQUEST_IDENTITY_UNAVAILABLE' })
    return send(slot.secret)
  }

  async delete(id: string): Promise<void> {
    this.#aliases.delete(id)
    for (const [reference, slot] of this.#slots) if (slot.alias === id) this.#slots.delete(reference)
  }

  #store(id: string, secret: string): void {
    const reference = randomUUID()
    this.#slots.set(reference, { alias: id, secret })
    this.#aliases.set(id, reference)
  }
}
