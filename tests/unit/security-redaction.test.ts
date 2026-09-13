import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderSettingsService } from '../../src/main/security/provider-settings-service'
import { RedactedLogger, redactSensitive } from '../../src/main/security/redacted-logger'
import { FileRedactedLogger } from '../../src/main/security/file-redacted-logger'
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfigFile } from '../../src/shared/provider-settings'

class MemoryVault {
  readonly entries = new Map<string, string>()
  has(id: string): Promise<boolean> { return Promise.resolve(this.entries.has(id)) }
  set(id: string, secret: string): Promise<void> { this.entries.set(id, secret); return Promise.resolve() }
  delete(id: string): Promise<void> { this.entries.delete(id); return Promise.resolve() }
}

class MemoryConfigStore {
  value: ProviderConfigFile = structuredClone(DEFAULT_PROVIDER_CONFIG)
  read(): Promise<ProviderConfigFile> { return Promise.resolve(structuredClone(this.value)) }
  write(value: ProviderConfigFile): Promise<void> { this.value = structuredClone(value); return Promise.resolve() }
}

describe('security redaction and provider settings boundary', () => {
  it('redacts API-shaped values from messages, errors and structured logs', () => {
    const secret = 'sk-test-AC05-DO-NOT-USE-123456789'
    expect(redactSensitive(`Authorization: Bearer ${secret}`)).toBe('Authorization: [REDACTED]')
    const records: unknown[] = []
    const logger = new RedactedLogger((record) => records.push(record))
    const correlationId = logger.write('error', `provider rejected ${secret}`, {
      apiKey: secret,
      nested: { message: `token=${secret}` }
    }, 'correlation-01')
    expect(correlationId).toBe('correlation-01')
    expect(JSON.stringify(records)).not.toContain(secret)
    expect(records).toEqual([expect.objectContaining({ correlationId: 'correlation-01', level: 'error' })])
  })

  it('returns only configured state and makes deletion irreversible through the service', async () => {
    const vault = new MemoryVault()
    const configs = new MemoryConfigStore()
    const service = new ProviderSettingsService(vault, configs)
    expect(await service.snapshot()).toMatchObject({
      realCallsAuthorized: true,
      executionPolicy: {
        approvalMode: 'confirm_each',
        autoGenerate: false,
        maxRequestsPerJob: 50,
        maxImagesPerJob: 4,
        maxCostCnyPerJob: 20,
      },
      providers: [{ configured: false }, { configured: false }]
    })
    const configured = await service.setSecret({ providerId: 'image-provider', apiKey: 'synthetic-key-value' })
    expect(configured.providers.find((provider) => provider.id === 'image-provider')?.configured).toBe(true)
    expect(JSON.stringify(configured)).not.toContain('synthetic-key-value')
    const deleted = await service.deleteSecret('image-provider')
    expect(deleted.providers.find((provider) => provider.id === 'image-provider')?.configured).toBe(false)
    expect(vault.entries.has('image-provider')).toBe(false)
  })

  it('versions editable public fields and Product execution policy separately from encrypted secrets', async () => {
    const vault = new MemoryVault()
    const configs = new MemoryConfigStore()
    const service = new ProviderSettingsService(vault, configs)
    const snapshot = await service.setConfig({
      ...DEFAULT_PROVIDER_CONFIG.providers[1],
      label: 'Studio Images',
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'studio-image-1',
      timeoutMs: 45_000,
      concurrency: 2,
      capabilities: {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: false,
        transparentOutput: false
      }
    })
    expect(configs.value.version).toBe(5)
    expect(snapshot.realCallsAuthorized).toBe(true)
    expect(snapshot.providers[1]).toMatchObject({
      label: 'Studio Images',
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'studio-image-1',
      configured: false
    })
    await expect(service.setConfig({
      ...DEFAULT_PROVIDER_CONFIG.providers[1],
      baseUrl: 'ftp://key@example.test/images'
    })).rejects.toThrow(/HTTPS/)

    const policy = await service.setExecutionPolicy({
      approvalMode: 'session',
      autoGenerate: true,
      maxRequestsPerJob: 60,
      maxImagesPerJob: 8,
      maxCostCnyPerJob: 30,
    })
    expect(policy.executionPolicy).toMatchObject({ approvalMode: 'session', autoGenerate: true, maxImagesPerJob: 8 })
    expect(configs.value.executionPolicy).toEqual(policy.executionPolicy)
  })

  it('writes redacted JSONL diagnostics with an explicit correlation ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-redacted-log-'))
    try {
      const filePath = join(root, 'logs', 'diagnostic.jsonl')
      const logger = new FileRedactedLogger(filePath)
      logger.write('error', 'generation.failed', {
        apiKey: 'sk-test-DIAGNOSTIC-DO-NOT-USE-123456',
        message: 'Authorization: Bearer sk-test-DIAGNOSTIC-DO-NOT-USE-123456 at C:\\Users\\Owner\\private-project\\project.db',
        alternatePath: 'H:/private-workspace/project.db',
        networkPath: '\\\\studio-nas\\private-share\\project.db',
        unixPath: '/home/owner/private-project/project.db'
      }, 'job-correlation-01')
      await logger.flush()
      const text = await readFile(filePath, 'utf8')
      expect(text).toContain('job-correlation-01')
      expect(text).toContain('[REDACTED]')
      expect(text).toContain('[LOCAL_PATH]')
      expect(text).not.toContain('sk-test-DIAGNOSTIC')
      expect(text).not.toContain('private-project')
      expect(text).not.toContain('private-workspace')
      expect(text).not.toContain('private-share')
      expect(JSON.parse(text.trim())).toMatchObject({ event: 'generation.failed', level: 'error' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
