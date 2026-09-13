import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { GenerationQueue } from '../../src/main/generation/generation-queue'
import { ProviderUsageLedger } from '../../src/main/security/provider-usage-ledger'
import { FileProviderConfigStore } from '../../src/main/security/provider-config-store'
import { sceneSchema, ELEMENT_SCHEMA_VERSION } from '../../src/domain'
import { openDatabase } from '../../src/main/storage/database'
import type { GenerationProfileRequest } from '../../src/shared/generation'
import type { ProviderPublicConfig } from '../../src/shared/provider-settings'

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

function configuration(tag: string, protocol: 'openai-images' | 'task-images' = 'openai-images'): ProviderPublicConfig {
  return { id: 'image-provider', kind: 'image', label: `Synthetic ${tag}`, baseUrl: `https://${tag}.example.test/v1`,
    defaultModel: `model-${tag}`, protocol, timeoutMs: tag === 'a' ? 300_000 : 45_000, concurrency: 1,
    capabilities: { textToImage: true, imageReferences: protocol === 'openai-images', maskEditing: protocol === 'openai-images',
      multipleReferences: protocol === 'openai-images', transparentOutput: false } }
}
function request(tag = 'a', key = 'stable-invocation'): GenerationProfileRequest {
  return { profileId: 'configured-draft', confirmed: true, operation: 'generate',
    draft: { prompt: 'Synthetic identity verification', negativePrompt: '', aspect: { width: 1, height: 1 }, quantity: 1,
      profileId: 'configured-draft', referenceResultIds: [], sourceSceneRevision: null, referenceMode: 'hybrid',
      variationInstruction: '', preserveConstraints: '', expandedSections: [] },
    outputWidth: 256, outputHeight: 256, references: [], parameters: { workflowIdempotencyKey: key },
    sourceMessageId: null, parentResultId: null, modelOverride: `model-${tag}` }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'identity-'))
  roots.push(root)
  const runtime = await GenerationRuntime.create(root)
  runtimes.push(runtime)
  await runtime.setProviderConfig(configuration('a'))
  await runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-A' })
  await runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false,
    maxRequestsPerJob: 8, maxImagesPerJob: 1, maxCostCnyPerJob: 2 })
  let queue: Pick<GenerationQueue, 'activate' | 'waitForIdle'> | undefined
  const original = GenerationQueue.prototype.prepare
  vi.spyOn(GenerationQueue.prototype, 'prepare').mockImplementation(function (this: GenerationQueue, ...args) {
    queue = { activate: this.activate.bind(this), waitForIdle: this.waitForIdle.bind(this) }
    return original.apply(this, args)
  })
  return { root, runtime, queue: () => { if (!queue) throw new Error('Real Main queue has not prepared a job.'); return queue } }
}
async function completed(runtime: GenerationRuntime, jobId: string) {
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === jobId)?.status, { timeout: 6_000 }).toBe('completed')
  return (await runtime.listJobs()).find((job) => job.id === jobId)!
}
async function imageBytes() { return sharp({ create: { width: 256, height: 256, channels: 4, background: '#dbe5ee' } }).png().toBuffer() }

it('pins queued HTTP identity and timeout across key, model, protocol, policy changes and reuses one invocation', async () => {
  const png = await imageBytes()
  const calls: { url: string; key: string | null; model: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get('authorization'), model: JSON.parse(String(init.body)).model })
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }))
  const value = await fixture()
  const original = await value.runtime.enqueueProfile(request(), { deferActivation: true })
  expect(original).toMatchObject({ status: 'queued', effectiveTimeoutMs: 300_000, submissionState: 'not_sent' })
  expect(original.executionIdentityId).toBeTruthy()
  await value.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-B' })
  await value.runtime.setProviderConfig(configuration('b', 'task-images'))
  await value.runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false,
    maxRequestsPerJob: 3, maxImagesPerJob: 1, maxCostCnyPerJob: 10 })
  await value.queue().activate(original.id)
  const result = await completed(value.runtime, original.id)
  expect(calls).toEqual([{ url: 'https://a.example.test/v1/images/generations', key: 'Bearer synthetic-A', model: 'model-a' }])
  const reuse = await value.runtime.enqueueProfile(request(), { deferActivation: true })
  expect(reuse.id).toBe(original.id)
  expect(reuse.executionIdentityId).toBe(original.executionIdentityId)
  const next = await value.runtime.enqueueProfile(request('b', 'new-invocation'), { deferActivation: true })
  expect(next.executionIdentityId).not.toBe(original.executionIdentityId)
  expect(next.effectiveTimeoutMs).toBe(45_000)
  await value.queue().activate(next.id)
  await completed(value.runtime, next.id)
  expect(calls.at(-1)).toEqual({ url: 'https://b.example.test/v1/images/generations', key: 'Bearer synthetic-B', model: 'model-b' })
  await value.runtime.setProviderConfig({ ...configuration('b'), protocol: 'unconfigured' } as ProviderPublicConfig)
  expect((await value.runtime.enqueueProfile(request())).id).toBe(original.id)
  const changed = request()
  await expect(value.runtime.enqueueProfile({ ...changed, draft: { ...changed.draft, prompt: 'A different request under the same key' } }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  expect(calls).toHaveLength(2)
  const binding = JSON.parse(await readFile(join(value.root, 'security', 'image-executions', `${original.executionIdentityId}.json`), 'utf8'))
  const ledger = JSON.parse(await readFile(join(value.root, 'security', 'provider-usage.json'), 'utf8'))
  expect(ledger.scopes[`image-binding:${original.executionIdentityId}`]).toMatchObject({ requests: 1, images: 1, reservedCostCny: 2 })
  expect(JSON.stringify([result, await value.runtime.getProviderSettings(), await value.runtime.resultFamilies()]))
    .not.toMatch(/synthetic-[AB]|credentialReference/)
  expect(JSON.stringify(result)).not.toContain(binding.credentialReference)
})

it('deleting a credential while reservation waits prevents fetch and cannot revive the original reference', async () => {
  const network = vi.fn(() => { throw new Error('Unexpected outbound request') })
  vi.stubGlobal('fetch', network)
  const value = await fixture()
  const job = await value.runtime.enqueueProfile(request(), { deferActivation: true })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = ProviderUsageLedger.prototype.reserve
  const reservation = vi.spyOn(ProviderUsageLedger.prototype, 'reserve').mockImplementation(async function (this: ProviderUsageLedger, ...args) {
    await gate
    return original.apply(this, args)
  })
  await value.queue().activate(job.id)
  await expect.poll(() => reservation.mock.calls.length).toBe(1)
  await value.runtime.deleteProviderSecret('image-provider')
  await value.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-C' })
  release()
  await value.queue().waitForIdle()
  expect(network).not.toHaveBeenCalled()
  expect((await value.runtime.listJobs()).find((item) => item.id === job.id)).toMatchObject({
    status: 'interrupted', error: { code: 'REQUEST_IDENTITY_UNAVAILABLE' }, submissionState: 'may_have_sent'
  })
  await expect(value.runtime.retry(job.id)).rejects.toMatchObject({ code: 'NO_REPOST' })
})

it('an explicit retry before any POST retains the original model, endpoint, key and policy after configuration changes', async () => {
  const png = await imageBytes()
  const calls: { url: string; key: string | null; model: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get('authorization'), model: JSON.parse(String(init.body)).model })
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }))
  const value = await fixture()
  const original = await value.runtime.enqueueProfile(request(), { deferActivation: true })
  await value.runtime.cancel(original.id)
  await value.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-B' })
  await value.runtime.setProviderConfig(configuration('b', 'task-images'))
  await expect(value.runtime.retry(original.id, { model: 'model-b' })).rejects.toMatchObject({ code: 'REQUEST_CONFIG_CHANGED' })
  expect(await value.runtime.listJobs()).toHaveLength(1)
  const retried = await value.runtime.retry(original.id)
  await completed(value.runtime, retried.id)
  expect(retried).toMatchObject({ parentJobId: original.id, effectiveTimeoutMs: 300_000, model: 'model-a' })
  expect(calls).toEqual([{ url: 'https://a.example.test/v1/images/generations', key: 'Bearer synthetic-A', model: 'model-a' }])
  expect((await value.runtime.retry(original.id)).id).toBe(retried.id)
  expect(await value.runtime.listJobs()).toHaveLength(2)
  expect(calls).toHaveLength(1)
})

it('resumes only the original GET and pinned download after normal close, with the original key and budget scope', async () => {
  const png = await imageBytes()
  let restarted = false
  const calls: { url: string; method: string; key: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', key: new Headers(init.headers).get('authorization') })
    if (init.method === 'POST') return Response.json({ id: 'original-task', status: 'pending' })
    if (!restarted) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason)
      else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    if (String(url).endsWith('/content')) return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
    return Response.json({ id: 'original-task', status: 'completed' })
  }))
  const value = await fixture()
  await value.runtime.setProviderConfig(configuration('a', 'task-images'))
  const job = await value.runtime.enqueueProfile(request())
  await expect.poll(() => calls.length).toBe(2)
  const startedAt = (await value.runtime.listJobs())[0]!.startedAt
  await value.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-B' })
  await value.runtime.setProviderConfig(configuration('b'))
  await value.runtime.close()
  restarted = true
  const reopened = await GenerationRuntime.create(value.root)
  runtimes.push(reopened)
  const result = await completed(reopened, job.id)
  expect(result.startedAt).toBe(startedAt)
  expect(result.externalTaskId).toBe('original-task')
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  expect(calls).toHaveLength(4)
  expect(calls.every((call) => call.url.startsWith('https://a.example.test/v1/') && call.key === 'Bearer synthetic-A')).toBe(true)
  expect(calls.at(-1)?.url).toBe('https://a.example.test/v1/images/original-task/content')
  const ledger = JSON.parse(await readFile(join(value.root, 'security', 'provider-usage.json'), 'utf8'))
  expect(Object.keys(ledger.scopes)).toEqual([`image-binding:${job.executionIdentityId}`])
  expect(Object.values(ledger.scopes)[0]).toMatchObject({ requests: 4, images: 1, reservedCostCny: 2 })
})

it('does not repost an uncertain POST through retry, idempotent replay or restart', async () => {
  const network = vi.fn(async () => { throw new Error('Synthetic connection lost after send') })
  vi.stubGlobal('fetch', network)
  const value = await fixture()
  const job = await value.runtime.enqueueProfile(request())
  await value.queue().waitForIdle()
  expect((await value.runtime.listJobs())[0]).toMatchObject({ status: 'failed', submissionState: 'may_have_sent' })
  await expect(value.runtime.retry(job.id)).rejects.toMatchObject({ code: 'NO_REPOST' })
  expect((await value.runtime.enqueueProfile(request())).id).toBe(job.id)
  await value.runtime.close()
  const reopened = await GenerationRuntime.create(value.root)
  runtimes.push(reopened)
  expect(await reopened.listJobs()).toHaveLength(1)
  expect(network).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'future-format', 'wrong-project', 'wrong-request'] as const)(
  'pauses an original queued request with %s binding while preserving local results', async (failure) => {
    const network = vi.fn(() => { throw new Error('Unexpected outbound request') })
    vi.stubGlobal('fetch', network)
    const value = await fixture()
    const original = await value.runtime.enqueueProfile(request(), { deferActivation: true })
    const path = join(value.root, 'security', 'image-executions', `${original.executionIdentityId}.json`)
    await value.runtime.close()
    if (failure === 'missing') await rm(path)
    else {
      const binding = JSON.parse(await readFile(path, 'utf8'))
      if (failure === 'future-format') binding.version = 99
      if (failure === 'wrong-project') binding.projectId = 'different-project'
      if (failure === 'wrong-request') binding.requestHash = '0'.repeat(64)
      await writeFile(path, JSON.stringify(binding))
    }
    const reopened = await GenerationRuntime.create(value.root)
    runtimes.push(reopened)
    await expect.poll(async () => (await reopened.listJobs())[0]?.status).toBe('interrupted')
    expect((await reopened.listJobs())[0]).toMatchObject({ id: original.id, executionIdentityId: original.executionIdentityId,
      error: { code: 'REQUEST_IDENTITY_UNAVAILABLE' }, request: { prompt: original.request.prompt } })
    expect(network).not.toHaveBeenCalled()
  }
)

it('migrates a synthetic v10 project without inventing an identity for old queued work', async () => {
  const network = vi.fn(() => { throw new Error('Unexpected outbound request') })
  vi.stubGlobal('fetch', network)
  const value = await fixture()
  const job = await value.runtime.enqueueProfile(request(), { deferActivation: true })
  const directory = join(value.root, 'projects', 'Untitled.aicanvas')
  await value.runtime.close()
  const connection = openDatabase(join(directory, 'project.db'))
  connection.sqlite.exec(`ALTER TABLE generation_jobs DROP COLUMN execution_identity_id;
    ALTER TABLE generation_jobs DROP COLUMN effective_timeout_ms;
    ALTER TABLE generation_jobs DROP COLUMN submission_state;
    ALTER TABLE generation_jobs DROP COLUMN copied_from_project_id;
    ALTER TABLE generation_jobs DROP COLUMN cost_json;
    DROP TABLE agent_generation_limits;
    DROP TABLE project_work_context;
    DROP TABLE project_copy_records;
    DELETE FROM schema_migrations WHERE version >= 11;`)
  await connection.kysely.destroy()
  if (connection.sqlite.open) connection.sqlite.close()
  const reopened = await GenerationRuntime.create(value.root)
  runtimes.push(reopened)
  await expect.poll(async () => (await reopened.listJobs())[0]?.status).toBe('interrupted')
  expect((await reopened.listJobs())[0]).toMatchObject({ id: job.id, executionIdentityId: null,
    error: { code: 'REQUEST_IDENTITY_UNAVAILABLE' } })
  expect((await readFile(join(directory, 'project.pre-migration-v10.bak.db'))).length).toBeGreaterThan(0)
  expect(network).not.toHaveBeenCalled()
})

it('replays raw enqueue and both canvas entrypoints using their original request and reference snapshots', async () => {
  const png = await imageBytes()
  const network = vi.fn(async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }))
  vi.stubGlobal('fetch', network)
  const value = await fixture()
  const profile = request()
  const raw = { prompt: profile.draft.prompt, negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 256, outputHeight: 256,
    count: 1, providerId: 'image-provider', model: 'model-a', references: [], parameters: { workflowIdempotencyKey: 'raw-id' },
    sourceMessageId: null, parentResultId: null, referenceMode: 'hybrid' as const, variationInstruction: '', preserveConstraints: '' }
  const original = await value.runtime.enqueue(raw)
  await completed(value.runtime, original.id)
  const imported = await value.runtime.importAsset({ name: 'synthetic.png', mimeType: 'image/png', bytes: new Uint8Array(png) })
  const target = { id: '20000000-0000-4000-8000-000000000001', version: ELEMENT_SCHEMA_VERSION, type: 'image', name: 'Synthetic product',
    description: '', transform: { x: .1, y: .1, width: .8, height: .8, rotation: 0 }, zIndex: 0, opacity: 1, blendMode: 'normal',
    visible: true, locked: false, groupId: null, semanticRole: 'content', referencePolicy: 'include', assetId: imported.id,
    crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'contain', referenceRole: 'general' }
  const mask = { ...target, id: '20000000-0000-4000-8000-000000000002', type: 'mask', name: 'Background area', zIndex: 1,
    semanticRole: 'edit-mask', referencePolicy: 'exclude', mode: 'edit', targetElementId: target.id,
    paths: [{ id: '20000000-0000-4000-8000-000000000003', points: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }], closed: true }], feather: .02 }
  let scene = sceneSchema.parse({ ...value.runtime.getWorkspaceBootstrap().scene,
    canvas: { ...value.runtime.getWorkspaceBootstrap().scene.canvas, outputWidth: 256, outputHeight: 256, aspectWidth: 1, aspectHeight: 1 },
    elements: [target, mask], relations: [] })
  await value.runtime.executeSceneCommands({ projectId: scene.projectId, expectedSceneRevision: scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: 'Prepare authoritative image and mask', commands: [
      { kind: 'scene.set-canvas', canvas: scene.canvas }, ...scene.elements.map((element) => ({ kind: 'element.add' as const, element }))
    ] } })
  scene = value.runtime.getWorkspaceBootstrap().scene
  const canvasInput = { scene, originalRequirement: 'Keep this synthetic product', providerId: 'image-provider', model: 'model-a',
    count: 1, profileId: 'configured-draft', confirmed: true, sourceMessageId: null, referenceMode: 'hybrid' as const }
  const canvas = await value.runtime.generateFromCanvas(canvasInput, 'canvas-id', undefined, true)
  const editInput = { scene, targetElementId: target.id, prompt: 'Change only the masked background', negativePrompt: '', providerId: 'image-provider',
    model: 'model-a', count: 1, profileId: 'configured-final', confirmed: true, sourceMessageId: null, parentResultId: null }
  const edit = await value.runtime.editFromCanvas(editInput, 'edit-id', undefined, true)
  await value.runtime.setProviderConfig({ ...configuration('b'), protocol: 'unconfigured' } as ProviderPublicConfig)
  expect((await value.runtime.enqueue(raw)).id).toBe(original.id)
  expect(await value.runtime.generateFromCanvas(canvasInput, 'canvas-id', undefined, true)).toEqual(canvas)
  expect(await value.runtime.editFromCanvas(editInput, 'edit-id', undefined, true)).toEqual(edit)
  await expect(value.runtime.generateFromCanvas({ ...canvasInput, originalRequirement: 'Changed meaning' }, 'canvas-id', undefined, true))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await expect(value.runtime.editFromCanvas({ ...editInput, prompt: 'Changed meaning' }, 'edit-id', undefined, true))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  expect(network).toHaveBeenCalledTimes(1)
  await value.queue().activate(canvas.jobId)
  await value.queue().activate(edit.jobId)
  await completed(value.runtime, edit.jobId)
  expect((await value.runtime.listJobs()).find((job) => job.id === canvas.jobId)?.status).toBe('completed')
  expect(network).toHaveBeenCalledTimes(3)
})

it('rejects a request from project A that waited behind settings after the user switches to B', async () => {
  const network = vi.fn(() => { throw new Error('Unexpected outbound request') })
  vi.stubGlobal('fetch', network)
  const value = await fixture()
  const projectA = value.runtime.getWorkspaceBootstrap().projectId
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = FileProviderConfigStore.prototype.read
  let captured = false
  vi.spyOn(FileProviderConfigStore.prototype, 'read').mockImplementationOnce(async function (this: FileProviderConfigStore) {
    captured = true
    await gate
    return original.call(this)
  })
  const setting = value.runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-B' })
  await expect.poll(() => captured).toBe(true)
  const pending = value.runtime.enqueueProfile(request(), { deferActivation: true })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_CHANGED' })
  const projectB = await value.runtime.createProject(join(value.root, 'projects', 'B.aicanvas'), 'Project B')
  expect(projectB.projectId).not.toBe(projectA)
  release()
  await setting
  await rejected
  expect(await value.runtime.listJobs()).toHaveLength(0)
  const db = openDatabase(join(value.root, 'projects', 'B.aicanvas', 'project.db'))
  expect(db.sqlite.prepare('SELECT COUNT(*) AS total FROM agent_budget_reservations').get()).toEqual({ total: 0 })
  db.sqlite.close()
  expect(network).not.toHaveBeenCalled()
})
