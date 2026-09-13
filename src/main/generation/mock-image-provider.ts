import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EditRequest, GenerationRequest, ProviderCapabilities } from '../../shared/generation'
import type { ImageProvider, ProviderGenerateContext, ProviderOutput } from './provider'
import { ProviderError } from './provider'

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function numericParameter(request: GenerationRequest | EditRequest, key: string, fallback: number): number {
  const value = request.parameters[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function promptLines(prompt: string, outputWidth: number): readonly string[] {
  const fontSize = Math.max(18, Math.round(outputWidth * 0.032))
  // The preview regularly contains CJK copy, whose glyphs are close to one em
  // wide. A Latin-oriented .5-.6 em estimate lets Chinese captions escape the
  // safe frame even though the character count looks short.
  const maxCharacters = Math.max(8, Math.floor(outputWidth * 0.8 / (fontSize + 2)))
  const source = [...prompt.trim().replace(/\s+/g, ' ')].slice(0, maxCharacters * 2 + 1)
  const first = source.slice(0, maxCharacters).join('')
  const secondSource = source.slice(maxCharacters, maxCharacters * 2)
  const truncated = source.length > maxCharacters * 2
  const second = secondSource.length === 0 ? '' : `${secondSource.join('')}${truncated ? '…' : ''}`
  return [first, second].filter((line) => line.length > 0)
}

export function mockSvg(request: GenerationRequest, variant: number): string {
  const hue = (request.prompt.length * 17 + variant * 67) % 360
  const secondHue = (hue + 55) % 360
  const lines = promptLines(request.prompt, request.outputWidth)
  const prompt = lines
    .map((line, index) => `<tspan x="10%" dy="${index === 0 ? '0' : '1.45em'}">${xmlEscape(line)}</tspan>`)
    .join('')
  return `
    <svg width="${request.outputWidth}" height="${request.outputHeight}" viewBox="0 0 ${request.outputWidth} ${request.outputHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${hue} 34% 22%)"/>
          <stop offset="0.52" stop-color="hsl(${secondHue} 44% 45%)"/>
          <stop offset="1" stop-color="hsl(${hue} 30% 88%)"/>
        </linearGradient>
        <radialGradient id="light"><stop stop-color="#fff" stop-opacity=".74"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#wash)"/>
      <circle cx="76%" cy="23%" r="29%" fill="url(#light)"/>
      <path d="M0 ${request.outputHeight * 0.76} C ${request.outputWidth * 0.28} ${request.outputHeight * 0.54}, ${request.outputWidth * 0.55} ${request.outputHeight * 0.94}, ${request.outputWidth} ${request.outputHeight * 0.62} L ${request.outputWidth} ${request.outputHeight} L0 ${request.outputHeight}Z" fill="#fff" fill-opacity=".18"/>
      <rect x="6%" y="8%" width="88%" height="84%" rx="${Math.min(request.outputWidth, request.outputHeight) * 0.035}" fill="none" stroke="#fff" stroke-opacity=".42" stroke-width="2"/>
      <text x="10%" y="78%" fill="#fff" fill-opacity=".92" font-family="Segoe UI, sans-serif" font-size="${Math.max(18, Math.round(request.outputWidth * 0.032))}" letter-spacing="2">${prompt}</text>
      <text x="10%" y="90%" fill="#fff" fill-opacity=".58" font-family="Segoe UI, sans-serif" font-size="${Math.max(12, Math.round(request.outputWidth * 0.014))}" letter-spacing="4">AI CANVAS · LOCAL ${variant + 1}</text>
    </svg>`
}

export class MockImageProvider implements ImageProvider {
  readonly id = 'mock'
  readonly label = '本地离线引擎'
  readonly capabilities: ProviderCapabilities = {
    textToImage: true,
    imageReferences: true,
    maskEditing: true,
    multipleReferences: true,
    transparentOutput: false,
    maxImages: 4,
    supportedRatios: ['custom'],
    supportedFormats: ['png']
  }
  readonly #stagingDirectory: string

  constructor(stagingDirectory: string) {
    this.#stagingDirectory = stagingDirectory
  }

  async generate(request: GenerationRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    if (request.count > this.capabilities.maxImages) {
      throw new ProviderError('UNSUPPORTED_COUNT', `本地离线引擎最多生成 ${this.capabilities.maxImages} 张预览图。`, 'validating')
    }
    await mkdir(this.#stagingDirectory, { recursive: true })
    await context.onStage('submitting')
    await wait(numericParameter(request, 'mockSubmitDelayMs', 24), context.signal)
    if (request.model === 'mock-failure') {
      throw new ProviderError('MOCK_PROVIDER_FAILURE', '离线失败状态验证已触发；生成要求仍保留，可直接重试。', 'generating')
    }
    await context.onStage('generating')
    const generationDelay = request.model === 'mock-timeout'
      ? numericParameter(request, 'mockGenerationDelayMs', 60_000)
      : request.model === 'mock-slow'
        ? numericParameter(request, 'mockGenerationDelayMs', 700)
        : numericParameter(request, 'mockGenerationDelayMs', 60)
    await wait(generationDelay, context.signal)

    const outputs: ProviderOutput[] = []
    for (let variant = 0; variant < request.count; variant += 1) {
      if (context.signal.aborted) throw context.signal.reason
      const filePath = join(this.#stagingDirectory, `${crypto.randomUUID()}-${variant}.png`)
      await sharp(Buffer.from(mockSvg(request, variant))).png().toFile(filePath)
      outputs.push({ filePath, mimeType: 'image/png' })
    }
    await context.onStage('localizing')
    return outputs
  }

  async edit(request: EditRequest, context: ProviderGenerateContext): Promise<readonly ProviderOutput[]> {
    if (request.count > this.capabilities.maxImages) {
      throw new ProviderError('UNSUPPORTED_COUNT', `本地离线引擎最多生成 ${this.capabilities.maxImages} 张预览图。`, 'validating')
    }
    await mkdir(this.#stagingDirectory, { recursive: true })
    await context.onStage('submitting')
    await wait(numericParameter(request, 'mockSubmitDelayMs', 24), context.signal)
    if (request.model === 'mock-failure') {
      throw new ProviderError('MOCK_PROVIDER_FAILURE', '离线失败状态验证已触发；局部修改要求与蒙版仍保留，可直接重试。', 'generating')
    }
    const source = await context.resolveAsset(request.sourceAssetId)
    const mask = await context.resolveAsset(request.maskAssetId)
    if (mask.asset.width !== source.asset.width || mask.asset.height !== source.asset.height) {
      throw new ProviderError('MASK_DIMENSION_MISMATCH', 'The edit mask dimensions must exactly match the source image.', 'validating')
    }
    await context.onStage('generating')
    const editDelay = request.model === 'mock-slow'
      ? numericParameter(request, 'mockGenerationDelayMs', 700)
      : request.model === 'mock-timeout'
        ? numericParameter(request, 'mockGenerationDelayMs', 60_000)
        : numericParameter(request, 'mockGenerationDelayMs', 70)
    await wait(editDelay, context.signal)

    const width = source.asset.width
    const height = source.asset.height
    const maskAlpha = await sharp(mask.filePath).greyscale().removeAlpha().raw().toBuffer()
    const hue = (request.prompt.length * 23) % 360
    const color = await sharp({
      create: { width, height, channels: 3, background: `hsl(${hue}, 62%, 54%)` }
    })
      .joinChannel(maskAlpha, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer()
    const outputs: ProviderOutput[] = []
    for (let variant = 0; variant < request.count; variant += 1) {
      if (context.signal.aborted) throw context.signal.reason
      const filePath = join(this.#stagingDirectory, `${crypto.randomUUID()}-edit-${variant}.png`)
      await sharp(source.filePath)
        .rotate()
        .resize(width, height, { fit: 'fill' })
        .composite([{ input: color, blend: 'over' }])
        .png()
        .toFile(filePath)
      outputs.push({ filePath, mimeType: 'image/png' })
    }
    await context.onStage('localizing')
    return outputs
  }
}
