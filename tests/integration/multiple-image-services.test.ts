import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import type { GenerationProfileRequest } from '../../src/shared/generation'
import type { ProviderPublicConfigInput } from '../../src/shared/provider-settings'

// Only synthetic secrets. Production Main, protocol, HTTP, workflow and SQLite remain real.
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('')
} }))
const roots: string[] = []
const runtimes: GenerationRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function configuration(id: string, tag: string): Extract<ProviderPublicConfigInput, { kind: 'image' }> {
  return { id, kind: 'image', label: `Synthetic ${tag}`, baseUrl: `https://${tag}.example.test/v1`,
    defaultModel: `model-${tag}`, protocol: 'openai-images', timeoutMs: 45_000, concurrency: 1,
    capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } }
}
function request(profileId: string, tag: string): GenerationProfileRequest {
  return { profileId, confirmed: true, operation: 'generate',
    draft: { prompt: 'Synthetic service routing', negativePrompt: '', aspect: { width: 1, height: 1 }, quantity: 1,
      profileId, referenceResultIds: [], sourceSceneRevision: null, referenceMode: 'hybrid',
      variationInstruction: '', preserveConstraints: '', expandedSections: [] },
    outputWidth: 256, outputHeight: 256, references: [], parameters: { workflowIdempotencyKey: `route-${tag}` },
    sourceMessageId: null, parentResultId: null, modelOverride: `model-${tag}` }
}
async function completed(runtime: GenerationRuntime, jobId: string) {
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === jobId)?.status, { timeout: 6_000 }).toBe('completed')
  return (await runtime.listJobs()).find((job) => job.id === jobId)!
}

it('keeps several image services side by side and runs each job on the service it names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-services-'))
  roots.push(root)
  const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#dbe5ee' } }).png().toBuffer()
  const calls: { url: string; key: string | null; model: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get('authorization'), model: JSON.parse(String(init.body)).model })
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }))
  const runtime = await GenerationRuntime.create(root)
  runtimes.push(runtime)
  await runtime.setProviderConfig(configuration('image-provider', 'a'))
  await runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-A' })
  await runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 8, maxImagesPerJob: 1, maxCostCnyPerJob: 2 })

  const added = await runtime.addImageProvider()
  const second = added.providers.find((provider) => provider.kind === 'image' && provider.id !== 'image-provider')!
  expect(second).toMatchObject({ protocol: 'unconfigured', configured: false })
  expect(second.id).toMatch(/^image-provider-[a-z0-9]{8}$/)
  await runtime.setProviderConfig({ ...configuration(second.id, 'b'), pricePerImageCny: 0.3 })
  await runtime.setProviderSecret({ providerId: second.id, apiKey: 'synthetic-B' })
  expect((await runtime.setDefaultImageProvider(second.id)).defaultImageProviderId).toBe(second.id)

  // The primary service keeps its profile ids; the added one gets its own.
  const profiles = runtime.listProfiles().profiles.filter((entry) => entry.status === 'available' && entry.profile.tier === 'draft' && !entry.profile.simulated)
  expect(profiles.map((entry) => [entry.profile.id, entry.profile.providerId, entry.profile.modelId])).toEqual([
    ['configured-draft', 'image-provider', 'model-a'],
    [`${second.id}-draft`, second.id, 'model-b']
  ])

  const onSecond = await completed(runtime, (await runtime.enqueueProfile(request(`${second.id}-draft`, 'b'))).id)
  const onPrimary = await completed(runtime, (await runtime.enqueueProfile(request('configured-draft', 'a'))).id)
  expect([onSecond.providerId, onPrimary.providerId]).toEqual([second.id, 'image-provider'])
  // Only the service with a price gets an estimate; the bill stays unknown either way.
  expect(onSecond.cost).toMatchObject({ actual: { status: 'unknown' }, estimate: { amount: 0.3, currency: 'CNY', source: 'provider_price', parameters: { imageCount: 1, model: 'model-b' } } })
  expect(onPrimary.cost?.estimate).toBeNull()
  expect(calls).toEqual([
    { url: 'https://b.example.test/v1/images/generations', key: 'Bearer synthetic-B', model: 'model-b' },
    { url: 'https://a.example.test/v1/images/generations', key: 'Bearer synthetic-A', model: 'model-a' }
  ])

  // The file is saved as v6 and read back the same after a restart.
  expect(JSON.parse(await readFile(join(root, 'security', 'provider-settings.json'), 'utf8'))).toMatchObject({ version: 6, defaultImageProviderId: second.id })
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
  const reopened = await GenerationRuntime.create(root)
  runtimes.push(reopened)
  expect((await reopened.getProviderSettings()).providers.map((provider) => [provider.id, provider.configured])).toEqual([
    ['openai-compatible-llm', false], ['image-provider', true], [second.id, true]
  ])

  // The primary stays; removing an added service drops its key and makes the primary the default again.
  await expect(reopened.removeImageProvider('image-provider')).rejects.toThrow(/第一个生图服务不能删除/)
  const removed = await reopened.removeImageProvider(second.id)
  expect(removed.defaultImageProviderId).toBe('image-provider')
  expect(removed.providers.map((provider) => provider.id)).toEqual(['openai-compatible-llm', 'image-provider'])
  expect(reopened.listProviders().some((provider) => provider.id === second.id)).toBe(false)
  // Finished jobs keep the service they ran on.
  expect((await reopened.listJobs()).find((job) => job.id === onSecond.id)?.providerId).toBe(second.id)

  for (let count = 1; count < 8; count += 1) await reopened.addImageProvider()
  expect((await reopened.getProviderSettings()).providers).toHaveLength(9)
  await expect(reopened.addImageProvider()).rejects.toThrow(/最多保存 8 个生图服务/)
}, 30_000)
