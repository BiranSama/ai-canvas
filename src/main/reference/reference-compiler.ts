import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { readVerifiedReferenceBytes } from '../generation/verified-reference-bytes'
import type { Scene } from '../../domain'
import type { ProviderCapabilities, ReferenceMode } from '../../shared/generation'
import type { PromptIr, PromptPackage, ProviderCompiledPrompt } from '../../shared/reference'
import type { AssetMetadata, ProjectRepository } from '../storage/project-repository'
import type { AssetStore } from '../storage/asset-store'
import { CompositeReferenceRenderer } from './composite-reference-renderer'
import { compilePromptIr } from './prompt-ir'
import { compilePromptPackage } from './prompt-package'
import { ProviderPromptCompiler } from './provider-prompt-compiler'
import { SemanticSheetRenderer } from './semantic-sheet-renderer'

export interface ReferenceCompilation {
  readonly id: string
  readonly asset: AssetMetadata
  readonly semanticSheetAsset: AssetMetadata
  readonly promptIr: PromptIr
  readonly promptPackage: PromptPackage
  readonly providerPrompt: ProviderCompiledPrompt
  readonly warnings: readonly string[]
}

export interface ReferenceCompilerOptions {
  readonly assetStore: AssetStore
  readonly repository: ProjectRepository
  readonly stagingDirectory: string
  readonly idFactory?: () => string
  readonly now?: () => string
}

export class ReferenceCompiler {
  readonly #assetStore: AssetStore
  readonly #repository: ProjectRepository
  readonly #stagingDirectory: string
  readonly #idFactory: () => string
  readonly #now: () => string
  readonly #promptCompiler = new ProviderPromptCompiler()

  constructor(options: ReferenceCompilerOptions) {
    this.#assetStore = options.assetStore
    this.#repository = options.repository
    this.#stagingDirectory = options.stagingDirectory
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async compile(
    scene: Scene,
    originalRequirement: string,
    providerId: string,
    capabilities: ProviderCapabilities,
    model = providerId === 'mock' ? 'mock-balanced' : 'unknown-model',
    referenceMode: ReferenceMode = 'hybrid',
    targetOutput?: PromptPackage['targetOutput']
  ): Promise<ReferenceCompilation> {
    const id = this.#idFactory()
    const compiledAt = this.#now()
    const promptIr = compilePromptIr(scene, originalRequirement, compiledAt)
    const assets = await this.#repository.listAssets()
    const renderer = new CompositeReferenceRenderer(async (assetId) => {
      const asset = assets.find((candidate) => candidate.id === assetId && candidate.status === 'available')
      return asset === undefined ? null : readVerifiedReferenceBytes(this.#assetStore.resolveOriginal(asset), asset.contentHash)
    })
    const rendered = await renderer.render(scene, 'reference')
    const semanticRenderer = new SemanticSheetRenderer()
    const semanticSheet = await semanticRenderer.render(scene)
    await mkdir(this.#stagingDirectory, { recursive: true })
    const stagingPath = join(this.#stagingDirectory, `${id}.png`)
    const semanticStagingPath = join(this.#stagingDirectory, `${id}-semantic.png`)
    try {
      await sharp(rendered.buffer).png().toFile(stagingPath)
      await sharp(semanticSheet).png().toFile(semanticStagingPath)
      const asset = await this.#assetStore.importImage({ sourcePath: stagingPath, sourceType: 'reference', sourceId: id })
      const semanticSheetAsset = await this.#assetStore.importImage({ sourcePath: semanticStagingPath, sourceType: 'reference', sourceId: `${id}:semantic` })
      const promptPackage = compilePromptPackage(scene, promptIr, {
        appearanceCompositeAssetId: asset.id,
        semanticSheetAssetId: semanticSheetAsset.id
      }, {
        idFactory: this.#idFactory,
        compiledAt,
        providerId,
        model,
        capabilities,
        referenceMode,
        ...(targetOutput === undefined ? {} : { targetOutput }),
        renderTier: providerId === 'mock' ? 'mock-final' : 'final'
      })
      const providerPrompt = this.#promptCompiler.compile(promptIr, providerId, capabilities, promptPackage)
      return {
        id,
        asset,
        semanticSheetAsset,
        promptIr,
        promptPackage,
        providerPrompt,
        warnings: [...providerPrompt.warnings, ...rendered.warnings]
      }
    } finally {
      await Promise.all([
        rm(stagingPath, { force: true }).catch(() => undefined),
        rm(semanticStagingPath, { force: true }).catch(() => undefined)
      ])
    }
  }
}
