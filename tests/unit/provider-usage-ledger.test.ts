import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderUsageLedger } from '../../src/main/security/provider-usage-ledger'
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfigFile } from '../../src/shared/provider-settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Product provider usage ledger', () => {
  it('persists and enforces configured per-job request, image and cost limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-budget-'))
    roots.push(root)
    const config: ProviderConfigFile = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG),
      executionPolicy: {
        approvalMode: 'session', autoGenerate: true,
        maxRequestsPerJob: 3, maxImagesPerJob: 2, maxCostCnyPerJob: 3
      }
    }
    const source = { read: async () => structuredClone(config) }
    const filePath = join(root, 'provider-usage.json')
    const first = new ProviderUsageLedger(filePath, source)

    await first.reserve({ scopeId: 'job-1', providerId: 'image-provider', requests: 1, images: 1, costCeilingCny: 1.25 })
    await first.reserve({ scopeId: 'job-1', providerId: 'image-provider', requests: 1, images: 1, costCeilingCny: 1.25 })
    await expect(first.reserve({ scopeId: 'job-1', providerId: 'image-provider', requests: 1, images: 1, costCeilingCny: 0.5 }))
      .rejects.toMatchObject({ code: 'PROVIDER_IMAGE_BUDGET_EXCEEDED' })

    const restarted = new ProviderUsageLedger(filePath, source)
    expect(await restarted.snapshot('job-1')).toMatchObject({ requests: 2, images: 2, reservedCostCny: 2.5 })
    expect(await restarted.listSnapshots()).toEqual([
      expect.objectContaining({ scopeId: 'job-1', providerId: 'image-provider', requests: 2, images: 2, reservedCostCny: 2.5 })
    ])
    await expect(restarted.reserve({ scopeId: 'job-1', providerId: 'image-provider', requests: 2, images: 0, costCeilingCny: 0 }))
      .rejects.toMatchObject({ code: 'PROVIDER_REQUEST_BUDGET_EXCEEDED' })

    await expect(restarted.reserve({ scopeId: 'job-2', providerId: 'image-provider', requests: 1, images: 1, costCeilingCny: 3.01 }))
      .rejects.toMatchObject({ code: 'PROVIDER_COST_BUDGET_EXCEEDED' })
  })
})
