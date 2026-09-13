import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Product Provider runtime', () => {
  it('reconfigures the Main-only image provider and task policy without performing HTTP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-provider-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)

    await runtime.setProviderConfig({
      id: 'image-provider',
      kind: 'image',
      label: 'Krill · Qwen Image',
      baseUrl: 'https://api.krill-ai.net/v1',
      defaultModel: 'qwen-image-2.0',
      protocol: 'task-images',
      timeoutMs: 60_000,
      concurrency: 1,
      capabilities: {
        textToImage: true,
        imageReferences: false,
        maskEditing: false,
        multipleReferences: false,
        transparentOutput: false
      }
    })
    const settings = await runtime.setProviderExecutionPolicy({
      approvalMode: 'confirm_each',
      autoGenerate: false,
      maxRequestsPerJob: 12,
      maxImagesPerJob: 1,
      maxCostCnyPerJob: 3,
    })

    expect(settings).toMatchObject({
      realCallsAuthorized: true,
      executionPolicy: { maxRequestsPerJob: 12, maxImagesPerJob: 1, maxCostCnyPerJob: 3 }
    })
    expect(runtime.listProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'image-provider',
        label: 'Krill · Qwen Image',
        models: [expect.objectContaining({ id: 'qwen-image-2.0' })],
        capabilities: expect.objectContaining({ textToImage: true, imageReferences: false, maskEditing: false, maxImages: 1 })
      })
    ]))
    expect(runtime.listProfiles().profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'available',
        profile: expect.objectContaining({ id: 'configured-draft', providerId: 'image-provider', modelId: 'qwen-image-2.0' })
      })
    ]))
    expect(runtime.listProfiles().profiles.some((entry) => entry.profile.id === 'configured-layer')).toBe(false)
    expect(await runtime.listJobs()).toHaveLength(0)

    await runtime.setProviderExecutionPolicy({
      approvalMode: 'confirm_each',
      autoGenerate: false,
      maxRequestsPerJob: 2,
      maxImagesPerJob: 1,
      maxCostCnyPerJob: 3
    })
    expect(runtime.listProviders().some((provider) => provider.id === 'image-provider')).toBe(false)
    expect(runtime.listProfiles().profiles.some((entry) => entry.profile.providerId === 'image-provider')).toBe(false)
    await runtime.close()
  })

  it('selects image implementations only from the explicit protocol field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-provider-protocol-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)

    await runtime.setProviderConfig({
      id: 'image-provider',
      kind: 'image',
      label: 'Owner OpenAI Images Relay',
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'owner-image-model',
      protocol: 'openai-images',
      timeoutMs: 45_000,
      concurrency: 2,
      capabilities: {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: true,
        transparentOutput: false
      }
    })

    expect(runtime.listProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'image-provider',
        label: 'Owner OpenAI Images Relay',
        models: [expect.objectContaining({ id: 'owner-image-model' })],
        capabilities: expect.objectContaining({
          textToImage: true,
          imageReferences: true,
          maskEditing: true,
          multipleReferences: true
        })
      })
    ]))

    await runtime.setProviderConfig({
      id: 'image-provider',
      kind: 'image',
      label: 'Needs Protocol Choice',
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'owner-image-model',
      protocol: 'unconfigured',
      timeoutMs: 45_000,
      concurrency: 1,
      capabilities: {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: true,
        transparentOutput: false
      }
    })
    expect(runtime.listProviders().some((provider) => provider.id === 'image-provider')).toBe(false)
    await runtime.close()
  })
})
