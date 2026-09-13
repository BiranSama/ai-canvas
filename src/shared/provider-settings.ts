import { z } from 'zod'

export const configurableProviderIdSchema = z.enum(['openai-compatible-llm', 'image-provider'])

export const llmProtocolSchema = z.enum([
  'ark-responses',
  'openai-responses',
  'openai-chat-completions'
])

export const llmReasoningEffortSchema = z.enum([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export const llmImageDetailSchema = z.enum(['auto', 'low', 'original'])

export const llmTransportModeSchema = z.enum(['auto', 'stream', 'buffered'])

export const llmTransportSettingsSchema = z.object({
  mode: llmTransportModeSchema,
  connectTimeoutMs: z.number().int().min(1_000).max(60_000),
  firstEventTimeoutMs: z.number().int().min(1_000).max(120_000),
  idleTimeoutMs: z.number().int().min(1_000).max(180_000)
}).strict()

export const DEFAULT_LLM_TRANSPORT_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 20_000,
  firstEventTimeoutMs: 45_000,
  idleTimeoutMs: 60_000
})

export const imageProtocolSchema = z.enum([
  'ark-seedream',
  'openai-images',
  'task-images',
  'unconfigured'
])

export const providerSecretInputSchema = z.object({
  providerId: configurableProviderIdSchema,
  apiKey: z.string().trim().min(8).max(16_384)
})

const endpointSchema = z.union([
  z.literal(''),
  z.string().url().max(2_048).refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  }, 'Provider API address must use credential-free HTTPS without query parameters or fragments.')
])

const providerPublicFieldsSchema = z.object({
  label: z.string().trim().min(1).max(80),
  baseUrl: endpointSchema,
  defaultModel: z.string().trim().max(160),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  concurrency: z.number().int().min(1).max(8)
})

const legacyLlmProviderConfigSchema = providerPublicFieldsSchema.extend({
  id: z.literal('openai-compatible-llm'),
  kind: z.literal('llm'),
  reasoningEffort: llmReasoningEffortSchema.default('auto'),
  imageDetail: llmImageDetailSchema.default('auto'),
  maxOutputTokens: z.number().int().min(256).max(131_072).default(4_096),
  capabilities: z.object({
    streaming: z.boolean(),
    toolCalling: z.boolean(),
    vision: z.boolean().default(false)
  })
})

const llmProviderConfigV4Schema = legacyLlmProviderConfigSchema.extend({
  protocol: llmProtocolSchema
})

export const llmProviderConfigSchema = llmProviderConfigV4Schema.extend({
  transport: llmTransportSettingsSchema
}).superRefine((value, context) => {
  const timeoutFields = [
    ['transport.connectTimeoutMs', value.transport.connectTimeoutMs],
    ['transport.firstEventTimeoutMs', value.transport.firstEventTimeoutMs],
    ['transport.idleTimeoutMs', value.transport.idleTimeoutMs]
  ] as const
  for (const [path, timeout] of timeoutFields) {
    if (timeout <= value.timeoutMs) continue
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: path.split('.'),
      message: '局部超时不能大于单次请求总上限。'
    })
  }
})

const legacyImageProviderConfigSchema = providerPublicFieldsSchema.extend({
  id: z.literal('image-provider'),
  kind: z.literal('image'),
  capabilities: z.object({
    textToImage: z.boolean(),
    imageReferences: z.boolean(),
    maskEditing: z.boolean(),
    multipleReferences: z.boolean(),
    transparentOutput: z.boolean()
  })
})

export const imageProviderConfigSchema = legacyImageProviderConfigSchema.extend({
  protocol: imageProtocolSchema
})

export const providerPublicConfigSchema = z.union([
  llmProviderConfigSchema,
  imageProviderConfigSchema
])

const providerExecutionPolicyFields = {
  approvalMode: z.enum(['confirm_each', 'session']),
  autoGenerate: z.boolean(),
  maxRequestsPerJob: z.number().int().min(1).max(100),
  maxImagesPerJob: z.number().int().min(1).max(16),
  maxCostCnyPerJob: z.number().min(0).max(10_000)
} as const

export const providerExecutionPolicySchema = z.object(providerExecutionPolicyFields).strict()

// Product V1 briefly wrote `unlimitedSpend` during development. Read and
// discard that field so existing local settings migrate to a finite ceiling.
const storedProviderExecutionPolicySchema = z.object({
  ...providerExecutionPolicyFields,
  unlimitedSpend: z.boolean().optional()
}).transform(({ approvalMode, autoGenerate, maxRequestsPerJob, maxImagesPerJob, maxCostCnyPerJob }) => providerExecutionPolicySchema.parse({
  approvalMode,
  autoGenerate,
  maxRequestsPerJob,
  maxImagesPerJob,
  maxCostCnyPerJob
}))

export const DEFAULT_PROVIDER_EXECUTION_POLICY = providerExecutionPolicySchema.parse({
  approvalMode: 'confirm_each',
  autoGenerate: false,
  maxRequestsPerJob: 50,
  maxImagesPerJob: 4,
  maxCostCnyPerJob: 20
})

const providerConfigFileV1Schema = z.object({
  version: z.literal(1),
  providers: z.tuple([legacyLlmProviderConfigSchema, legacyImageProviderConfigSchema])
})

const providerConfigFileV2Schema = z.object({
  version: z.literal(2),
  providers: z.tuple([legacyLlmProviderConfigSchema, legacyImageProviderConfigSchema]),
  executionPolicy: storedProviderExecutionPolicySchema
})

const providerConfigFileV3Schema = z.object({
  version: z.literal(3),
  providers: z.tuple([llmProviderConfigV4Schema, legacyImageProviderConfigSchema]),
  executionPolicy: storedProviderExecutionPolicySchema
})

const providerConfigFileV4Schema = z.object({
  version: z.literal(4),
  providers: z.tuple([llmProviderConfigV4Schema, imageProviderConfigSchema]),
  executionPolicy: storedProviderExecutionPolicySchema
})

const providerConfigFileV5Schema = z.object({
  version: z.literal(5),
  providers: z.tuple([llmProviderConfigSchema, imageProviderConfigSchema]),
  executionPolicy: storedProviderExecutionPolicySchema
})

export function inferLlmProtocol(baseUrl: string): z.infer<typeof llmProtocolSchema> {
  if (baseUrl === '') return 'openai-responses'
  try {
    return new URL(baseUrl).hostname === 'ark.cn-beijing.volces.com'
      ? 'ark-responses'
      : 'openai-responses'
  } catch {
    return 'openai-responses'
  }
}

export function inferImageProtocol(baseUrl: string): z.infer<typeof imageProtocolSchema> {
  if (baseUrl === '') return 'unconfigured'
  try {
    const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    if (url.hostname === 'ark.cn-beijing.volces.com') return 'ark-seedream'
    if (url.origin === 'https://api.krill-ai.net' && url.pathname === '/v1/') return 'task-images'
    return 'unconfigured'
  } catch {
    return 'unconfigured'
  }
}

function migrateLegacyProviders(
  providers: z.infer<typeof providerConfigFileV1Schema>['providers']
): z.infer<typeof providerConfigFileV5Schema>['providers'] {
  const [llm, image] = providers
  return [
    withLegacyTransport({ ...llm, protocol: inferLlmProtocol(llm.baseUrl) }),
    { ...image, protocol: inferImageProtocol(image.baseUrl) }
  ]
}

function migrateV3Providers(
  providers: z.infer<typeof providerConfigFileV3Schema>['providers']
): z.infer<typeof providerConfigFileV5Schema>['providers'] {
  const [llm, image] = providers
  return [withLegacyTransport(llm), { ...image, protocol: inferImageProtocol(image.baseUrl) }]
}

function withLegacyTransport(
  llm: z.infer<typeof llmProviderConfigV4Schema>
): z.infer<typeof llmProviderConfigSchema> {
  return llmProviderConfigSchema.parse({
    ...llm,
    transport: {
      mode: llm.capabilities.streaming ? 'auto' : 'buffered',
      connectTimeoutMs: Math.min(DEFAULT_LLM_TRANSPORT_TIMEOUTS.connectTimeoutMs, llm.timeoutMs),
      firstEventTimeoutMs: Math.min(DEFAULT_LLM_TRANSPORT_TIMEOUTS.firstEventTimeoutMs, llm.timeoutMs),
      idleTimeoutMs: Math.min(DEFAULT_LLM_TRANSPORT_TIMEOUTS.idleTimeoutMs, llm.timeoutMs)
    }
  })
}

function migrateV4Providers(
  providers: z.infer<typeof providerConfigFileV4Schema>['providers']
): z.infer<typeof providerConfigFileV5Schema>['providers'] {
  return [withLegacyTransport(providers[0]), providers[1]]
}

export const providerConfigFileSchema = z.union([
  providerConfigFileV5Schema,
  providerConfigFileV4Schema.transform((value) => ({
    version: 5 as const,
    providers: migrateV4Providers(value.providers),
    executionPolicy: value.executionPolicy
  })),
  providerConfigFileV3Schema.transform((value) => ({
    version: 5 as const,
    providers: migrateV3Providers(value.providers),
    executionPolicy: value.executionPolicy
  })),
  providerConfigFileV2Schema.transform((value) => ({
    version: 5 as const,
    providers: migrateLegacyProviders(value.providers),
    executionPolicy: value.executionPolicy
  })),
  providerConfigFileV1Schema.transform((value) => ({
    version: 5 as const,
    providers: migrateLegacyProviders(value.providers),
    executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY
  }))
])

export const providerSettingSchema = z.union([
  llmProviderConfigSchema.and(z.object({ configured: z.boolean() })),
  imageProviderConfigSchema.extend({ configured: z.boolean() })
])

export const providerSettingsSnapshotSchema = z.object({
  providers: z.array(providerSettingSchema).length(2),
  realCallsAuthorized: z.boolean(),
  executionPolicy: providerExecutionPolicySchema
})

export const providerConnectionTestInputSchema = z.object({
  providerId: z.literal('openai-compatible-llm'),
  confirmed: z.literal(true)
}).strict()

const providerConnectionFailureSchema = z.object({
  code: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  detail: z.string().trim().min(1).max(1_000),
  nextAction: z.string().trim().min(1).max(500),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  contentType: z.string().max(200).nullable()
})

const providerConnectionTestBaseSchema = z.object({
  providerId: z.literal('openai-compatible-llm'),
  providerLabel: z.string().trim().min(1).max(80),
  protocol: llmProtocolSchema,
  model: z.string().trim().max(160),
  endpoint: z.string().max(2_048),
  checkedAt: z.string().datetime(),
  requestsUsed: z.number().int().min(0).max(1),
  generatedImages: z.literal(0),
  costCeilingCny: z.number().min(0).max(10)
})

export const providerConnectionTestResultSchema = z.discriminatedUnion('ok', [
  providerConnectionTestBaseSchema.extend({
    ok: z.literal(true),
    toolCallingVerified: z.literal(true),
    failure: z.null()
  }),
  providerConnectionTestBaseSchema.extend({
    ok: z.literal(false),
    toolCallingVerified: z.literal(false),
    failure: providerConnectionFailureSchema
  })
])

export type ConfigurableProviderId = z.infer<typeof configurableProviderIdSchema>
export type LlmProtocol = z.infer<typeof llmProtocolSchema>
export type LlmReasoningEffort = z.infer<typeof llmReasoningEffortSchema>
export type LlmImageDetail = z.infer<typeof llmImageDetailSchema>
export type LlmTransportMode = z.infer<typeof llmTransportModeSchema>
export type LlmTransportSettings = z.infer<typeof llmTransportSettingsSchema>
export type ImageProtocol = z.infer<typeof imageProtocolSchema>
export type ProviderSecretInput = z.infer<typeof providerSecretInputSchema>
export type ProviderPublicConfig = z.infer<typeof providerPublicConfigSchema>
export type ProviderConfigFile = z.infer<typeof providerConfigFileSchema>
export type ProviderExecutionPolicy = z.infer<typeof providerExecutionPolicySchema>
export type ProviderSettingsSnapshot = z.infer<typeof providerSettingsSnapshotSchema>
export type ProviderConnectionTestInput = z.infer<typeof providerConnectionTestInputSchema>
export type ProviderConnectionTestResult = z.infer<typeof providerConnectionTestResultSchema>

export function resolveLlmProtocolEndpoint(baseUrl: string, protocol: z.infer<typeof llmProtocolSchema>): string {
  if (baseUrl === '') return ''
  const target = protocol === 'openai-chat-completions' ? 'chat/completions' : 'responses'
  const direct = new URL(baseUrl)
  const normalizedPath = direct.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith(`/${target}`)) return direct.toString()
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  return new URL(target, base).toString()
}

export function resolveLlmEndpoint(config: z.infer<typeof llmProviderConfigSchema>): string {
  return resolveLlmProtocolEndpoint(config.baseUrl, config.protocol)
}

export type ImageProtocolOperation = 'generate' | 'edit' | 'status' | 'content'

function imageProtocolBase(baseUrl: string): URL {
  const direct = new URL(baseUrl)
  const normalizedPath = direct.pathname.replace(/\/+$/, '')
  const suffix = ['/images/generations', '/images/edits'].find((candidate) => normalizedPath.endsWith(candidate))
  if (suffix !== undefined) direct.pathname = normalizedPath.slice(0, -suffix.length) || '/'
  direct.search = ''
  direct.hash = ''
  return new URL(direct.toString().endsWith('/') ? direct.toString() : `${direct.toString()}/`)
}

export function resolveImageProtocolEndpoint(
  baseUrl: string,
  protocol: z.infer<typeof imageProtocolSchema>,
  operation: ImageProtocolOperation = 'generate',
  taskId?: string
): string {
  if (baseUrl === '' || protocol === 'unconfigured') return ''
  const base = imageProtocolBase(baseUrl)
  if (operation === 'generate') return new URL('images/generations', base).toString()
  if (operation === 'edit') return new URL('images/edits', base).toString()
  if (taskId === undefined || taskId.trim() === '') return ''
  const encodedTaskId = encodeURIComponent(taskId.trim())
  return new URL(`images/${encodedTaskId}${operation === 'content' ? '/content' : ''}`, base).toString()
}

export function resolveImageEndpoint(
  config: z.infer<typeof imageProviderConfigSchema>,
  operation: ImageProtocolOperation = 'generate',
  taskId?: string
): string {
  return resolveImageProtocolEndpoint(config.baseUrl, config.protocol, operation, taskId)
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfigFile = {
  version: 5,
  providers: [
    {
      id: 'openai-compatible-llm',
      kind: 'llm',
      label: '火山方舟 · Seed 2.1 Turbo',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'doubao-seed-2-1-turbo-260628',
      protocol: 'ark-responses',
      reasoningEffort: 'auto',
      imageDetail: 'auto',
      maxOutputTokens: 4_096,
      timeoutMs: 30_000,
      transport: {
        mode: 'auto',
        connectTimeoutMs: 20_000,
        firstEventTimeoutMs: 30_000,
        idleTimeoutMs: 30_000
      },
      concurrency: 1,
      capabilities: { streaming: true, toolCalling: true, vision: true }
    },
    {
      id: 'image-provider',
      kind: 'image',
      label: '火山方舟 · Seedream 5.0',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'doubao-seedream-5-0-260128',
      protocol: 'ark-seedream',
      timeoutMs: 120_000,
      concurrency: 1,
      capabilities: {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: true,
        transparentOutput: false
      }
    }
  ],
  executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY
}
