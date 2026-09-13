import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationJobRepository, GenerationQueue, GenerationWorkflowCoordinator, GenerationWorkflowRepository, ProviderRegistry, type ImageProvider, type ProviderGenerateContext } from '../../src/main/generation'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { OpenAiImagesProvider } from '../../src/main/generation/openai-images-provider'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { runMigrations } from '../../src/main/storage/migrations'
import { generationRequestSchema, type GenerationJob, type ProviderCapabilities } from '../../src/shared/generation'
import { formatGenerationCost, formatGenerationCostSummary, summarizeGenerationCosts, type ProviderCostReceipt } from '../../src/shared/generation-cost'

// Synthetic configuration and settlement only; no real credentials or network.
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('') } }))
const closers: (() => Promise<unknown>)[] = []
const paths: string[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
  for (const path of paths.splice(0)) await writeFile(join(path, 'fixture-evidence.json'), JSON.stringify({ purpose: 'C13 isolated synthetic cost evidence', actualProviderRequests: 0 }))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const capabilities: ProviderCapabilities = { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true,
  transparentOutput: false, maxImages: 4, supportedRatios: ['custom'], supportedFormats: ['png'] }
function task(providerId = 'cost-fixture', count = 1) {
  return generationRequestSchema.parse({ prompt: 'Synthetic settlement test', providerId, model: 'cost-model',
    count, outputWidth: 128, outputHeight: 128, aspectWidth: 1, aspectHeight: 1,
    parameters: { actualCostCny: 0, simulatedEstimatedCostCny: 999 } })
}
function receipt(amount = 1.25, currency = 'CNY', receiptId = 'fake-settlement-1'): ProviderCostReceipt {
  return { status: 'actual_known', amount, currency, source: 'provider_receipt', evidence: { receiptId, observedAt: '2026-09-07T12:00:00.000Z' } }
}
async function harness(run?: (context: ProviderGenerateContext) => Promise<readonly { filePath: string; mimeType: 'image/png' }[]>) {
  const root = await mkdtemp(join(tmpdir(), 'cost-')); paths.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_COST_BOUNDARY') }); vi.stubGlobal('fetch', network)
  const opened = await ProjectWorkspace.create(join(root, 'cost.aicanvas'), 'Cost fixture')
  closers.push(() => opened.workspace.close(true))
  const dbPath = join(opened.workspace.directory, 'project.db')
  const jobs = new GenerationJobRepository(dbPath); closers.push(() => jobs.close())
  const workflows = new GenerationWorkflowRepository(dbPath); closers.push(() => workflows.close())
  const provider: ImageProvider = { id: 'cost-fixture', label: 'Offline receipt fixture', capabilities,
    generate: async (_request, context) => run ? run(context) : [], edit: async () => [], resume: async (_request, _id, context) => run ? run(context) : [] }
  const queue = new GenerationQueue({ projectId: opened.workspace.metadata.id, repository: jobs, assetStore: opened.workspace.assets,
    providers: new ProviderRegistry([provider]), timeoutMs: 100 })
  closers.push(() => queue.close())
  const coordinator = new GenerationWorkflowCoordinator({ repository: workflows, queue: {
    enqueue: (request) => queue.enqueue(request), prepare: (request) => queue.prepare(request), activate: (id) => queue.activate(id),
    cancel: (id) => queue.cancel(id), listJobs: () => jobs.listJobs(opened.workspace.metadata.id)
  } })
  await queue.initialize()
  const create = (count = 1) => coordinator.create({ projectId: opened.workspace.metadata.id, request: task('cost-fixture', count),
    capabilities, profileId: 'configured-final', tier: 'final', operation: 'text', sourceSceneRevision: 0, idempotencyKey: randomUUID(),
    estimatedCostCny: 2, deferActivation: true,
    limits: { maxJobs: 1, maxImages: 4, maxCostCny: 2, maxWallTimeMs: 1000, noImprovementLimit: 1 } })
  return { root, opened, dbPath, jobs, workflows, queue, coordinator, create, network }
}

it('keeps estimates and reservations independent from unknown, then joins a late receipt to all results exactly once', async () => {
  const h = await harness()
  const created = await h.create(2)
  expect(created.job.cost).toMatchObject({ actual: { status: 'unknown', amount: null }, estimate: null })
  // Arbitrary request parameters above cannot create an actual or a real estimate.
  await h.jobs.transition(created.job.id, { status: 'preparing', stage: 'generating', submissionState: 'accepted' })
  const assets = []
  for (let index = 0; index < 2; index++) {
    const path = join(h.root, `result-${index}.png`)
    await sharp({ create: { width: 128, height: 128, channels: 4, background: index ? '#8799bb' : '#dde3eb' } }).png().toFile(path)
    assets.push(await h.opened.workspace.assets.importImage({ sourcePath: path, sourceType: 'generated', sourceId: created.job.id }))
  }
  const stale = await h.jobs.completeWithAssets(created.job.id, assets)
  await h.coordinator.observeJob(stale)
  expect(await h.workflows.getReservation(created.intent.id)).toMatchObject({ actualCostCny: null, costLimitCny: 2 })
  expect((await h.workflows.listResultRecords()).every((entry) => entry.actualCostCny === null)).toBe(true)
  const known = await h.jobs.recordCostReceipt(created.job.id, receipt())
  await h.jobs.recordCostReceipt(created.job.id, { ...receipt(), evidence: { ...receipt().evidence, observedAt: '2026-09-07T13:00:00.000Z' } })
  await h.coordinator.observeJob(stale) // Old event cannot overwrite the new authority.
  await h.coordinator.observeJob(known)
  expect(await h.workflows.getReservation(created.intent.id)).toMatchObject({ actualCostCny: 1.25, actualRequests: 1, actualImages: 2, costLimitCny: 2 })
  const records = await h.workflows.listResultRecords()
  expect(records).toHaveLength(2); expect(records.every((entry) => entry.cost?.actual.amount === 1.25)).toBe(true)
  const family = await h.coordinator.resultFamilies()
  expect(family.flatMap((entry) => entry.members).every((entry) => entry.actualCostCny === 1.25)).toBe(true)
  expect(summarizeGenerationCosts([known, known])).toEqual({ currencies: { CNY: 1.25 }, unknownJobs: 0, simulatedJobs: 0, inheritedJobs: 0 })
  await expect(h.jobs.recordCostReceipt(known.id, receipt(8))).rejects.toThrow(/Conflicting/)
  const reopened = new GenerationJobRepository(h.dbPath); closers.push(() => reopened.close())
  expect((await reopened.getJob(known.id)).cost).toEqual(known.cost)
  expect(h.network).not.toHaveBeenCalled()
})

it('represents simulated free, verified zero, nonzero and different currencies without converting or counting inherited spend', async () => {
  const h = await harness()
  const mock = await h.jobs.createJob({ projectId: h.opened.workspace.metadata.id, request: task('mock') })
  expect(mock.cost).toMatchObject({ actual: { status: 'known_free', source: 'offline_mock', amount: 0 }, estimate: { source: 'offline_simulation', amount: 999 } })
  const settled: GenerationJob[] = []
  for (const [amount, currency] of [[0, 'CNY'], [2.3, 'CNY'], [3, 'USD']] as const) {
    const job = await h.jobs.createJob({ projectId: h.opened.workspace.metadata.id, request: task(),
      costEstimate: { amount: 4, currency, source: 'provider_price', estimatedAt: new Date().toISOString(), parameters: { profileId: 'test', model: 'cost-model', imageCount: 1 } } })
    settled.push(await h.jobs.recordCostReceipt(job.id, receipt(amount, currency)))
  }
  const unknown = await h.jobs.createJob({ projectId: h.opened.workspace.metadata.id, request: task() })
  const free = await h.jobs.createJob({ projectId: h.opened.workspace.metadata.id, request: task() })
  const knownFree = await h.jobs.recordCostReceipt(free.id, { status: 'known_free', amount: 0, currency: 'CNY', source: 'provider_free_receipt', evidence: receipt().evidence })
  expect(formatGenerationCost(settled[0]!.cost)).toBe('实际回执 · ¥0.00')
  expect(formatGenerationCost(mock.cost)).toBe('离线模拟 · ¥0.00')
  expect(formatGenerationCost(unknown.cost)).toBe('费用未知')
  expect(settled[1]!.cost?.estimate?.amount).toBe(4)
  const summary = summarizeGenerationCosts([...settled, mock, unknown, knownFree, { ...settled[1]!, id: randomUUID(), copiedFromProjectId: randomUUID() }])
  expect(summary).toEqual({ currencies: { CNY: 2.3, USD: 3 }, unknownJobs: 1, simulatedJobs: 1, inheritedJobs: 1 })
  expect(formatGenerationCostSummary(summary)).toContain('1 笔费用未知')
})

it.each(['before', 'unknown', 'timeout', 'receipt-empty'] as const)('preserves fee and authorization facts for %s with zero local outputs', async (mode) => {
  const h = await harness(async (context) => {
    await context.onStage('submitting')
    if (mode === 'receipt-empty') { await context.onCostReceipt!(receipt(0.7)); return [] }
    if (mode === 'unknown') throw new Error('Synthetic uncertain POST')
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
    return []
  })
  const created = await h.create(2)
  if (mode === 'before') await h.queue.cancel(created.job.id)
  else { await h.queue.activate(created.job.id); await h.queue.waitForIdle() }
  const job = await h.jobs.getJob(created.job.id)
  await h.coordinator.observeJob(job); await h.coordinator.observeJob(job)
  expect(job.results).toHaveLength(0)
  expect(job.cost?.actual).toMatchObject(mode === 'receipt-empty' ? { status: 'actual_known', amount: 0.7 } : { status: 'unknown', amount: null })
  expect(await h.workflows.getReservation(created.intent.id)).toMatchObject({ status: 'committed', actualImages: 0, costLimitCny: 2,
    actualRequests: mode === 'before' ? 0 : 1, actualCostCny: mode === 'receipt-empty' ? 0.7 : null })
  expect(job.status).toBe(mode === 'before' ? 'cancelled' : mode === 'timeout' ? 'timed_out' : 'failed')
  expect(h.network).not.toHaveBeenCalled()
})

it('resumes a saved query identity and records settlement without another generation POST', async () => {
  let calls = 0
  const h = await harness(async (context) => { calls++; await context.onCostReceipt!(receipt(0.4)); return [] })
  const created = await h.create()
  await h.jobs.transition(created.job.id, { status: 'preparing', stage: 'generating', submissionState: 'accepted', externalTaskId: 'fake-accepted', startedAt: new Date().toISOString() })
  await h.queue.initialize(); await h.queue.waitForIdle()
  const current = await h.jobs.getJob(created.job.id)
  await h.coordinator.observeJob(current)
  expect(calls).toBe(1); expect(current.externalTaskId).toBe('fake-accepted')
  expect(current.cost?.actual.amount).toBe(0.4)
  expect((await h.workflows.getReservation(created.intent.id)).actualCostCny).toBe(0.4)
  expect(await h.jobs.listJobs(h.opened.workspace.metadata.id)).toHaveLength(1)
})

it('migrates synthetic old zero and nonzero as unverified while preserving original numeric facts and offline proof', async () => {
  const h = await harness()
  const unknown = await h.create()
  const mock = await h.jobs.createJob({ projectId: h.opened.workspace.metadata.id, request: task('mock') })
  const db = new Database(h.dbPath)
  db.prepare('UPDATE agent_budget_reservations SET actual_cost_cny = 3.5 WHERE intent_id = ?').run(unknown.intent.id)
  db.exec('ALTER TABLE generation_jobs DROP COLUMN cost_json; DELETE FROM schema_migrations WHERE version = 15;')
  db.close()
  const migration = runMigrations(h.dbPath)
  expect(migration).toMatchObject({ fromVersion: 14, toVersion: 15 })
  expect(migration.backupPath).not.toBeNull()
  expect((await h.jobs.getJob(unknown.job.id)).cost?.actual).toMatchObject({ status: 'unknown', source: 'legacy_unverified' })
  expect((await h.jobs.getJob(mock.id)).cost?.actual).toMatchObject({ status: 'known_free', source: 'offline_mock' })
  expect((await h.workflows.getReservation(unknown.intent.id)).actualCostCny).toBeNull()
  const check = new Database(h.dbPath, { readonly: true })
  expect(check.prepare('SELECT actual_cost_cny FROM agent_budget_reservations WHERE intent_id = ?').get(unknown.intent.id)).toEqual({ actual_cost_cny: 3.5 })
  check.close()
  expect(runMigrations(h.dbPath).backupPath).toBeNull()
})

it('carries a Fake provider receipt through real Main, Queue, persisted result family, restart and independent copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cost-main-')); paths.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_MAIN_COST_BOUNDARY') }); vi.stubGlobal('fetch', network)
  const runtime = await GenerationRuntime.create(join(root, 'userData')); closers.push(() => runtime.close())
  const source = await runtime.createProject(join(root, 'source.aicanvas'), 'Fee source')
  await runtime.setProviderConfig({ id: 'image-provider', kind: 'image', label: 'Synthetic Fee', baseUrl: 'https://cost.example.test/v1',
    protocol: 'openai-images', defaultModel: 'cost-model', timeoutMs: 30000, concurrency: 1,
    capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } })
  await runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-cost-fixture' })
  await runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 4, maxImagesPerJob: 2, maxCostCnyPerJob: 2 })
  const generate = vi.spyOn(OpenAiImagesProvider.prototype, 'generate').mockImplementation(async (_request, context) => {
    await context.onStage('submitting'); await context.onCostReceipt!(receipt(0.8))
    const filePath = join(root, 'fake-output.png')
    await sharp({ create: { width: 128, height: 128, channels: 4, background: '#cddaea' } }).png().toFile(filePath)
    return [{ filePath, mimeType: 'image/png' }]
  })
  const job = await runtime.enqueueProfile({ profileId: 'configured-final', confirmed: true, operation: 'generate',
    draft: { prompt: 'Fake receipt Main', negativePrompt: '', aspect: { width: 1, height: 1 }, quantity: 1, profileId: 'configured-final', referenceResultIds: [], sourceSceneRevision: null,
      referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: '', expandedSections: [] }, outputWidth: 128, outputHeight: 128,
    references: [], parameters: {}, sourceMessageId: null, parentResultId: null, modelOverride: null })
  await expect.poll(async () => (await runtime.listJobs()).find((entry) => entry.id === job.id)?.status).toBe('completed')
  await expect.poll(async () => (await runtime.resultFamilies())[0]?.members[0]?.actualCostCny).toBe(0.8)
  const current = (await runtime.listJobs())[0]!
  expect(current.request.parameters.actualCostCny).toBeUndefined()
  expect(current.cost?.actual.amount).toBe(0.8)
  const copied = await runtime.saveProjectAs(join(root, 'copy.aicanvas'))
  expect(copied.projectId).not.toBe(source.projectId)
  expect(summarizeGenerationCosts(await runtime.listJobs())).toMatchObject({ currencies: {}, inheritedJobs: 1, unknownJobs: 0 })
  const copyJobs = new GenerationJobRepository(join(root, 'copy.aicanvas', 'project.db')); closers.push(() => copyJobs.close())
  await expect(copyJobs.recordCostReceipt(current.id, receipt(9))).rejects.toThrow(/original active project/)
  await runtime.openRecentProject(source.projectId)
  expect((await runtime.listJobs())[0]?.cost).toEqual(current.cost)
  await runtime.close()
  const reopened = await GenerationRuntime.create(join(root, 'userData')); closers.push(() => reopened.close())
  expect((await reopened.listJobs())[0]?.cost).toEqual(current.cost)
  expect(generate).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled()
})
