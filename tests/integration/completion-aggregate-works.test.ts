import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { sceneElementSchema, type Scene, type SceneCommand } from '../../src/domain'
import { DeterministicMockPlanner } from '../../src/main/agent'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { CompositeReferenceRenderer } from '../../src/main/reference/composite-reference-renderer'
import { isTerminalAgentTurnStatus } from '../../src/shared/agent-harness'
import type { AgentPlan } from '../../src/shared/agent'
import { generationProfileRequestSchema, type GenerationJob } from '../../src/shared/generation'
import type { GenerationReferenceSource } from '../../src/shared/generation-reference'
import { defaultProjectWorkContext } from '../../src/shared/project-work-context'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'
import { COMPLETION_SIZE, completionImage, completionLandscape, completionProduct, completionTypography } from '../fixtures/completion-artwork'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join('') } }))
const runtimes: GenerationRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
const config = { id: 'image-provider' as const, kind: 'image' as const, label: 'Offline acceptance fixture', baseUrl: 'https://completion.example.test/v1',
  defaultModel: 'completion-image-fixture', protocol: 'openai-images' as const, timeoutMs: 45_000, concurrency: 1,
  capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false } }
async function mutate(runtime: GenerationRuntime, summary: string, commands: SceneCommand[]) {
  const { projectId, scene } = runtime.getWorkspaceBootstrap()
  const value = await runtime.executeSceneCommands({ projectId, expectedSceneRevision: scene.revision, batch: { id: randomUUID(), origin: 'user', summary, commands } })
  expect(value.ok, summary).toBe(true)
  return runtime.getWorkspaceBootstrap().scene
}
async function complete(runtime: GenerationRuntime, id: string): Promise<GenerationJob> {
  await expect.poll(async () => (await runtime.listJobs()).find((job) => job.id === id)?.status, { timeout: 15_000 }).toBe('completed')
  return (await runtime.listJobs()).find((job) => job.id === id)!
}
async function generate(runtime: GenerationRuntime, source: GenerationReferenceSource, quantity: number, prompt: string, mode: 'visual' | 'hybrid' = 'hybrid') {
  const { projectId } = runtime.getWorkspaceBootstrap()
  const preview = await runtime.previewGenerationReference({ projectId, source, profileId: 'configured-draft', modelOverride: null, referenceMode: mode })
  const request = generationProfileRequestSchema.parse({ projectId, profileId: 'configured-draft', operation: 'generate', confirmed: true,
    referenceSource: source, expectedReferenceSignature: preview.signature, outputWidth: COMPLETION_SIZE.width, outputHeight: COMPLETION_SIZE.height,
    draft: { prompt, negativePrompt: '', aspect: { width: 4, height: 5 }, quantity, profileId: 'configured-draft', referenceMode: mode,
      referenceResultIds: source.kind === 'result' ? [source.resultId] : [], sourceSceneRevision: source.kind === 'canvas' ? source.sceneRevision : null,
      variationInstruction: '只调整环境光线，保留主体与排版区域', preserveConstraints: '保留山海/商品主体轮廓；中文标题由画布文字精确排版', expandedSections: [] },
    references: [], parameters: { workflowIdempotencyKey: randomUUID() }, parentResultId: source.kind === 'result' ? source.resultId : null })
  return { job: await complete(runtime, (await runtime.enqueueProfile(request)).id), preview }
}
async function renderArtifact(runtime: GenerationRuntime, projectPath: string, file: string) {
  const db = new Database(join(projectPath, 'project.db'), { readonly: true })
  const assets = db.prepare('SELECT id, relative_path FROM assets').all() as { id: string; relative_path: string }[]
  db.close()
  const renderer = new CompositeReferenceRenderer(async (id) => { const asset = assets.find((row) => row.id === id); return asset ? join(projectPath, asset.relative_path) : null })
  const scene = runtime.getWorkspaceBootstrap().scene
  const rendered = await renderer.render(scene, 'final')
  expect(rendered.warnings).toEqual([])
  await writeFile(file, rendered.buffer)
  const metadata = await sharp(rendered.buffer).metadata()
  expect(metadata).toMatchObject(COMPLETION_SIZE)
  return { file, sha256: hash(rendered.buffer), width: metadata.width, height: metadata.height, sceneRevision: scene.revision,
    exactTexts: scene.elements.filter((element) => element.type === 'text').map((element) => element.content) }
}

it('completes the same cover, product and independent copy through real Main, reference HTTP, local mask, export and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'works-'))
  const userData = join(root, 'userData')
  const evidence = join(process.env.AI_CANVAS_TEST_BATCH_ROOT!, 'artifacts', 'completion-works')
  await mkdir(evidence, { recursive: true })
  let runtime = await GenerationRuntime.create(userData); runtimes.push(runtime)
  await runtime.setProviderConfig(config)
  await runtime.setProviderSecret({ providerId: 'image-provider', apiKey: 'offline-synthetic-not-a-real-key' })
  await runtime.setProviderExecutionPolicy({ approvalMode: 'confirm_each', autoGenerate: false, maxRequestsPerJob: 8, maxImagesPerJob: 4, maxCostCnyPerJob: 10 })
  const calls: { projectId: string; url: string; fields: Record<string, unknown>; files: { field: string; sha256: string; width?: number; height?: number }[] }[] = []
  let transmittedMask: Buffer | null = null
  let output: Buffer[] = [], hold = false
  const fakeHttp = vi.fn(async (url: URL | string, init: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/completion\.example\.test\/v1\/images\/(generations|edits)$/)
    const fields: Record<string, unknown> = {}, files: { field: string; sha256: string; width?: number; height?: number }[] = []
    if (init.body instanceof FormData) for (const [field, value] of init.body.entries()) {
      if (typeof value === 'string') fields[field] = value
      else { const bytes = Buffer.from(await value.arrayBuffer()); if (field === 'mask') transmittedMask = bytes; const meta = await sharp(bytes).metadata(); files.push({ field, sha256: hash(bytes), width: meta.width, height: meta.height }) }
    } else Object.assign(fields, JSON.parse(String(init.body)))
    calls.push({ projectId: runtime.getWorkspaceBootstrap().projectId, url: String(url), fields, files })
    if (hold) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason)
      else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    return Response.json({ data: Array.from({ length: Number(fields.n ?? 1) }, (_, i) => ({ b64_json: output[i % output.length]!.toString('base64') })) })
  })
  vi.stubGlobal('fetch', fakeHttp)
  const works: Record<string, unknown>[] = []
  let cover: { path: string; projectId: string; titleId: string; imageId: string; resultId: string; firstId: string; scene: Scene } | undefined
  for (const kind of ['cover', 'product'] as const) {
    const name = kind === 'cover' ? '山海之间 · 完整创作 A' : '晨雾 · 商品主视觉 B'
    const projectPath = join(root, `${kind}.aicanvas`)
    await runtime.createProject(projectPath, name)
    const projectId = runtime.getWorkspaceBootstrap().projectId
    const candidateA = kind === 'cover' ? await completionLandscape(0) : await completionProduct(0)
    const candidateB = kind === 'cover' ? await completionLandscape(1) : await completionProduct(1)
    expect(hash(candidateA)).not.toBe(hash(candidateB))
    output = [candidateA, candidateB]
    const source = kind === 'cover' ? candidateA : await completionProduct(0, true)
    const imported = await runtime.importAsset({ projectId, name: `${kind}-synthetic-source.png`, mimeType: 'image/png', bytes: new Uint8Array(source) })
    await writeFile(join(evidence, `${kind}-source.png`), source)
    const background = completionImage(imported.id, kind === 'cover' ? '远山与海面' : '合成香水原始素材')
    const typography = completionTypography(kind)
    const title = typography[0]!
    const input = fixtureAgentRequest(runtime.getWorkspaceBootstrap().scene, kind === 'cover'
      ? '创建一张 4:5 山海封面，标题“山海之境”，远山与海面，保持大面积安静留白。先建立可编辑构图，不生成。'
      : '创建一张 4:5 香水商品海报，标题“晨雾”，保留已导入瓶身轮廓、AUREL 标签与 50 mL 容量，柔和侧光，准确文字保持可编辑。先不生成。')
    const base = await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal)
    if (base.designContract?.version !== 2 || base.designContract.brief.version !== 3) throw new Error('Current semantic Brief was not created')
    const brief = { ...base.designContract.brief, acceptanceCriteria: [{ id: randomUUID(), priority: 'must' as const,
      criterion: kind === 'cover' ? '画面有安静的山海气韵与自然留白' : '商品瓶身、标签与真实材质保持自然一致' }] }
    const contextCommand = base.tools.flatMap((tool) => tool.kind === 'scene_batch' ? tool.commands : []).find((command) => command.kind === 'scene.set-creative-context')
    if (contextCommand?.kind !== 'scene.set-creative-context' || !contextCommand.creativeContext) throw new Error('Creative context missing')
    const initialTitle = sceneElementSchema.parse({ ...title, content: kind === 'cover' ? '山海之境' : '晨雾' })
    const plan: AgentPlan = { ...base, summary: '分三批建立作品、主体与准确文字', response: '可编辑构图已建立，请检查画面并继续精修。',
      designContract: { ...base.designContract, brief }, tools: [
        { kind: 'scene_batch', summary: '建立画布与明确要求', commands: [
          { ...contextCommand, creativeContext: { ...contextCommand.creativeContext, brief } },
          { kind: 'scene.set-canvas', canvas: { ...runtime.getWorkspaceBootstrap().scene.canvas, outputWidth: 1200, outputHeight: 1500, aspectWidth: 4, aspectHeight: 5, backgroundColor: '#e7ede4', globalStyle: '轻盈留白、安静层次、自然光线' } }
        ] },
        { kind: 'scene_batch', summary: '放置明确素材与构图主体', commands: [{ kind: 'element.add', element: background }] },
        { kind: 'scene_batch', summary: '建立可编辑中文与细节排版', commands: [initialTitle, ...typography.slice(1)].map((element) => ({ kind: 'element.add', element })) }
      ] }
    const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(plan)
    await runtime.startAgentRun({ ...input, projectId }, 'auto')
    await expect.poll(async () => (await runtime.getAgentHarnessSnapshot()).turns.every((turn) => isTerminalAgentTurnStatus(turn.status)), { timeout: 12_000 }).toBe(true)
    const harness = await runtime.getAgentHarnessSnapshot()
    const results = harness.items.filter((item) => item.type === 'tool_result').map((item) => (item.payload as { outcome: { sceneRevisionBefore: number; sceneRevisionAfter: number } }).outcome)
    expect(results).toEqual([expect.objectContaining({ sceneRevisionBefore: 0, sceneRevisionAfter: 1 }), expect.objectContaining({ sceneRevisionBefore: 1, sceneRevisionAfter: 2 }), expect.objectContaining({ sceneRevisionBefore: 2, sceneRevisionAfter: 3 })])
    const receipt = (await runtime.getConversation()).messages.findLast((message) => message.kind === 'receipt')!
    expect(receipt.receipt?.completion?.unverifiedMust).toEqual([expect.objectContaining({ label: `必须：${brief.acceptanceCriteria[0]!.criterion}` })])
    expect(receipt.receipt?.completion?.userAcceptance).toBeNull()
    planner.mockRestore()
    const revisions = [{ step: 'Agent三批', revision: runtime.getWorkspaceBootstrap().scene.revision }]
    const corrected = await mutate(runtime, '人工精修准确标题、字重和位置', [{ kind: 'element.update', elementId: title.id,
      changes: { content: kind === 'cover' ? '山海之间' : '晨雾', fontWeight: 500, transform: { ...title.transform, y: .183 } } }])
    expect(corrected.elements.find((element) => element.id === title.id)).toMatchObject({ type: 'text', fontWeight: 500, content: kind === 'cover' ? '山海之间' : '晨雾' })
    revisions.push({ step: '人工排版', revision: corrected.revision })
    const referenceSource = kind === 'cover' ? { kind: 'canvas' as const, sceneRevision: corrected.revision } : { kind: 'images' as const, assetIds: [imported.id] }
    const generated = await generate(runtime, referenceSource, 2, '保留主体和中文排版留白，只给环境两种光线方案。', kind === 'cover' ? 'hybrid' : 'visual')
    expect(generated.job.results).toHaveLength(2)
    const [first, second] = generated.job.results
    expect(generated.job.request.parameters.referenceSourceSnapshot).toMatchObject({ signature: generated.preview.signature, source: referenceSource })
    expect(calls.at(-1)!.files.length).toBeGreaterThan(0)
    expect(calls.at(-1)!.fields).toMatchObject({ n: '2', size: '1200x1500', model: 'completion-image-fixture' })
    if (kind === 'product') expect(calls.at(-1)!.files[0]!.sha256).toBe(hash(source))
    else expect(generated.job.request.parameters.promptIr).toMatchObject({ sceneRevision: corrected.revision })
    expect(hash(Buffer.from((await runtime.readAssetDataUrl(first!.assetId, false)).split(',')[1]!, 'base64'))).toBe(hash(candidateA))
    expect(hash(Buffer.from((await runtime.readAssetDataUrl(second!.assetId, false)).split(',')[1]!, 'base64'))).toBe(hash(candidateB))
    const context = defaultProjectWorkContext(projectId)
    context.generation = { ...context.generation, prompt: '下一步只微调环境，保留准确文字', referenceSource: { kind: 'result', resultId: second!.id }, referenceMode: 'visual',
      referenceResultId: second!.id, focusedResultId: second!.id, compareAId: first!.id, compareBId: second!.id, compareEnabled: true, compareActiveSide: 'B', expandedSections: [] }
    context.conversationDraft = '请保留已确认的标题与主体。'
    for (const focus of ['conversation', 'canvas', 'generate'] as const) { context.workspace.activeView = focus; runtime.saveProjectWorkContext(context) }
    expect(runtime.getWorkspaceBootstrap().workContext?.generation).toEqual(context.generation)
    const placement = await runtime.placeGenerationResult({ projectId, resultId: second!.id, placementId: randomUUID(), origin: 'user' })
    await mutate(runtime, '结果回画布，保留独立文字图层', [
      { kind: 'element.remove', elementId: background.id },
      { kind: 'element.update', elementId: placement.elementId, changes: { transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, fit: 'fill' } },
      { kind: 'element.reorder', elementId: placement.elementId, toIndex: 0 }
    ])
    const mask = sceneElementSchema.parse({ ...completionImage(second!.assetId, '仅改环境的局部区域'), id: randomUUID(), type: 'mask', referencePolicy: 'exclude', mode: 'edit', targetElementId: placement.elementId,
      paths: [{ id: randomUUID(), points: [{ x: .05, y: .45 }, { x: .30, y: .45 }, { x: .30, y: .84 }, { x: .05, y: .84 }], closed: true }], feather: .025 })
    await mutate(runtime, '只绘制主体左侧环境蒙版', [{ kind: 'element.add', element: mask }])
    output = [candidateA]
    const edit = await runtime.editFromCanvas({ scene: runtime.getWorkspaceBootstrap().scene, targetElementId: placement.elementId, prompt: '只调整左侧环境为更柔和的晨光。瓶身/山脉主体和画布文字保持不变。',
      negativePrompt: '', providerId: 'image-provider', model: 'completion-image-fixture', count: 1, profileId: 'configured-layer', confirmed: true, sourceMessageId: null, parentResultId: second!.id })
    const edited = await complete(runtime, edit.jobId)
    expect(edited.request).toMatchObject({ kind: 'edit', sourceAssetId: second!.assetId, maskAssetId: edit.maskAssetId, parentResultId: second!.id })
    const bytes = Buffer.from((await runtime.readAssetDataUrl(edit.maskAssetId, false)).split(',')[1]!, 'base64')
    expect(transmittedMask).not.toBeNull()
    const grayPixels = await sharp(bytes).greyscale().removeAlpha().raw().toBuffer()
    const transmitted = await sharp(transmittedMask!).raw().toBuffer({ resolveWithObject: true })
    expect(transmitted.info).toMatchObject({ width: 1200, height: 1500, channels: 4 })
    expect(Buffer.from(grayPixels.map((value) => 255 - value))).toEqual(Buffer.from(grayPixels.map((_value, index) => transmitted.data[index * 4 + 3]!)))
    expect(calls.at(-1)!.files.some((file) => file.field === 'mask' && file.sha256 === hash(transmittedMask!))).toBe(true)
    expect(calls.at(-1)!.files.some((file) => file.sha256 === hash(candidateB))).toBe(true)
    const maskPixels = transmitted
    const alphaAt = (x: number, y: number) => maskPixels.data[(Math.floor(y * maskPixels.info.height) * maskPixels.info.width + Math.floor(x * maskPixels.info.width)) * 4 + 3]
    expect(alphaAt(.17, .6)).toBe(0)
    expect(alphaAt(.5, .6)).toBe(255)
    const editedResult = edited.results[0]!
    const finalPlacement = await runtime.placeGenerationResult({ projectId, resultId: editedResult.id, placementId: randomUUID(), origin: 'user' })
    const finalScene = await mutate(runtime, '选定局部版本回画布精修，保留准确文字', [
      { kind: 'element.remove', elementId: mask.id }, { kind: 'element.remove', elementId: placement.elementId },
      { kind: 'element.update', elementId: finalPlacement.elementId, changes: { transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, fit: 'fill' } },
      { kind: 'element.reorder', elementId: finalPlacement.elementId, toIndex: 0 },
      { kind: 'element.update', elementId: typography[3]!.id, changes: { content: kind === 'cover' ? '在山的远处，听见海。' : '晨雾香氛  /  淡香精  /  50 mL' } }
    ])
    revisions.push({ step: '局部结果回画布', revision: finalScene.revision })
    expect(finalScene.elements).toHaveLength(5)
    expect((await runtime.resultFamilies()).flatMap((family) => family.members).find((member) => member.resultId === editedResult.id)?.parentResultId).toBe(second!.id)
    context.generation = { ...context.generation, focusedResultId: editedResult.id, compareAId: second!.id, compareBId: editedResult.id, referenceSource: { kind: 'result', resultId: editedResult.id }, referenceResultId: editedResult.id }
    context.workspace = { ...context.workspace, activeView: 'canvas', selectedIds: [title.id] }
    runtime.saveProjectWorkContext(context)
    const artifact = await renderArtifact(runtime, projectPath, join(evidence, `${kind}-current-main.png`))
    await writeFile(join(evidence, `${kind}-scene.json`), JSON.stringify(finalScene, null, 2))
    await runtime.close()
    runtime = await GenerationRuntime.create(userData); runtimes.push(runtime)
    expect(runtime.getWorkspaceBootstrap().scene).toEqual(finalScene)
    expect(runtime.getWorkspaceBootstrap().workContext).toEqual(context)
    expect((await runtime.getConversation()).messages.find((message) => message.id === receipt.id)?.receipt?.completion?.userAcceptance).toBeNull()
    works.push({ kind, name, projectId, projectPath, userData, brief: input.text, revisions, titleId: title.id, imageId: finalPlacement.elementId,
      resultId: editedResult.id, compare: context.generation, importedAssetId: imported.id, originalInputHash: hash(source), maskHash: hash(bytes), artifact, resumed: true,
      visualAcceptance: 'Unverified visual must remains pending; original deterministic fixture graphics do not prove online quality.' })
    if (kind === 'cover') cover = { path: projectPath, projectId, titleId: title.id, imageId: finalPlacement.elementId, resultId: editedResult.id, firstId: second!.id, scene: finalScene }
  }

  if (!cover) throw new Error('Cover aggregate missing')
  await runtime.openProject(cover.path)
  const coverContext = runtime.getWorkspaceBootstrap().workContext!
  const changed = await mutate(runtime, '副本前修改标题再撤销', [{ kind: 'element.update', elementId: cover.titleId, changes: { content: '山海之间 · 夜航', fill: '#254851' } }])
  expect((await runtime.undoScene({ projectId: cover.projectId, expectedSceneRevision: changed.revision, batchId: null })).ok).toBe(true)
  const copyPath = join(root, 'copy.aicanvas')
  const copy = await runtime.saveProjectAs(copyPath)
  expect(copy.projectId).not.toBe(cover.projectId)
  expect(copy.canRedo).toBe(true)
  expect(copy.workContext?.generation).toEqual(coverContext.generation)
  expect((await runtime.redoScene({ projectId: copy.projectId, expectedSceneRevision: copy.scene.revision, batchId: null })).ok).toBe(true)
  expect(runtime.getWorkspaceBootstrap().scene.elements.find((element) => element.id === cover.titleId)).toMatchObject({ content: '山海之间 · 夜航' })
  await mutate(runtime, '副本独立精修标题', [{ kind: 'element.update', elementId: cover.titleId, changes: { content: '山海之间', fontWeight: 400, fill: '#254851' } },
    { kind: 'element.update', elementId: runtime.getWorkspaceBootstrap().scene.elements.find((element) => element.name === '英文副题')!.id, changes: { content: 'ANOTHER LIGHT  /  ANOTHER JOURNEY' } }])
  const copyBeforeSource = runtime.getWorkspaceBootstrap().scene
  await runtime.openProject(cover.path)
  expect(runtime.getWorkspaceBootstrap().scene.elements.find((element) => element.id === cover.titleId)).toMatchObject({ content: '山海之间', fontWeight: 500 })
  const sourceScene = await mutate(runtime, '源项目独立调整页脚', [{ kind: 'element.update', elementId: runtime.getWorkspaceBootstrap().scene.elements.find((element) => element.name === '准确页脚')!.id,
    changes: { content: '在山的远处，听见海。 / 原作' } }])
  await runtime.openProject(copyPath)
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(copyBeforeSource)
  await expect(runtime.retry((await runtime.listJobs())[0]!.id)).rejects.toMatchObject({ code: 'PROJECT_COPY_REQUIRES_NEW_REQUEST' })
  output = [await completionLandscape(1)]
  const continued = await generate(runtime, { kind: 'result', resultId: cover.resultId }, 1, '副本独立的光线变化；保留准确中文', 'visual')
  expect(continued.job.copiedFromProjectId).toBeNull()
  const fresh = continued.job.results[0]!
  await mutate(runtime, '副本放入新结果保留独立排版', [{ kind: 'element.update', elementId: cover.imageId, changes: { assetId: fresh.assetId } }])
  const copyContext = defaultProjectWorkContext(copy.projectId)
  copyContext.generation = { ...coverContext.generation, focusedResultId: fresh.id, compareAId: cover.resultId, compareBId: fresh.id,
    referenceSource: { kind: 'result', resultId: fresh.id }, referenceResultId: fresh.id, prompt: '副本下一步：保留标题，只改远山晨光', compareActiveSide: 'B' }
  copyContext.conversationDraft = '这段要求只属于副本。'
  copyContext.workspace.activeView = 'generate'
  runtime.saveProjectWorkContext(copyContext)
  hold = true
  const preview = await runtime.previewGenerationReference({ projectId: copy.projectId, source: { kind: 'text' }, referenceMode: 'visual', profileId: 'configured-final', modelOverride: null })
  const interrupted = await runtime.enqueueProfile(generationProfileRequestSchema.parse({ projectId: copy.projectId, profileId: 'configured-final', confirmed: true, operation: 'generate',
    referenceSource: { kind: 'text' }, expectedReferenceSignature: preview.signature, draft: { prompt: '受控中断：不会返回结果', negativePrompt: '', aspect: { width: 4, height: 5 }, quantity: 1,
      profileId: 'configured-final', referenceMode: 'visual', referenceResultIds: [], sourceSceneRevision: null, variationInstruction: '', preserveConstraints: '', expandedSections: [] },
    outputWidth: 1200, outputHeight: 1500, parameters: { workflowIdempotencyKey: randomUUID() } }))
  await expect.poll(() => calls.at(-1)?.fields.prompt).toContain('受控中断')
  await runtime.close()
  const countBeforeRestart = calls.length
  hold = false
  runtime = await GenerationRuntime.create(userData); runtimes.push(runtime)
  expect((await runtime.listJobs()).find((job) => job.id === interrupted.id)?.status).toBe('interrupted')
  expect(calls).toHaveLength(countBeforeRestart)
  expect(runtime.getWorkspaceBootstrap().workContext).toEqual(copyContext)
  expect((await runtime.listJobs()).find((job) => job.id === interrupted.id)?.cost?.actual).toMatchObject({ status: 'unknown', amount: null })
  const finalCopyScene = runtime.getWorkspaceBootstrap().scene
  const copyArtifact = await renderArtifact(runtime, copyPath, join(evidence, 'copy-current-main.png'))
  await runtime.openProject(cover.path)
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(sourceScene)
  await runtime.openProject(copyPath)
  expect(runtime.getWorkspaceBootstrap().scene).toEqual(finalCopyScene)
  expect((await runtime.listRecentProjects()).map((project) => project.id)).toEqual(expect.arrayContaining([copy.projectId, cover.projectId]))
  works.push({ kind: 'copy', name: '山海之间 · 独立续作 C', projectId: copy.projectId, projectPath: copyPath, userData, titleId: cover.titleId, imageId: cover.imageId,
    sourceProjectId: cover.projectId, resultId: fresh.id, compare: copyContext.generation, interruptedJobId: interrupted.id, artifact: copyArtifact, resumed: true })
  await writeFile(join(evidence, 'copy-scene.json'), JSON.stringify(finalCopyScene, null, 2))
  await runtime.close()
  await writeFile(join(evidence, 'aggregate-facts.json'), JSON.stringify({ root, userData, works, fakeHttpCalls: calls, actualProviderRequests: 0,
    scope: 'Production Main, SQLite, Scene executor, Agent loop and real reference/protocol pipeline. Fake only at LLM plan and HTTP response. Electron continuation/export proves pointer use separately.' }, null, 2))
  expect(fakeHttp).toHaveBeenCalledTimes(6)
  expect(hash(await readFile(join(evidence, 'cover-current-main.png')))).not.toBe(hash(await readFile(join(evidence, 'copy-current-main.png'))))
}, 90_000)
