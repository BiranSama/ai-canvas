import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import type { ArkHttpClient } from '../security/ark-http-client'
import type {
  OpenAiImagesFileInput,
  OpenAiImagesProtocol,
  NormalizedOpenAiImage
} from './openai-images-protocol'
import type { ImageProvider, ProviderGenerateContext, ProviderOutput } from './provider'
import { ProviderError } from './provider'
import { compileOpenAiEditMask } from '../edit/openai-edit-mask-compiler'
import { readVerifiedReferenceBytes } from './verified-reference-bytes'

const MAX_INPUT_IMAGE_BYTES = 29 * 1024 * 1024

interface OpenAiImagesPoster {
  postJson(request: Parameters<ArkHttpClient['postJson']>[0]): Promise<unknown>
  postMultipart(request: Parameters<ArkHttpClient['postMultipart']>[0]): Promise<unknown>
}

function mimeFor(format: 'png' | 'jpeg' | 'webp'): ProviderOutput['mimeType'] {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

function extensionFor(mimeType: ProviderOutput['mimeType']): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType === 'image/png' ? 'png' : 'webp'
}

function failure(error: unknown, stage: 'submitting' | 'generating' | 'localizing'): ProviderError {
  if (error instanceof ProviderError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'OPENAI_IMAGES_ERROR'
  return new ProviderError(code, error instanceof Error ? error.message : '图片 Provider 请求失败。', stage)
}

export class OpenAiImagesProvider implements ImageProvider {
  readonly id = 'image-provider'
  readonly label: string
  readonly capabilities: ProviderCapabilities
  readonly #protocol: OpenAiImagesProtocol
  readonly #http: OpenAiImagesPoster
  readonly #stagingDirectory: string
  readonly #timeoutMs: number
  readonly #costCeilingCny: number

  constructor(options: {
    readonly label: string
    readonly capabilities: ProviderCapabilities
    readonly protocol: OpenAiImagesProtocol
    readonly http: OpenAiImagesPoster
    readonly stagingDirectory: string
    readonly timeoutMs: number
    readonly costCeilingCny: number
  }) {
    this.label = options.label
    this.capabilities = options.capabilities
    this.#protocol = options.protocol
    this.#http = options.http
    this.#stagingDirectory = options.stagingDirectory
    this.#timeoutMs = options.timeoutMs
    this.#costCeilingCny = options.costCeilingCny
  }

  async generate(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.#validate(request)
    if (request.references.length === 0) {
      return this.#performJson(request, context)
    }
    const images = await Promise.all(request.references.map(async (reference, index) => {
      const resolved = await context.resolveAsset(reference.assetId)
      return this.#readInput(resolved.filePath, resolved.asset.format, `reference-${index + 1}`, resolved.asset.contentHash)
    }))
    return this.#performMultipart(request, images, null, context)
  }

  async edit(request: EditRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    this.#validate(request)
    if (!this.capabilities.maskEditing) {
      throw new ProviderError('OPENAI_IMAGES_EDIT_UNSUPPORTED', `${this.label}当前配置未启用蒙版编辑。`, 'validating')
    }
    const source = await context.resolveAsset(request.sourceAssetId)
    const mask = await context.resolveAsset(request.maskAssetId)
    if (source.asset.width !== mask.asset.width || source.asset.height !== mask.asset.height) {
      throw new ProviderError('MASK_DIMENSION_MISMATCH', '局部编辑蒙版尺寸必须与源图完全一致。', 'validating')
    }
    const images: OpenAiImagesFileInput[] = [await this.#readInput(source.filePath, source.asset.format, 'source', source.asset.contentHash)]
    for (const [index, reference] of request.references.entries()) {
      if (reference.assetId === request.sourceAssetId || reference.assetId === request.maskAssetId) continue
      const resolved = await context.resolveAsset(reference.assetId)
      images.push(await this.#readInput(resolved.filePath, resolved.asset.format, `reference-${index + 1}`, resolved.asset.contentHash))
    }
    const maskBytes = await readVerifiedReferenceBytes(mask.filePath, mask.asset.contentHash)
    if (maskBytes.length === 0 || maskBytes.length > MAX_INPUT_IMAGE_BYTES) {
      throw new ProviderError('OPENAI_IMAGES_MASK_SIZE', '编辑蒙版为空或超过 29 MB 安全上限。', 'validating')
    }
    const pngMask = await compileOpenAiEditMask(maskBytes)
    if (pngMask.length > MAX_INPUT_IMAGE_BYTES) {
      throw new ProviderError('OPENAI_IMAGES_MASK_SIZE', '编辑蒙版转换后超过 29 MB 安全上限。', 'validating')
    }
    return this.#performMultipart(request, images, {
      name: 'mask.png',
      mimeType: 'image/png',
      bytes: pngMask
    }, context)
  }

  #validate(request: GenerationRequest | EditRequest): void {
    if (!this.#protocol.allowedModels.includes(request.model)) {
      throw new ProviderError('OPENAI_IMAGES_MODEL_DENIED', `模型 ${request.model} 不在当前图片模块配置中。`, 'validating')
    }
    if (!this.capabilities.textToImage) {
      throw new ProviderError('OPENAI_IMAGES_GENERATION_DISABLED', `${this.label}当前配置未启用文生图。`, 'validating')
    }
    if (request.count > this.capabilities.maxImages) {
      throw new ProviderError('UNSUPPORTED_COUNT', `${this.label}单次最多生成 ${this.capabilities.maxImages} 张图片。`, 'validating')
    }
    if (request.references.length > 0 && !this.capabilities.imageReferences) {
      throw new ProviderError('OPENAI_IMAGES_REFERENCE_UNSUPPORTED', `${this.label}当前配置未启用参考图。`, 'validating')
    }
    if (request.references.length > 1 && !this.capabilities.multipleReferences) {
      throw new ProviderError('OPENAI_IMAGES_MULTI_REFERENCE_UNSUPPORTED', `${this.label}当前配置未启用多参考图。`, 'validating')
    }
  }

  async #performJson(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    const built = this.#protocol.buildGenerationRequest(request)
    return this.#perform(request, context, () => this.#http.postJson({
      ...built,
      secretId: 'image-provider',
      providerId: this.id,
      providerLabel: this.label,
      authorizationScopeId: this.#scopeId(request),
      expectedImages: request.count,
      costCeilingCny: this.#costCeilingCny,
      signal: context.signal,
      timeoutMs: this.#timeoutMs
    }))
  }

  async #performMultipart(
    request: GenerationRequest | EditRequest,
    images: readonly OpenAiImagesFileInput[],
    mask: OpenAiImagesFileInput | null,
    context: ProviderGenerateContext
  ): Promise<readonly ProviderOutput[]> {
    const built = this.#protocol.buildEditRequest({ request, images, mask })
    return this.#perform(request, context, () => this.#http.postMultipart({
      ...built,
      secretId: 'image-provider',
      providerId: this.id,
      providerLabel: this.label,
      authorizationScopeId: this.#scopeId(request),
      expectedImages: request.count,
      costCeilingCny: this.#costCeilingCny,
      signal: context.signal,
      timeoutMs: this.#timeoutMs
    }))
  }

  async #perform(
    request: GenerationRequest | EditRequest,
    context: ProviderGenerateContext,
    send: () => Promise<unknown>
  ): Promise<readonly ProviderOutput[]> {
    let stage: 'submitting' | 'generating' | 'localizing' = 'submitting'
    try {
      await context.onStage('submitting')
      stage = 'generating'
      await context.onStage('generating')
      const images = this.#protocol.parseResponse(await send())
      if (images.length > request.count) {
        throw new ProviderError('OPENAI_IMAGES_UNEXPECTED_COUNT', `${this.label}返回图片数超过本次授权数量。`, 'localizing')
      }
      stage = 'localizing'
      await context.onStage('localizing')
      return Promise.all(images.map((image, index) => this.#localize(image, index)))
    } catch (error) {
      throw failure(error, stage)
    }
  }

  #scopeId(request: GenerationRequest | EditRequest): string {
    const candidate = request.parameters.workflowIntentId ?? request.parameters.workflowInvocationId ?? request.sourceMessageId
    return typeof candidate === 'string' && candidate.trim() !== ''
      ? `image-job:${candidate.trim()}`
      : `image-job:${randomUUID()}`
  }

  async #readInput(
    filePath: string,
    format: 'png' | 'jpeg' | 'webp',
    fallbackName: string,
    contentHash: string
  ): Promise<OpenAiImagesFileInput> {
    const bytes = await readVerifiedReferenceBytes(filePath, contentHash)
    if (bytes.length === 0 || bytes.length > MAX_INPUT_IMAGE_BYTES) {
      throw new ProviderError('OPENAI_IMAGES_REFERENCE_SIZE', '参考图为空或超过 29 MB 安全上限。', 'validating')
    }
    return {
      name: basename(filePath) || `${fallbackName}.${extensionFor(mimeFor(format))}`,
      mimeType: mimeFor(format),
      bytes
    }
  }

  async #localize(image: NormalizedOpenAiImage, index: number): Promise<ProviderOutput> {
    const bytes = Buffer.from(image.value, 'base64')
    if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
      throw new ProviderError('OPENAI_IMAGES_SIZE', '图片结果为空或超过 50 MB 安全上限。', 'localizing')
    }
    const metadata = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
    if (metadata.format !== 'png' && metadata.format !== 'jpeg' && metadata.format !== 'webp') {
      throw new ProviderError('OPENAI_IMAGES_FORMAT', '图片结果格式不是 PNG、JPEG 或 WebP。', 'localizing')
    }
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 80_000_000) {
      throw new ProviderError('OPENAI_IMAGES_DIMENSIONS', '图片结果尺寸超过本地安全上限。', 'localizing')
    }
    const mimeType = mimeFor(metadata.format)
    await mkdir(this.#stagingDirectory, { recursive: true })
    const filePath = join(this.#stagingDirectory, `${randomUUID()}-${index}.${extensionFor(mimeType)}`)
    await writeFile(filePath, bytes, { flag: 'wx' })
    return { filePath, mimeType }
  }
}
