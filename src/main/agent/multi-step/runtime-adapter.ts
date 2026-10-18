import { readFile } from 'node:fs/promises'
import type { Scene } from '../../../domain'
import { resolveLlmEndpoint, type ProviderConfigFile, type ProviderPublicConfig } from '../../../shared/provider-settings'
import { ArkHttpClient } from '../../security/ark-http-client'
import type { ProviderUsageReservation } from '../../security/provider-usage-ledger'
import type { AssetMetadata } from '../../storage/project-repository'
import { createConfiguredTurnProtocol } from '../llm-protocol-factory'
import type { LlmImage } from '../llm/transcript'
import { BUILT_IN_MANUALS } from '../manuals'
import { MultiStepPlannerAdapter, type MultiStepModel } from './multi-step-planner'
import { SceneLooker } from './scene-looker'

type LlmConfig = Extract<ProviderPublicConfig, { kind: 'llm' }>
type ImageConfig = Extract<ProviderPublicConfig, { kind: 'image' }>

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Which agent engine runs turns. A developer switch until the eval decides the default. */
export function selectedAgentEngine(environment: NodeJS.ProcessEnv = process.env): 'plan-once' | 'multi-step' {
  return environment.AI_CANVAS_AGENT_ENGINE === 'multi-step' ? 'multi-step' : 'plan-once'
}

function mimeFor(format: AssetMetadata['format']): LlmImage['mimeType'] {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

function engineError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

export function createMultiStepPlannerAdapter(options: {
  readonly secrets: { has(id: string): Promise<boolean>; get(id: string): Promise<string | null> }
  readonly config: { read(): Promise<ProviderConfigFile> }
  readonly authorization: { reserve(input: ProviderUsageReservation): Promise<unknown> }
  readonly assets: { resolveAsset(assetId: string): Promise<{ readonly asset: AssetMetadata; readonly filePath: string }> }
  readonly scene: () => Scene
  readonly fetcher?: typeof fetch
}): MultiStepPlannerAdapter {
  const providers = async (): Promise<{ readonly llm: LlmConfig | undefined; readonly image: ImageConfig | undefined; readonly file: ProviderConfigFile }> => {
    const file = await options.config.read()
    return {
      llm: file.providers.find((provider): provider is LlmConfig => provider.kind === 'llm'),
      image: file.providers.find((provider): provider is ImageConfig => provider.kind === 'image'),
      file
    }
  }
  const readImage = async (assetId: string): Promise<{ readonly image: LlmImage; readonly bytes: number } | null> => {
    const resolved = await options.assets.resolveAsset(assetId)
    const bytes = await readFile(resolved.filePath)
    if (bytes.length > MAX_IMAGE_BYTES) return null
    return { image: { mimeType: mimeFor(resolved.asset.format), base64: bytes.toString('base64') }, bytes: bytes.length }
  }
  return new MultiStepPlannerAdapter({
    scene: options.scene,
    manuals: BUILT_IN_MANUALS,
    looker: new SceneLooker(async (assetId) => {
      try {
        return (await options.assets.resolveAsset(assetId)).filePath
      } catch {
        return null
      }
    }),
    model: async (): Promise<MultiStepModel> => {
      const { llm } = await providers()
      if (llm === undefined || llm.baseUrl === '' || llm.defaultModel === '' || !await options.secrets.has('openai-compatible-llm')) {
        throw engineError('PROVIDER_KEY_MISSING', '多步 Agent 需要文字模型：先在设置里配置文字模型并保存 API Key。手动编辑照常可用。')
      }
      return {
        protocol: createConfiguredTurnProtocol(llm),
        http: new ArkHttpClient({
          secrets: options.secrets,
          authorization: options.authorization,
          allowedBaseUrls: [llm.baseUrl],
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher })
        }),
        transport: llm.transport,
        timeoutMs: llm.timeoutMs,
        // Thinking shares the output budget with the reply and tool arguments.
        maxOutputTokens: Math.max(llm.maxOutputTokens, 8_192),
        label: llm.label,
        protocolId: llm.protocol,
        endpoint: resolveLlmEndpoint(llm)
      }
    },
    generation: async () => {
      const { image, file } = await providers()
      const available = image !== undefined && image.protocol !== 'unconfigured' && image.baseUrl !== '' && image.defaultModel !== ''
        && image.capabilities.textToImage && (image.protocol !== 'task-images' || file.executionPolicy.maxRequestsPerJob >= 3)
      return available ? { providerId: 'image-provider', model: image.defaultModel, maxImages: Math.min(4, file.executionPolicy.maxImagesPerJob) } : null
    },
    readAttachment: readImage,
    readAsset: async (assetId) => {
      const read = await readImage(assetId)
      if (read === null) throw engineError('ASSET_TOO_LARGE', '这张图片太大，无法交给文字模型查看。')
      return read.image
    }
  })
}
