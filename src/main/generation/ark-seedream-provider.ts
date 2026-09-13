import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import type { ArkHttpClient } from '../security/ark-http-client'
import { compileSeedreamVisualEditReference } from '../edit/seedream-visual-edit-compiler'
import { ARK_SEEDREAM_CAPABILITIES } from './ark-seedream-protocol'
import type { ArkSeedreamProtocol, NormalizedSeedreamImage } from './ark-seedream-protocol'
import type { ImageProvider, ProviderGenerateContext, ProviderOutput } from './provider'
import { ProviderError } from './provider'
import { readVerifiedReferenceBytes } from './verified-reference-bytes'

export const ARK_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128'
/** Conservative Product V1 estimate used only for the configurable local budget. */
export const ARK_SEEDREAM_COST_CEILING_PER_IMAGE_CNY = 1
const MAX_INPUT_IMAGE_BYTES = 29 * 1024 * 1024

interface ArkJsonPoster {
  postJson(request: Parameters<ArkHttpClient['postJson']>[0]): Promise<unknown>
}

function mimeFor(format: 'png' | 'jpeg' | 'webp'): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (format === 'jpeg') return 'image/jpeg'
  return `image/${format}`
}

function extensionFor(mimeType: ProviderOutput['mimeType']): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType === 'image/png' ? 'png' : 'webp'
}

async function dataUri(filePath: string, format: 'png' | 'jpeg' | 'webp', contentHash: string): Promise<string> {
  const bytes = await readVerifiedReferenceBytes(filePath, contentHash)
  return bufferDataUri(bytes, mimeFor(format))
}

function bufferDataUri(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg' | 'image/webp'): string {
  if (bytes.length === 0 || bytes.length > MAX_INPUT_IMAGE_BYTES) {
    throw new ProviderError('ARK_REFERENCE_SIZE', 'Seedream references must be between 1 byte and 29 MB.', 'validating')
  }
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

function providerFailure(error: unknown, stage: 'submitting' | 'generating' | 'localizing'): ProviderError {
  if (error instanceof ProviderError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'ARK_SEEDREAM_ERROR'
  return new ProviderError(code, error instanceof Error ? error.message : '火山方舟图片请求失败。', stage)
}

export class ArkSeedreamImageProvider implements ImageProvider {
  readonly id = 'image-provider'
  readonly label: string
  readonly capabilities: ProviderCapabilities
  readonly #protocol: ArkSeedreamProtocol
  readonly #http: ArkJsonPoster
  readonly #stagingDirectory: string
  readonly #timeoutMs: number
  readonly #allowedModels: ReadonlySet<string>

  constructor(options: {
    readonly protocol: ArkSeedreamProtocol
    readonly http: ArkJsonPoster
    readonly stagingDirectory: string
    readonly timeoutMs: number
    readonly allowedModels?: readonly string[]
    readonly label?: string
    readonly capabilities?: ProviderCapabilities
  }) {
    this.label = options.label ?? '火山方舟 · Seedream 5.0'
    this.capabilities = options.capabilities ?? ARK_SEEDREAM_CAPABILITIES
    this.#protocol = options.protocol
    this.#http = options.http
    this.#stagingDirectory = options.stagingDirectory
    this.#timeoutMs = options.timeoutMs
    this.#allowedModels = new Set(options.allowedModels ?? [ARK_SEEDREAM_MODEL])
  }

  async generate(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.#validateRequest(request)
    const images: string[] = []
    for (const reference of request.references) {
      const resolved = await context.resolveAsset(reference.assetId)
      images.push(await dataUri(resolved.filePath, resolved.asset.format, resolved.asset.contentHash))
    }
    return this.#perform(request, images, context)
  }

  async edit(request: EditRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.#validateRequest(request)
    const source = await context.resolveAsset(request.sourceAssetId)
    const mask = await context.resolveAsset(request.maskAssetId)
    if (source.asset.width !== mask.asset.width || source.asset.height !== mask.asset.height) {
      throw new ProviderError('MASK_DIMENSION_MISMATCH', '局部编辑蒙版尺寸必须与源图完全一致。', 'validating')
    }
    const sourceBytes = await readVerifiedReferenceBytes(source.filePath, source.asset.contentHash)
    const maskBytes = await readVerifiedReferenceBytes(mask.filePath, mask.asset.contentHash)
    const annotated = await compileSeedreamVisualEditReference(sourceBytes, maskBytes)
    const images = [
      bufferDataUri(sourceBytes, mimeFor(source.asset.format)),
      bufferDataUri(annotated.bytes, annotated.mimeType)
    ]
    for (const reference of request.references) {
      if (reference.assetId === request.sourceAssetId || reference.assetId === request.maskAssetId) continue
      const resolved = await context.resolveAsset(reference.assetId)
      images.push(await dataUri(resolved.filePath, resolved.asset.format, resolved.asset.contentHash))
    }
    return this.#perform(request, images, context)
  }

  #validateRequest(request: GenerationRequest | EditRequest): void {
    if (!this.#allowedModels.has(request.model)) {
      throw new ProviderError('ARK_MODEL_DENIED', `模型 ${request.model} 不在当前图片 Provider 配置中。`, 'validating')
    }
    if (request.count > this.capabilities.maxImages) {
      throw new ProviderError('UNSUPPORTED_COUNT', `Seedream 单次最多生成 ${this.capabilities.maxImages} 张图片。`, 'validating')
    }
  }

  async #perform(
    request: GenerationRequest | EditRequest,
    images: readonly string[],
    context: ProviderGenerateContext
  ): Promise<readonly ProviderOutput[]> {
    let stage: 'submitting' | 'generating' | 'localizing' = 'submitting'
    try {
      const protocolRequest = this.#protocol.buildRequest({ request, images })
      await context.onStage('submitting')
      stage = 'generating'
      await context.onStage('generating')
      const raw = await this.#http.postJson({
        ...protocolRequest,
        secretId: 'image-provider',
        providerId: this.id,
        providerLabel: this.label,
        authorizationScopeId: typeof request.parameters.workflowIntentId === 'string'
          ? request.parameters.workflowIntentId
          : request.sourceMessageId ?? `image:${randomUUID()}`,
        expectedImages: request.count,
        costCeilingCny: request.count * ARK_SEEDREAM_COST_CEILING_PER_IMAGE_CNY,
        signal: context.signal,
        timeoutMs: this.#timeoutMs
      })
      const response = this.#protocol.parseResponse(raw)
      if (response.images.length > request.count || response.generatedImages > request.count) {
        throw new ProviderError('ARK_UNEXPECTED_IMAGE_COUNT', 'Seedream 返回图片数超过本次授权数量，结果未导入项目。', 'localizing')
      }
      stage = 'localizing'
      await context.onStage('localizing')
      await mkdir(this.#stagingDirectory, { recursive: true })
      return Promise.all(response.images.map((image, index) => this.#localize(image, index)))
    } catch (error) {
      throw providerFailure(error, stage)
    }
  }

  async #localize(image: NormalizedSeedreamImage, index: number): Promise<ProviderOutput> {
    if (image.kind !== 'base64') {
      throw new ProviderError(
        'ARK_UNEXPECTED_URL_RESULT',
        '当前图片档要求 Provider 返回 Base64；URL 结果不会绕过 Main 下载与预算边界。',
        'localizing'
      )
    }
    const bytes = Buffer.from(image.value, 'base64')
    if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
      throw new ProviderError('ARK_IMAGE_SIZE', 'Seedream 返回图片为空或超过 50 MB 安全上限。', 'localizing')
    }
    const metadata = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
    if (metadata.format !== 'png' && metadata.format !== 'jpeg' && metadata.format !== 'webp') {
      throw new ProviderError('ARK_IMAGE_FORMAT', 'Seedream 返回了不支持的图片格式。', 'localizing')
    }
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 80_000_000) {
      throw new ProviderError('ARK_IMAGE_DIMENSIONS', 'Seedream 返回图片尺寸超过本地安全上限。', 'localizing')
    }
    const mimeType = mimeFor(metadata.format)
    const filePath = join(this.#stagingDirectory, `${randomUUID()}-${index}.${extensionFor(mimeType)}`)
    await writeFile(filePath, bytes, { flag: 'wx' })
    return { filePath, mimeType }
  }
}
