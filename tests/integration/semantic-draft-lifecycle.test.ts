import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities } from '../../src/shared/generation'
import { ReferenceCompiler } from '../../src/main/reference'
import { ProjectWorkspace } from '../../src/main/storage/project-workspace'
import { createSemanticFixtureScene, SEMANTIC_FIXTURES } from '../helpers/semantic-fixtures'

const roots: string[] = []
const capabilities: ProviderCapabilities = {
  textToImage: true,
  imageReferences: true,
  maskEditing: true,
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

describe('four theme-neutral semantic draft fixtures', () => {
  it.each(SEMANTIC_FIXTURES)('$key creates, edits, undoes, saves, reopens and compiles references', async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), `ai-canvas-${fixture.key}-`))
    roots.push(root)
    const projectDirectory = join(root, `${fixture.key}.aicanvas`)
    const opened = await ProjectWorkspace.create(projectDirectory, fixture.key)
    const created = await createSemanticFixtureScene(opened.scene, fixture)
    expect(created.plan.tools).toHaveLength(1)
    expect(created.scene.creativeContext?.brief.theme).toBe(fixture.theme)
    expect(created.scene.elements.length).toBeGreaterThanOrEqual(6)
    expect(created.scene.elements.every((element) => element.description.length > 0)).toBe(true)
    expect(JSON.stringify(created.scene)).not.toMatch(/香水瓶|NIGHT VEIL/i)

    const subject = created.scene.elements.find((element) => element.semanticRole === 'subject')
    const title = created.scene.elements.find((element) => element.type === 'text' && element.semanticRole === 'title')
    if (subject === undefined || title?.type !== 'text') throw new Error(`${fixture.key} is missing editable semantic layers.`)
    const editedTitle = `${fixture.title} / EDIT`
    const edited = created.bus.execute({
      id: created.nextId(),
      origin: 'user',
      summary: '精调主体与标题',
      commands: [
        { kind: 'element.update', elementId: subject.id, changes: { transform: { x: subject.transform.x + .03 } } },
        { kind: 'element.update', elementId: title.id, changes: { content: editedTitle } }
      ]
    })
    if (!edited.ok) throw new Error(edited.error.message)
    expect(created.bus.undo()).toBe(edited.batch)
    expect((created.bus.getScene().elements.find((element) => element.id === title.id) as typeof title).content).toBe(fixture.title)
    expect(created.bus.redo()).toBe(edited.batch)
    expect((created.bus.getScene().elements.find((element) => element.id === title.id) as typeof title).content).toBe(editedTitle)

    await opened.workspace.saveScene(created.bus.getScene(), 'explicit')
    await opened.workspace.close(true)
    const reopened = await ProjectWorkspace.open(projectDirectory)
    expect(reopened.scene.creativeContext?.brief.theme).toBe(fixture.theme)
    expect(reopened.scene.elements.find((element) => element.id === title.id)).toMatchObject({ content: editedTitle })

    const compiler = new ReferenceCompiler({
      assetStore: reopened.workspace.assets,
      repository: reopened.workspace.repository,
      stagingDirectory: join(root, 'reference-staging'),
      idFactory: created.nextId,
      now: () => '2026-08-14T00:00:00.000Z'
    })
    const compilation = await compiler.compile(reopened.scene, fixture.request, 'mock', capabilities, 'mock-balanced')
    expect(compilation.promptPackage).toMatchObject({
      sceneIntent: { originalRequirement: fixture.request },
      renderTier: 'mock-final',
      generationProfile: { providerId: 'mock', model: 'mock-balanced', multipleReferences: true }
    })
    expect(compilation.promptPackage.elementBriefs).toHaveLength(reopened.scene.elements.length)
    expect(compilation.promptPackage.textContract).toEqual([expect.objectContaining({
      content: editedTitle,
      mode: 'reference',
      accuracy: 'balanced',
      visualWeight: 'secondary'
    })])
    expect(compilation.promptPackage.referenceManifest.map((entry) => entry.role)).toEqual(['appearance-composite', 'semantic-sheet'])
    expect(compilation.providerPrompt.prompt).toContain(editedTitle)
    expect(await sharp(reopened.workspace.assets.resolveOriginal(compilation.asset)).metadata()).toMatchObject({
      width: reopened.scene.canvas.outputWidth,
      height: reopened.scene.canvas.outputHeight
    })
    const semanticMetadata = await sharp(reopened.workspace.assets.resolveOriginal(compilation.semanticSheetAsset)).metadata()
    expect(semanticMetadata.width).toBeGreaterThan(reopened.scene.canvas.outputWidth)
    expect(semanticMetadata.height).toBe(reopened.scene.canvas.outputHeight)
    await reopened.workspace.close(true)
  })

  it('keeps the only visual reference clean and carries structure in the prompt when a provider accepts one reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-single-reference-'))
    roots.push(root)
    const opened = await ProjectWorkspace.create(join(root, 'single.aicanvas'), 'single-reference')
    const created = await createSemanticFixtureScene(opened.scene, SEMANTIC_FIXTURES[1])
    const compiler = new ReferenceCompiler({
      assetStore: opened.workspace.assets,
      repository: opened.workspace.repository,
      stagingDirectory: join(root, 'reference-staging'),
      idFactory: created.nextId,
      now: () => '2026-08-14T00:00:00.000Z'
    })
    const compilation = await compiler.compile(created.scene, SEMANTIC_FIXTURES[1].request, 'single-reference-mock', { ...capabilities, multipleReferences: false }, 'mock-draft')
    const appearanceMetadata = await sharp(opened.workspace.assets.resolveOriginal(compilation.asset)).metadata()
    expect(appearanceMetadata.width).toBe(created.scene.canvas.outputWidth)
    expect(appearanceMetadata.height).toBe(created.scene.canvas.outputHeight)
    expect(compilation.promptPackage.generationProfile).toMatchObject({ model: 'mock-draft', multipleReferences: false })
    expect(compilation.providerPrompt.prompt).toContain(SEMANTIC_FIXTURES[1].title)
    await opened.workspace.close(true)
  })
})
