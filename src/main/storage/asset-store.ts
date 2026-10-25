import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import sharp from 'sharp'
import type { AssetMetadata, ProjectRepository } from './project-repository'

const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_DIMENSION = 16_384
const MAX_PIXELS = 80_000_000

export interface ImportAssetInput {
  readonly sourcePath: string
  readonly sourceType?: AssetMetadata['sourceType']
  readonly sourceId?: string | null
}

function normalizeFormat(format: string | undefined): AssetMetadata['format'] {
  if (format === 'png' || format === 'jpeg' || format === 'webp') return format
  throw new Error('Only PNG, JPEG and WebP images are supported.')
}

function extensionFor(format: AssetMetadata['format']): string {
  return format === 'jpeg' ? 'jpg' : format
}

export class AssetStore {
  readonly #projectDirectory: string
  readonly #projectId: string
  readonly #repository: ProjectRepository
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(
    projectDirectory: string,
    projectId: string,
    repository: ProjectRepository,
    options: { readonly idFactory?: () => string; readonly now?: () => string } = {}
  ) {
    this.#projectDirectory = projectDirectory
    this.#projectId = projectId
    this.#repository = repository
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  resolveOriginal(asset: AssetMetadata): string {
    return join(this.#projectDirectory, asset.relativePath)
  }

  resolveThumbnail(asset: AssetMetadata): string {
    return join(this.#projectDirectory, asset.thumbnailRelativePath)
  }

  async getAsset(assetId: string): Promise<AssetMetadata> {
    const asset = (await this.#repository.listAssets()).find((candidate) => candidate.id === assetId)
    if (asset === undefined) throw new Error(`Asset ${assetId} does not exist.`)
    if (asset.status !== 'available') throw new Error(`Asset ${assetId} is unavailable.`)
    return asset
  }

  async resolveAsset(assetId: string): Promise<{ readonly asset: AssetMetadata; readonly filePath: string }> {
    const asset = await this.getAsset(assetId)
    return { asset, filePath: this.resolveOriginal(asset) }
  }

  async importImage(input: ImportAssetInput): Promise<AssetMetadata> {
    const sourceStats = await stat(input.sourcePath)
    if (!sourceStats.isFile()) throw new Error(`${basename(input.sourcePath)} is not a file.`)
    if (sourceStats.size <= 0 || sourceStats.size > MAX_ASSET_BYTES) {
      throw new Error('Image must be between 1 byte and 100 MB.')
    }

    // Read once through Node, which reaches long Windows paths that Sharp's own file reading cannot.
    const bytes = await readFile(input.sourcePath)
    const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata()
    const format = normalizeFormat(metadata.format)
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw new Error('Image dimensions exceed the safe import limit.')
    }
    const thumbnail = (): Promise<Buffer> => sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const existing = await this.#repository.findAssetByHash(this.#projectId, contentHash)
    if (existing !== null) {
      if (existing.status === 'missing') {
        await mkdir(join(this.#projectDirectory, 'assets', 'original'), { recursive: true })
        await mkdir(join(this.#projectDirectory, 'assets', 'thumbnails'), { recursive: true })
        await writeFile(this.resolveOriginal(existing), bytes)
        await writeFile(this.resolveThumbnail(existing), await thumbnail())
        await this.#repository.updateAssetStatus(existing.id, 'available')
        return { ...existing, status: 'available' }
      }
      return existing
    }

    const assetId = this.#idFactory()
    const originalDirectory = join(this.#projectDirectory, 'assets', 'original')
    const thumbnailDirectory = join(this.#projectDirectory, 'assets', 'thumbnails')
    await mkdir(originalDirectory, { recursive: true })
    await mkdir(thumbnailDirectory, { recursive: true })

    const originalFileName = `${contentHash}.${extensionFor(format)}`
    const thumbnailFileName = `${assetId}.webp`
    const relativePath = posix.join('assets', 'original', originalFileName)
    const thumbnailRelativePath = posix.join('assets', 'thumbnails', thumbnailFileName)
    const originalPath = join(this.#projectDirectory, relativePath)
    const thumbnailPath = join(this.#projectDirectory, thumbnailRelativePath)

    const asset: AssetMetadata = {
      id: assetId,
      projectId: this.#projectId,
      relativePath,
      thumbnailRelativePath,
      contentHash,
      width,
      height,
      format,
      hasAlpha: metadata.hasAlpha ?? false,
      sourceType: input.sourceType ?? 'imported',
      sourceId: input.sourceId ?? null,
      status: 'available',
      createdAt: this.#now()
    }
    try {
      await writeFile(originalPath, bytes)
      await writeFile(thumbnailPath, await thumbnail())
    } catch (error) {
      // No asset is registered under this content, so a half-finished import leaves nothing behind.
      await Promise.allSettled([rm(originalPath, { force: true }), rm(thumbnailPath, { force: true })])
      throw error
    }
    await this.#repository.insertAsset(asset)
    return asset
  }

  async detectMissingAssets(): Promise<readonly AssetMetadata[]> {
    const assets = await this.#repository.listAssets()
    const missing: AssetMetadata[] = []
    for (const asset of assets) {
      try {
        const originalStats = await stat(this.resolveOriginal(asset))
        const thumbnailStats = await stat(this.resolveThumbnail(asset))
        if (!originalStats.isFile() || !thumbnailStats.isFile()) throw new Error('Missing asset file')
        if (asset.status !== 'available') await this.#repository.updateAssetStatus(asset.id, 'available')
      } catch {
        if (asset.status !== 'missing') await this.#repository.updateAssetStatus(asset.id, 'missing')
        missing.push({ ...asset, status: 'missing' })
      }
    }
    return missing
  }
}
