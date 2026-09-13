import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { GenerationQueue } from '../../src/main/generation/generation-queue'
import { ReferenceCompiler } from '../../src/main/reference/reference-compiler'
import { generationProfileRequestSchema, type ReferenceMode, type GenerationProfileRequest } from '../../src/shared/generation'
import type { GenerationReferenceSource } from '../../src/shared/generation-reference'
import { generationWorkContextSchema } from '../../src/shared/project-work-context'
import { sceneElementSchema, type SceneCommand } from '../../src/domain'
import { makeImage, makeText } from '../fixtures/scene-fixtures'
import { compileOpenAiEditMask } from '../../src/main/edit/openai-edit-mask-compiler'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('') } }))
const runtimes: GenerationRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const configuration = { id: 'image-provider' as const, kind: 'image' as const, label: 'Synthetic Reference Provider',
  baseUrl: 'https://reference.example.test/v1', defaultModel: 'reference-model', protocol: 'openai-images' as const,
  timeoutMs: 45_000, concurrency: 1,
  capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ref-'))
  const runtime = await GenerationRuntime.create(join(root, 'userData')); runtimes.push(runtime)
  const project = join(root, 'reference.aicanvas'); await runtime.createProject(project, 'Reference fixture')
  await runtime.setProviderConfig(configuration)
  await runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'synthetic-reference-only' })
  await runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 8, maxImagesPerJob: 4, maxCostCnyPerJob: 2 })
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#e3d8c5' } }).png().toBuffer()
  const imported = await runtime.importAsset({ projectId: runtime.getWorkspaceBootstrap().projectId, name: 'chosen-product.png', mimeType: 'image/png', bytes: new Uint8Array(png) })
  const image = sceneElementSchema.parse({ ...makeImage(), assetId: imported.id })
  const title = makeText(1)
  const commands: SceneCommand[] = [{ kind: 'scene.set-canvas', canvas: { ...runtime.getWorkspaceBootstrap().scene.canvas, outputWidth: 256, outputHeight: 320, aspectWidth: 4, aspectHeight: 5 } },
    { kind: 'element.add', element: image }, { kind: 'element.add', element: title }]
  await mutate(runtime, commands)
  const calls: { url: string; fields: Record<string, unknown>; files: { field: string; hash: string }[] }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    const body = init.body
    const fields: Record<string, unknown> = {}; const files: { field: string; hash: string }[] = []
    if (body instanceof FormData) {
      for (const [field, value] of body.entries()) {
        if (typeof value === 'string') fields[field] = value
        else files.push({ field, hash: createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex') })
      }
    } else Object.assign(fields, JSON.parse(String(body)))
    calls.push({ url: String(url), fields, files })
    return Response.json({ data: Array.from({ length: Number(fields.n ?? 1) }, () => ({ b64_json: png.toString('base64') })) })
  }))
  return { root, project, runtime, imported, png, calls }
}
async function mutate(runtime: GenerationRuntime, commands: SceneCommand[]) {
  const { projectId, scene } = runtime.getWorkspaceBootstrap()
  const result = await runtime.executeSceneCommands({ projectId, expectedSceneRevision: scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: 'Synthetic reference scene', commands } })
  expect(result.ok).toBe(true)
}
async function request(runtime: GenerationRuntime, source: GenerationReferenceSource, mode: ReferenceMode = 'hybrid', profileId = 'configured-draft') {
  const { projectId } = runtime.getWorkspaceBootstrap()
  const preview = await runtime.previewGenerationReference({ projectId, source, referenceMode: mode, profileId, modelOverride: null })
  const value = generationProfileRequestSchema.parse({ projectId, profileId, referenceSource: source, expectedReferenceSignature: preview.signature,
    confirmed: true, operation: 'generate', draft: { prompt: '保持作品意图，柔和光线', negativePrompt: 'avoid clutter', aspect: { width: 4, height: 5 },
      quantity: 1, profileId, referenceResultIds: source.kind === 'result' ? [source.resultId] : [], sourceSceneRevision: source.kind === 'canvas' ? source.sceneRevision : null,
      referenceMode: mode, variationInstruction: '只改变光线', preserveConstraints: '保留主体身份', expandedSections: [] },
    outputWidth: 256, outputHeight: 320, references: [], parameters: { workflowIdempotencyKey: randomUUID() },
    parentResultId: source.kind === 'result' ? source.resultId : null })
  return { preview, value }
}
async function complete(runtime: GenerationRuntime, input: GenerationProfileRequest) {
  const job = await runtime.enqueueProfile(input)
  await expect.poll(async () => (await runtime.listJobs()).find((entry) => entry.id === job.id)?.status, { timeout: 7000 }).toBe('completed')
  return (await runtime.listJobs()).find((entry) => entry.id === job.id)!
}

it('makes text-only and all canvas modes match actual Main prompt packages and outbound image bytes', async () => {
  const h = await fixture()
  const text = await request(h.runtime, { kind: 'text' })
  const textJob = await complete(h.runtime, text.value)
  expect(text.preview.thumbnails).toEqual([])
  expect(textJob.request.parameters.promptPackage).toBeUndefined()
  expect(h.calls[0]).toMatchObject({ url: 'https://reference.example.test/v1/images/generations', fields: { model: 'reference-model', size: '256x320', n: 1 }, files: [] })
  expect(String(h.calls[0]!.fields.prompt)).not.toContain('NIGHT VEIL')
  const scene = h.runtime.getWorkspaceBootstrap().scene
  for (const mode of ['structure', 'visual', 'hybrid'] as const) {
    const { value, preview } = await request(h.runtime, { kind: 'canvas', sceneRevision: scene.revision }, mode)
    expect(preview.thumbnails).toHaveLength(1)
    const job = await complete(h.runtime, value)
    expect(job.request.parameters.promptIr).toMatchObject({ sceneId: scene.id, sceneRevision: scene.revision })
    expect(job.request.parameters.promptPackage).toMatchObject({ version: 1, referenceMode: mode, generationProfile: { model: 'reference-model' } })
    expect(job.request.parameters.referenceSourceSnapshot).toMatchObject({ signature: preview.signature, source: { kind: 'canvas', sceneRevision: scene.revision } })
    const call = h.calls.at(-1)!
    expect(String(call.fields.prompt)).toContain('只改变光线')
    expect(String(call.fields.prompt)).toContain('保留主体身份')
    if (mode !== 'visual') expect(String(call.fields.prompt)).toContain('NIGHT VEIL')
    else expect(String(call.fields.prompt)).not.toContain('NIGHT VEIL')
    expect(call.files).toHaveLength(mode === 'structure' ? 0 : mode === 'hybrid' ? 2 : 1)
    for (let index = 0; index < call.files.length; index++) {
      const url = await h.runtime.readAssetDataUrl(job.request.references[index]!.assetId, false)
      expect(call.files[index]!.hash).toBe(createHash('sha256').update(Buffer.from(url.split(',')[1]!, 'base64')).digest('hex'))
    }
  }
  expect(h.calls).toHaveLength(4)
})

it('sends only chosen images or the chosen result and refuses invented structural meaning', async () => {
  const h = await fixture()
  const source = { kind: 'images' as const, assetIds: [h.imported.id] }
  const visual = await request(h.runtime, source, 'visual')
  expect(visual.preview.supportedModes).toEqual(['visual'])
  const imageJob = await complete(h.runtime, visual.value)
  expect(imageJob.request.references.map((entry) => entry.assetId)).toEqual([h.imported.id])
  expect(h.calls[0]!.files[0]!.hash).toBe(createHash('sha256').update(h.png).digest('hex'))
  expect(String(h.calls[0]!.fields.prompt)).not.toContain('NIGHT VEIL')
  const result = imageJob.results[0]!
  const continuation = await request(h.runtime, { kind: 'result', resultId: result.id }, 'visual')
  const next = await complete(h.runtime, continuation.value)
  expect(next.request.references.map((entry) => entry.assetId)).toEqual([result.assetId])
  expect(next.parentJobId).toBeNull()
  expect(next.request.parentResultId).toBe(result.id)
  for (const mode of ['structure', 'hybrid'] as const) {
    const invalid = await request(h.runtime, source, mode)
    await expect(h.runtime.enqueueProfile(invalid.value)).rejects.toMatchObject({ code: 'REFERENCE_MODE_UNSUPPORTED' })
  }
  expect(h.calls).toHaveLength(2)
})

it('includes AI typography assets in the approved canvas preview and rejects changed bytes before submission', async () => {
  const h = await fixture()
  const scene = h.runtime.getWorkspaceBootstrap().scene
  const effectPng = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#d43b79' } }).png().toBuffer()
  const effect = await h.runtime.importAsset({ projectId: scene.projectId, name: 'synthetic-typography.png', mimeType: 'image/png', bytes: new Uint8Array(effectPng) })
  const text = sceneElementSchema.parse({ ...makeText(3), id: randomUUID(), renderStrategy: 'ai-material', resultAssetId: effect.id })
  await mutate(h.runtime, [{ kind: 'element.add', element: text }])
  const { preview, value } = await request(h.runtime, { kind: 'canvas', sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }, 'visual')
  expect.soft(preview.assetIds).toContain(effect.id)
  const submitted = await complete(h.runtime, value)
  const composite = Buffer.from((await h.runtime.readAssetDataUrl(submitted.request.references[0]!.assetId, false)).split(',')[1]!, 'base64')
  const expectedPreview = await sharp(composite).resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
  expect.soft(Buffer.from(preview.thumbnails[0]!.split(',')[1]!, 'base64').equals(expectedPreview)).toBe(true)
  const second = await request(h.runtime, { kind: 'canvas', sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }, 'visual')
  const path = join(h.project, 'assets', 'original', `${createHash('sha256').update(effectPng).digest('hex')}.png`)
  await writeFile(path, await sharp({ create: { width: 128, height: 128, channels: 4, background: '#2a8b5c' } }).png().toBuffer())
  await expect(h.runtime.enqueueProfile(second.value)).rejects.toThrow(/参考文件内容已经变化/)
  expect(h.calls).toHaveLength(1)
})

it('rejects stale Scene/configuration previews and replays an already prepared invocation without refreshing or reposting', async () => {
  const h = await fixture()
  const oldScene = h.runtime.getWorkspaceBootstrap().scene
  const old = await request(h.runtime, { kind: 'canvas', sceneRevision: oldScene.revision })
  await mutate(h.runtime, [{ kind: 'scene.set-canvas', canvas: { ...oldScene.canvas, globalStyle: 'Changed after preview' } }])
  await expect(h.runtime.enqueueProfile(old.value)).rejects.toMatchObject({ code: 'REFERENCE_REVIEW_REQUIRED' })
  const text = await request(h.runtime, { kind: 'text' })
  await h.runtime.setProviderConfig({ ...configuration, defaultModel: 'new-model' })
  await expect(h.runtime.enqueueProfile(text.value)).rejects.toMatchObject({ code: 'REFERENCE_REVIEW_REQUIRED' })
  const current = await request(h.runtime, { kind: 'canvas', sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision })
  const job = await h.runtime.enqueueProfile(current.value, { deferActivation: true })
  await mutate(h.runtime, [{ kind: 'element.remove', elementId: oldScene.elements[1]!.id }])
  expect((await h.runtime.enqueueProfile(current.value, { deferActivation: true })).id).toBe(job.id)
  expect(h.calls).toHaveLength(0)
})

it('rejects source replacement during canvas compilation even when the original bytes are restored afterward', async () => {
  const h = await fixture()
  const input = await request(h.runtime, { kind: 'canvas', sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }, 'visual')
  const path = join(h.project, 'assets', 'original', `${createHash('sha256').update(h.png).digest('hex')}.png`)
  const compile = ReferenceCompiler.prototype.compile
  vi.spyOn(ReferenceCompiler.prototype, 'compile').mockImplementation(async function (this: ReferenceCompiler, ...args) {
    await writeFile(path, await sharp({ create: { width: 128, height: 128, channels: 4, background: '#cb4141' } }).png().toBuffer())
    try { return await compile.apply(this, args) } finally { await writeFile(path, h.png) }
  })
  await expect(h.runtime.enqueueProfile(input.value)).rejects.toThrow(/参考文件内容已经变化/)
  expect(h.calls).toHaveLength(0)
})

it.each(['openai-images', 'ark-seedream'] as const)('rejects %s reference bytes replaced after approval and enqueue before sending', async (protocol) => {
  const h = await fixture()
  await h.runtime.setProviderConfig({ ...configuration, protocol })
  let queue: Pick<GenerationQueue, 'activate' | 'waitForIdle'> | undefined
  const prepare = GenerationQueue.prototype.prepare
  vi.spyOn(GenerationQueue.prototype, 'prepare').mockImplementation(function (this: GenerationQueue, ...args) {
    queue = { activate: this.activate.bind(this), waitForIdle: this.waitForIdle.bind(this) }
    return prepare.apply(this, args)
  })
  const input = await request(h.runtime, { kind: 'images', assetIds: [h.imported.id] }, 'visual')
  const job = await h.runtime.enqueueProfile(input.value, { deferActivation: true })
  const path = join(h.project, 'assets', 'original', `${createHash('sha256').update(h.png).digest('hex')}.png`)
  await writeFile(path, await sharp({ create: { width: 128, height: 128, channels: 4, background: '#cb4141' } }).png().toBuffer())
  if (queue === undefined) throw new Error('Real queue did not prepare the reference request.')
  await queue.activate(job.id)
  await queue.waitForIdle()
  const settled = (await h.runtime.listJobs()).find((entry) => entry.id === job.id)!
  expect.soft(h.calls).toHaveLength(0)
  expect(settled).toMatchObject({ status: 'failed', submissionState: 'not_sent', error: { code: 'REFERENCE_ASSET_CHANGED' } })
})

it('rejects deleted, changed and foreign assets without an outbound request', async () => {
  const h = await fixture()
  const input = await request(h.runtime, { kind: 'images', assetIds: [h.imported.id] }, 'visual')
  const path = join(h.project, 'assets', 'original', `${createHash('sha256').update(h.png).digest('hex')}.png`)
  const original = await readFile(path)
  await writeFile(path, Buffer.from('changed-fixture-bytes'))
  await expect(h.runtime.enqueueProfile(input.value)).rejects.toThrow(/参考文件内容已经变化/)
  await writeFile(path, original)
  await unlink(path)
  await expect(h.runtime.enqueueProfile(input.value)).rejects.toThrow(/参考素材无法读取/)
  await writeFile(path, original)
  const { projectId } = h.runtime.getWorkspaceBootstrap()
  await h.runtime.createProject(join(h.root, 'other.aicanvas'), 'Other')
  await expect(h.runtime.enqueueProfile(input.value)).rejects.toThrow(/PROJECT_CHANGED/)
  await expect(h.runtime.previewGenerationReference({ projectId: h.runtime.getWorkspaceBootstrap().projectId,
    profileId: 'configured-draft', modelOverride: null, source: { kind: 'images', assetIds: [h.imported.id] }, referenceMode: 'visual' })).rejects.toThrow(/不属于当前项目/)
  await expect(h.runtime.previewGenerationReference({ projectId, profileId: 'configured-draft', modelOverride: null,
    source: { kind: 'result', resultId: randomUUID() }, referenceMode: 'visual' })).rejects.toThrow(/PROJECT_CHANGED/)
  expect(h.calls).toHaveLength(0)
})

it('rejects unsupported hybrid instead of dropping the bitmap and uses honest quantity/model/size strategies', async () => {
  const h = await fixture()
  const profiles = h.runtime.listProfiles().profiles
  expect(profiles.find((entry) => entry.profile.id === 'configured-draft')?.profile).toMatchObject({ label: '多候选探索', defaultQuantity: 4, maxQuantity: 4, modelId: 'reference-model' })
  expect(profiles.find((entry) => entry.profile.id === 'configured-final')?.profile).toMatchObject({ label: '单张生成', defaultQuantity: 1, maxQuantity: 1, modelId: 'reference-model' })
  expect(profiles.find((entry) => entry.profile.id === 'configured-layer')?.profile.label).toBe('局部编辑')
  const single = await request(h.runtime, { kind: 'text' }, 'hybrid', 'configured-final')
  await expect(h.runtime.enqueueProfile({ ...single.value, draft: { ...single.value.draft, quantity: 2 } })).rejects.toMatchObject({ code: 'PROFILE_QUANTITY_EXCEEDED' })
  await complete(h.runtime, single.value)
  expect(h.calls.at(-1)!.fields).toMatchObject({ model: 'reference-model', n: 1, size: '256x320' })
  await h.runtime.setProviderConfig({ ...configuration, defaultModel: 'second-model' })
  const scaled = await request(h.runtime, { kind: 'canvas', sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }, 'structure')
  const wide = await complete(h.runtime, { ...scaled.value, draft: { ...scaled.value.draft, quantity: 3, aspect: { width: 16, height: 9 } }, outputWidth: 512, outputHeight: 288 })
  expect(h.calls.at(-1)!.fields).toMatchObject({ model: 'second-model', n: 3, size: '512x288' })
  expect(String(h.calls.at(-1)!.fields.prompt)).toContain('输出画布：16:9，512×288')
  expect(wide.request.parameters.promptIr).toMatchObject({ canvas: { aspectWidth: 4, aspectHeight: 5 } })
  expect(wide.request.parameters.promptPackage).toMatchObject({ targetOutput: { aspectWidth: 16, aspectHeight: 9, outputWidth: 512, outputHeight: 288 } })
  await h.runtime.setProviderConfig({ ...configuration, capabilities: { ...configuration.capabilities, imageReferences: false, multipleReferences: false, maskEditing: false } })
  const source = { kind: 'canvas' as const, sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }
  const hybrid = await request(h.runtime, source)
  expect(hybrid.preview.supportedModes).toEqual(['structure'])
  await expect(h.runtime.enqueueProfile(hybrid.value)).rejects.toMatchObject({ code: 'REFERENCE_MODE_UNSUPPORTED' })
  await complete(h.runtime, (await request(h.runtime, source, 'structure')).value)
  expect(h.calls.at(-1)!.files).toHaveLength(0)
})

it('compiles the authoritative mask and source into the real edit request without trusting altered Renderer content', async () => {
  const h = await fixture()
  const source = h.runtime.getWorkspaceBootstrap().scene.elements.find((element) => element.type === 'image')!
  const mask = sceneElementSchema.parse({ ...source, id: randomUUID(), type: 'mask', name: 'Chosen background area', zIndex: 2,
    semanticRole: 'edit-mask', referencePolicy: 'exclude', mode: 'edit', targetElementId: source.id,
    paths: [{ id: randomUUID(), points: [{ x: .1, y: .1 }, { x: .8, y: .1 }, { x: .8, y: .8 }], closed: true }], feather: .02 })
  await mutate(h.runtime, [{ kind: 'element.add', element: mask }])
  const scene = h.runtime.getWorkspaceBootstrap().scene
  const input = { scene: { ...scene, elements: scene.elements.filter((element) => element.type !== 'mask') }, targetElementId: source.id,
    prompt: '只修改蒙版内的光线', negativePrompt: '', providerId: 'image-provider', model: 'reference-model', count: 1,
    profileId: 'configured-layer', confirmed: true, sourceMessageId: null, parentResultId: null }
  const edited = await h.runtime.editFromCanvas(input)
  await expect.poll(async () => (await h.runtime.listJobs()).find((entry) => entry.id === edited.jobId)?.status).toBe('completed')
  const job = (await h.runtime.listJobs()).find((entry) => entry.id === edited.jobId)!
  expect(job.request.parameters.contributingMaskIds).toEqual([mask.id])
  expect(job.request.parameters.referenceSourceSnapshot).toMatchObject({ sceneRevision: scene.revision, assetIds: [h.imported.id, edited.maskAssetId] })
  const sentMask = h.calls[0]!.files.find((file) => file.field === 'mask')!
  const dataUrl = await h.runtime.readAssetDataUrl(edited.maskAssetId, false)
  const protocolMask = await compileOpenAiEditMask(Buffer.from(dataUrl.split(',')[1]!, 'base64'))
  expect(sentMask.hash).toBe(createHash('sha256').update(protocolMask).digest('hex'))
  expect(h.calls[0]!.files.find((file) => file.field === 'image[]')!.hash).toBe(createHash('sha256').update(h.png).digest('hex'))
  expect((await h.runtime.readAssetDataUrl(h.imported.id, false))).toBe(`data:image/png;base64,${h.png.toString('base64')}`)
})

it('uses the authoritative Scene in legacy/Agent canvas calls and rejects a mid-compile edit', async () => {
  const h = await fixture()
  const scene = h.runtime.getWorkspaceBootstrap().scene
  const input = { scene: { ...scene, elements: [] }, originalRequirement: 'Synthetic Main authority', providerId: 'image-provider', model: 'reference-model',
    count: 1, profileId: 'configured-draft', confirmed: true, referenceMode: 'hybrid' as const, sourceMessageId: null }
  const result = await h.runtime.generateFromCanvas(input, 'authoritative-scene', undefined, true)
  expect(result.promptIr.elements.map((entry) => entry.id)).toEqual(scene.elements.map((entry) => entry.id))
  const compile = ReferenceCompiler.prototype.compile
  vi.spyOn(ReferenceCompiler.prototype, 'compile').mockImplementationOnce(async function (this: ReferenceCompiler, ...args) {
    const compilation = await compile.apply(this, args)
    await mutate(h.runtime, [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: 'mid-compile' } }])
    return compilation
  })
  await expect(h.runtime.generateFromCanvas(input, 'changed-during-compile', undefined, true)).rejects.toMatchObject({ code: 'REFERENCE_REVIEW_REQUIRED' })
  expect(h.calls).toHaveLength(0)
})

it('keeps legacy draft modes unresolved and never attaches a canvas just because a mode was saved', () => {
  expect(generationWorkContextSchema.parse({}).referenceSource).toEqual({ kind: 'text' })
  const old = generationWorkContextSchema.parse({ prompt: '保留旧文字', referenceMode: 'structure' })
  expect(old).toMatchObject({ prompt: '保留旧文字', referenceSource: { kind: 'unresolved' } })
  const resultId = randomUUID()
  expect(generationWorkContextSchema.parse({ referenceResultId: resultId, referenceMode: 'hybrid' }).referenceSource).toEqual({ kind: 'result', resultId })
})
