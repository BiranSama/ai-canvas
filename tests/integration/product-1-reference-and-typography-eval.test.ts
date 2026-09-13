import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandBus, ELEMENT_SCHEMA_VERSION, sceneSchema } from '../../src/domain'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { ReferenceCompiler } from '../../src/main/reference'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import type { GenerationJob, ProviderCapabilities } from '../../src/shared/generation'
import { createSemanticFixtureScene, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'
import { commitSceneFixture } from '../helpers/commit-scene-fixture'

const roots: string[] = []

const fullReferenceCapabilities: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: false,
  multipleReferences: true,
  transparentOutput: false,
  maxImages: 4,
  supportedRatios: ['1:1', '3:2', '4:5'],
  supportedFormats: ['png']
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function waitForCompleted(runtime: GenerationRuntime, jobId: string): Promise<GenerationJob> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const job = (await runtime.listJobs()).find((candidate) => candidate.id === jobId)
    if (job?.status === 'completed') return job
    if (job !== undefined && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status)) {
      throw new Error(`Product eval generation ended as ${job.status}: ${job.error?.message ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Product eval generation did not complete in time.')
}

describe('Product 1.0 Stage B reference and typography workflows', () => {
  it('EVAL-04 keeps visual and structural references distinct and degrades hybrid mode honestly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-eval-04-'))
    roots.push(root)
    const opened = await ProjectWorkspace.create(join(root, 'eval-04.aicanvas'), 'EVAL-04 同时参考')
    try {
      const fixture = SEMANTIC_FIXTURES[2]
      const created = await createSemanticFixtureScene(opened.scene, fixture)
      const stylePath = join(root, 'quiet-style-reference.png')
      await sharp({
        create: { width: 320, height: 400, channels: 4, background: { r: 205, g: 217, b: 210, alpha: 1 } }
      }).png().toFile(stylePath)
      const styleAsset = await opened.workspace.assets.importImage({ sourcePath: stylePath, sourceType: 'imported' })
      const styleElementId = created.nextId()
      const scene = sceneSchema.parse({
        ...created.scene,
        elements: [...created.scene.elements, {
          id: styleElementId,
          version: ELEMENT_SCHEMA_VERSION,
          type: 'image',
          name: '柔和植物印刷风格参考',
          description: '只参考低饱和纸张色、柔和对比和安静印刷质感，不复制主体。',
          transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
          zIndex: created.scene.elements.length,
          opacity: 0.32,
          visible: true,
          locked: true,
          groupId: null,
          semanticRole: 'style-reference',
          referencePolicy: 'reference-only',
          assetId: styleAsset.id,
          crop: { x: 0, y: 0, width: 1, height: 1 },
          fit: 'cover',
          referenceRole: 'style'
        }]
      })
      const compiler = new ReferenceCompiler({
        assetStore: opened.workspace.assets,
        repository: opened.workspace.repository,
        stagingDirectory: join(root, 'reference-staging'),
        idFactory: created.nextId,
        now: () => '2026-08-30T20:00:00.000+08:00'
      })

      const supported = await compiler.compile(
        scene,
        '同时参考柔和植物印刷风格和当前结构化画布，保留标题、枝叶层级与留白。',
        'mock-reference-capable',
        fullReferenceCapabilities,
        'mock-balanced',
        'hybrid'
      )
      const styleReference = supported.promptPackage.referenceManifest.find((entry) => entry.sourceElementId === styleElementId)
      expect(supported.promptPackage).toMatchObject({
        referenceMode: 'hybrid',
        generationProfile: { imageReferences: true, multipleReferences: true }
      })
      expect(supported.promptPackage.referenceManifest.map((entry) => entry.role)).toEqual([
        'appearance-composite', 'semantic-sheet', 'source-image'
      ])
      expect(styleReference).toMatchObject({ role: 'source-image', weight: 0.66, sourceElementId: styleElementId })
      expect(supported.promptPackage.elementBriefs.find((entry) => entry.id === styleElementId)).toMatchObject({
        semanticRole: 'style-reference',
        visibility: 'semantic-guide'
      })
      expect(supported.providerPrompt).toMatchObject({
        referenceStrategy: 'composite',
        referenceMode: 'hybrid',
        warnings: []
      })
      expect(supported.providerPrompt.prompt).toContain('画面参考只表达构图与光影')
      expect(supported.promptPackage.compositionContract.length).toBeGreaterThan(0)

      const degraded = await compiler.compile(
        scene,
        '同时参考柔和植物印刷风格和当前结构化画布，保留标题、枝叶层级与留白。',
        'mock-text-only',
        { ...fullReferenceCapabilities, imageReferences: false, multipleReferences: false },
        'mock-text-only',
        'hybrid'
      )
      expect(degraded.providerPrompt).toMatchObject({
        referenceStrategy: 'text-only',
        referenceMode: 'hybrid',
        warnings: ['当前供应商不支持参考图，“同时参考”已明确适配为结构参考。']
      })
      expect(degraded.promptPackage.elementBriefs.some((entry) => entry.semanticRole === 'subject')).toBe(true)
      expect(degraded.providerPrompt.prompt).toContain(fixture.title)

      const subject = scene.elements.find((element) => element.semanticRole === 'subject')
      if (subject === undefined) throw new Error('EVAL-04 requires an editable subject element.')
      const bus = new CommandBus(scene)
      const moved = bus.execute({
        id: created.nextId(),
        origin: 'user',
        summary: '微调参考构图主体',
        commands: [{ kind: 'element.update', elementId: subject.id, changes: { transform: { x: subject.transform.x + 0.01 } } }]
      })
      if (!moved.ok) throw moved.error
      const undone = bus.undo()
      const editableAndUndoable = undone === moved.batch
        && bus.getScene().elements.find((element) => element.id === subject.id)?.transform.x === subject.transform.x

      const structuralCoverage = {
        requirementUnderstanding: styleReference !== undefined && supported.promptPackage.referenceMode === 'hybrid',
        compositionAndDesign: supported.promptPackage.elementBriefs.some((entry) => entry.semanticRole === 'subject'),
        generationControl: supported.providerPrompt.referenceStrategy === 'composite' && degraded.providerPrompt.warnings.length === 1,
        editability: editableAndUndoable,
        workflowClarity: supported.warnings.length === 0 && degraded.warnings.length === 1
      }
      expect(Object.values(structuralCoverage).every(Boolean)).toBe(true)
    } finally {
      await opened.workspace.close(true)
    }
  })

  it('EVAL-05 treats typography as a restrained reference while preserving the editable Scene text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-eval-05-'))
    roots.push(root)
    const runtime = await GenerationRuntime.create(root)
    try {
      const fixture = SEMANTIC_FIXTURES[7]
      const created = await createSemanticFixtureScene(runtime.getWorkspaceBootstrap().scene, fixture)
      const context = created.scene.creativeContext
      const title = created.scene.elements.find((element) => element.type === 'text' && element.semanticRole === 'title')
      if (context?.brief.version !== 3 || title?.type !== 'text') throw new Error('EVAL-05 requires a v3 Brief and editable title.')
      const brief = {
        ...context.brief,
        text: context.brief.text.map((item) => item.content === fixture.title
          ? { ...item, style: '飘逸的纤细书写感、疏朗字距、轻微墨色流动，只作为排版与字效方向', mode: 'reference' as const, visualWeight: 'whisper' as const }
          : item)
      }
      const scene = await commitSceneFixture(runtime, sceneSchema.parse({
        ...created.scene,
        creativeContext: { ...context, brief },
        elements: created.scene.elements.map((element) => element.id === title.id && element.type === 'text'
          ? {
              ...element,
              description: '飘逸、疏朗的标题参考，最终精确文字仍由可编辑图层承担。',
              transform: { ...element.transform, width: Math.min(element.transform.width, 0.62), height: Math.min(element.transform.height, 0.09) },
              letterSpacing: 18,
              fontWeight: 300,
              accuracy: 'balanced' as const,
              visualWeight: 'whisper' as const,
              styleDescription: '飘逸的纤细书写感、疏朗字距、轻微墨色流动，不使用粗重默认字体。',
              renderStrategy: 'standard' as const
            }
          : element)
      }))
      const before = structuredClone(scene)
      const compiled = await runtime.generateFromCanvas({
        scene,
        originalRequirement: '标题“山海之间”只作为飘逸字效、疏朗间距和位置参考，不要求模型输出最终可读文字；保持远山、海面和大面积留白。',
        providerId: 'mock',
        model: 'mock-balanced',
        count: 1,
        sourceMessageId: null,
        referenceMode: 'hybrid'
      })
      const completed = await waitForCompleted(runtime, compiled.jobId)
      const textContract = compiled.promptPackage.textContract.find((entry) => entry.content === fixture.title)

      expect(textContract).toMatchObject({
        mode: 'reference',
        accuracy: 'balanced',
        visualWeight: 'whisper'
      })
      expect(textContract?.style).toContain('飘逸')
      expect(compiled.sentPrompt).toContain(`文字参考“${fixture.title}”`)
      expect(compiled.sentPrompt).toContain('当前占位字体或字号')
      expect(compiled.sentNegativePrompt).toContain('避免广告牌式巨大标题')
      expect(completed.request.referenceMode).toBe('hybrid')
      expect(completed.results).toHaveLength(1)
      expect(completed.providerId).toBe('mock')
      expect(scene).toEqual(before)
      expect(scene.elements.find((element) => element.id === title.id)).toMatchObject({
        type: 'text',
        content: fixture.title,
        letterSpacing: 18,
        visualWeight: 'whisper',
        renderStrategy: 'standard'
      })

      const structuralCoverage = {
        requirementUnderstanding: textContract?.mode === 'reference' && textContract.visualWeight === 'whisper',
        compositionAndDesign: textContract?.style.includes('飘逸') === true,
        generationControl: compiled.sentNegativePrompt.includes('避免广告牌式巨大标题'),
        editability: scene.elements.some((element) => element.id === title.id && element.type === 'text' && element.content === fixture.title),
        workflowClarity: completed.status === 'completed' && completed.providerId === 'mock'
      }
      expect(Object.values(structuralCoverage).every(Boolean)).toBe(true)
    } finally {
      await runtime.close()
    }
  })
})
