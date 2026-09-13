import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiImagesProvider } from '../../src/main/generation/openai-images-provider'
import { OPENAI_IMAGES_CAPABILITIES, OpenAiImagesProtocol } from '../../src/main/generation/openai-images-protocol'
import type { ArkHttpClient } from '../../src/main/security/ark-http-client'
import type { EditRequest, GenerationRequest } from '../../src/shared/generation'
import type { AssetMetadata } from '../../src/main/storage/project-repository'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: 'editorial still life',
    negativePrompt: '',
    aspectWidth: 1,
    aspectHeight: 1,
    outputWidth: 1024,
    outputHeight: 1024,
    count: 1,
    providerId: 'image-provider',
    model: 'owner-image',
    references: [],
    parameters: {},
    sourceMessageId: null,
    parentResultId: null,
    referenceMode: 'hybrid',
    variationInstruction: '',
    preserveConstraints: '',
    ...overrides
  }
}

async function asset(id: string, filePath: string, width: number, height: number): Promise<{ asset: AssetMetadata; filePath: string }> {
  return {
    filePath,
    asset: {
      id,
      projectId: 'project-1',
      relativePath: filePath,
      thumbnailRelativePath: filePath,
      contentHash: createHash('sha256').update(await readFile(filePath)).digest('hex'),
      width,
      height,
      format: 'png',
      hasAlpha: true,
      sourceType: 'reference',
      sourceId: null,
      status: 'available',
      createdAt: new Date(0).toISOString()
    }
  }
}

describe('OpenAI Images provider offline execution', () => {
  it('routes generation, references and mask edits through the saved protocol without URL downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-openai-images-'))
    roots.push(root)
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 1 } }
    }).png().toBuffer()
    const sourcePath = join(root, 'source.png')
    const maskPath = join(root, 'mask.png')
    await writeFile(sourcePath, png)
    // Production masks use white for editing and black for protection.
    const mask = Buffer.from(Array.from({ length: 64 }, (_, index) => [0, 64, 128, 255][index % 4]!))
    await sharp(mask, { raw: { width: 8, height: 8, channels: 1 } }).png().toFile(maskPath)

    const postJson = vi.fn<(input: Parameters<ArkHttpClient['postJson']>[0]) => Promise<unknown>>(async () => ({
      data: [{ b64_json: png.toString('base64') }]
    }))
    const postMultipart = vi.fn<(input: Parameters<ArkHttpClient['postMultipart']>[0]) => Promise<unknown>>(async () => ({
      data: [{ b64_json: png.toString('base64') }]
    }))
    const provider = new OpenAiImagesProvider({
      label: 'Owner Image Relay',
      capabilities: OPENAI_IMAGES_CAPABILITIES,
      protocol: new OpenAiImagesProtocol({
        baseUrl: 'https://images.example.test/v1',
        allowedModels: ['owner-image']
      }),
      http: { postJson, postMultipart },
      stagingDirectory: join(root, 'staging'),
      timeoutMs: 30_000,
      costCeilingCny: 3
    })
    const assets = new Map([
      ['source', await asset('source', sourcePath, 8, 8)],
      ['mask', await asset('mask', maskPath, 8, 8)]
    ])
    const context = {
      signal: new AbortController().signal,
      onStage: vi.fn(async () => undefined),
      onExternalTaskId: vi.fn(async () => undefined),
      resolveAsset: async (assetId: string) => {
        const resolved = assets.get(assetId)
        if (resolved === undefined) throw new Error(`Missing ${assetId}`)
        return resolved
      }
    }

    const generated = await provider.generate(request(), context)
    const referenced = await provider.generate(request({
      references: [{ assetId: 'source', intent: 'subject', strength: 0.8 }]
    }), context)
    const editRequest: EditRequest = {
      ...request(),
      kind: 'edit',
      sourceAssetId: 'source',
      maskAssetId: 'mask'
    }
    const edited = await provider.edit(editRequest, context)

    expect(postJson).toHaveBeenCalledTimes(1)
    expect(postJson.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://images.example.test/v1/images/generations',
      secretId: 'image-provider',
      expectedImages: 1,
      costCeilingCny: 3
    })
    expect(postMultipart).toHaveBeenCalledTimes(2)
    expect(postMultipart.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://images.example.test/v1/images/edits',
      files: [expect.objectContaining({ field: 'image[]' })]
    })
    expect(postMultipart.mock.calls[1]?.[0].files.map((file) => file.field)).toEqual(['image[]', 'mask'])
    const sentMask = postMultipart.mock.calls[1]![0].files.find((file) => file.field === 'mask')!
    const decodedMask = await sharp(sentMask.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(decodedMask.info).toMatchObject({ width: 8, height: 8, channels: 4 })
    expect(Array.from({ length: 64 }, (_, index) => decodedMask.data[index * 4 + 3])).toEqual(Array.from({ length: 64 }, (_, index) => [255, 191, 127, 0][index % 4]!))
    expect(context.onExternalTaskId).not.toHaveBeenCalled()
    for (const output of [...generated, ...referenced, ...edited]) {
      expect(output.mimeType).toBe('image/png')
      await expect(readFile(output.filePath)).resolves.toEqual(png)
    }
  })
})
