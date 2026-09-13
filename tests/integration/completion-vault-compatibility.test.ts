import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ElectronSecretVault } from '../../src/main/security/secret-vault'
import { ProviderSettingsService } from '../../src/main/security/provider-settings-service'
import { FileProviderConfigStore } from '../../src/main/security/provider-config-store'

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('')
} }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('migrates only synthetic v1 ciphertext with backup, retains pinned versions, revokes all versions and rejects future formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-compat-'))
  roots.push(root)
  const path = join(root, 'vault.json')
  const legacy = JSON.stringify({ version: 1, entries: { 'image-provider': Buffer.from('A-citehtnys').toString('base64') } })
  await writeFile(path, legacy)
  const vault = new ElectronSecretVault(path)
  expect(await vault.has('image-provider')).toBe(true)
  // Read-only inspection does not rewrite a legacy vault.
  expect(await readFile(path, 'utf8')).toBe(legacy)
  const originalRef = await vault.captureReference('image-provider')
  expect(originalRef).toBeTruthy()
  expect(await readFile(`${path}.pre-v2.bak`, 'utf8')).toBe(legacy)
  await vault.set('image-provider', 'synthetic-B')
  await vault.set('image-provider', 'synthetic-C')
  const newVault = new ElectronSecretVault(path)
  expect(await newVault.getByReference('image-provider', originalRef!)).toBe('synthetic-A')
  expect(await newVault.get('image-provider')).toBe('synthetic-C')
  expect(await newVault.getByReference('openai-compatible-llm', originalRef!)).toBeNull()
  const beforeDelete = JSON.parse(await readFile(path, 'utf8'))
  expect(Object.keys(beforeDelete.slots)).toHaveLength(2)
  expect(await readFile(path, 'utf8')).not.toMatch(/synthetic-[ABC]/)
  await newVault.delete('image-provider')
  await newVault.set('image-provider', 'synthetic-D')
  expect(await newVault.getByReference('image-provider', originalRef!)).toBeNull()
  const send = vi.fn(async () => new Response())
  await expect(newVault.startBoundRequest('image-provider', originalRef!, send)).rejects.toMatchObject({ code: 'REQUEST_IDENTITY_UNAVAILABLE' })
  expect(send).not.toHaveBeenCalled()
  await writeFile(path, '{"version":99,"entries":{}}')
  await expect(newVault.set('image-provider', 'synthetic-E')).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{"version":99,"entries":{}}')
})

it('serializes complete configuration and key captures with settings mutations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'binding-barrier-'))
  roots.push(root)
  const vault = new ElectronSecretVault(join(root, 'vault.json'))
  const config = new FileProviderConfigStore(join(root, 'config.json'))
  const settings = new ProviderSettingsService(vault, config)
  await settings.setSecret({ providerId: 'image-provider', apiKey: 'synthetic-A' })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const captured = settings.withStableConfiguration(async (saved) => {
    entered = true
    await gate
    return { saved, ref: await vault.captureReference('image-provider') }
  })
  await expect.poll(() => entered).toBe(true)
  const changed = settings.setSecret({ providerId: 'image-provider', apiKey: 'synthetic-B' })
  release()
  const old = await captured
  await changed
  expect(await vault.getByReference('image-provider', old.ref!)).toBe('synthetic-A')
  expect(await vault.get('image-provider')).toBe('synthetic-B')
})
