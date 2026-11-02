import { z } from 'zod'
import { llmPricingSchema } from './model-usage'

/** The first image service keeps this id, so keys and jobs saved before several services existed still match. */
export const PRIMARY_IMAGE_PROVIDER_ID = 'image-provider'
export const MAX_IMAGE_PROVIDERS = 8
export const imageProviderIdSchema = z.string().regex(/^image-provider(?:-[a-z0-9]{1,24})?$/)
export const MAIN_TEXT_MODEL_ID = 'openai-compatible-llm'
/**
 * Text models that help the main one: one that looks at pictures when the
 * main model cannot, and one a request moves to when the main model is
 * rate limited or down.
 */
export const TEXT_HELPER_IDS = { vision: 'text-model-vision', backup: 'text-model-backup' } as const
export type TextHelperRole = keyof typeof TEXT_HELPER_IDS
export const TEXT_HELPER_ROLES = Object.keys(TEXT_HELPER_IDS) as readonly TextHelperRole[]
export const textHelperIdSchema = z.enum([TEXT_HELPER_IDS.vision, TEXT_HELPER_IDS.backup])
export const textHelperRoleSchema = z.enum(['vision', 'backup'])
export const configurableProviderIdSchema = z.union([z.literal(MAIN_TEXT_MODEL_ID), textHelperIdSchema, imageProviderIdSchema])

export const llmProtocolSchema = z.enum([
  'ark-responses',
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages'
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
  firstEventTimeoutMs: z.number().int().min(1_000).max(600_000),
  idleTimeoutMs: z.number().int().min(1_000).max(600_000)
}).strict()

/**
 * A thinking model can be silent for well over a minute before its first
 * token, and one call of a long turn can take minutes; only a connection
 * that never opens is given up on quickly.
 */
export const DEFAULT_LLM_TRANSPORT_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 20_000,
  firstEventTimeoutMs: 120_000,
  idleTimeoutMs: 120_000
})

/** The longest a single text-model or image request may be given. */
export const MAX_REQUEST_TIMEOUT_MS = 900_000

/** A whole text-model request, and a whole image request: some image services take minutes per picture. */
export const DEFAULT_LLM_TIMEOUT_MS = 300_000
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000

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
  timeoutMs: z.number().int().min(1_000).max(MAX_REQUEST_TIMEOUT_MS),
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

const llmProviderFieldsSchema = llmProviderConfigV4Schema.extend({
  transport: llmTransportSettingsSchema,
  /** Optional prices for the per-turn cost estimate; null shows tokens only. */
  pricing: llmPricingSchema.nullable().default(null)
})

function transportWithinTimeout(value: { readonly timeoutMs: number; readonly transport: z.infer<typeof llmTransportSettingsSchema> }, context: z.RefinementCtx): void {
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
}

export const llmProviderConfigSchema = llmProviderFieldsSchema.superRefine(transportWithinTimeout)

/** A vision or backup text model: the same settings as the main one, under its own id and key. */
export const textHelperConfigSchema = llmProviderFieldsSchema.extend({ id: textHelperIdSchema }).superRefine(transportWithinTimeout)

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
  id: imageProviderIdSchema,
  protocol: imageProtocolSchema,
  /** What the owner pays per image, for estimates; null leaves the cost unknown. */
  pricePerImageCny: z.number().min(0).max(10_000).nullable().default(null)
})

export const providerPublicConfigSchema = z.union([
  llmProviderConfigSchema,
  textHelperConfigSchema,
  imageProviderConfigSchema
])

/** How a service's latest 测试 went; cleared when its address, interface, model or key changes. */
export const providerCheckSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string().datetime(),
  latencyMs: z.number().int().min(0).max(3_600_000).nullable(),
  /** One line in the person's words: what worked, or what failed and what to do. */
  summary: z.string().trim().min(1).max(400)
}).strict()

const textHelpersSchema = z.object({
  vision: textHelperConfigSchema.nullable().default(null),
  backup: textHelperConfigSchema.nullable().default(null)
}).superRefine((helpers, context) => {
  for (const role of ['vision', 'backup'] as const) {
    const helper = helpers[role]
    if (helper !== null && helper.id !== TEXT_HELPER_IDS[role]) context.addIssue({ code: 'custom', path: [role, 'id'], message: 'A helper text model keeps its role\'s id.' })
  }
})

const providerExecutionPolicyFields = {
  approvalMode: z.enum(['confirm_each', 'session']),
  autoGenerate: z.boolean(),
  maxRequestsPerJob: z.number().int().min(1).max(100),
  maxImagesPerJob: z.number().int().min(1).max(16),
  maxCostCnyPerJob: z.number().min(0).max(10_000),
  /** The estimated spend, text model and images at the prices set, at which an Agent turn pauses. */
  maxCostCnyPerTurn: z.number().min(0.1).max(10_000).default(3)
} as const

export const providerExecutionPolicySchema = z.object(providerExecutionPolicyFields).strict()

// Product V1 briefly wrote `unlimitedSpend` during development, and later
// settings a multiple of the Agent's per-turn steps. Read and discard both:
// spending keeps a finite ceiling, and the steps are now guards, not a setting.
const storedProviderExecutionPolicySchema = z.object({
  ...providerExecutionPolicyFields,
  unlimitedSpend: z.boolean().optional(),
  agentStepScale: z.number().optional()
}).transform(({ approvalMode, autoGenerate, maxRequestsPerJob, maxImagesPerJob, maxCostCnyPerJob, maxCostCnyPerTurn }) => providerExecutionPolicySchema.parse({
  approvalMode,
  autoGenerate,
  maxRequestsPerJob,
  maxImagesPerJob,
  maxCostCnyPerJob,
  maxCostCnyPerTurn
}))

type GenerationApproval = Pick<ProviderExecutionPolicy, 'approvalMode' | 'autoGenerate'>

/**
 * 「生图前先问我」, read from the two fields that hold it: off only when real
 * generations go ahead unasked and the Agent may start them on its own.
 * Any other pair asks, as it did before the two became one switch.
 */
export function asksBeforeGenerating(policy: GenerationApproval): boolean {
  return !(policy.approvalMode === 'session' && policy.autoGenerate)
}

export function withAskBeforeGenerating<T extends GenerationApproval>(policy: T, ask: boolean): T {
  return { ...policy, approvalMode: ask ? 'confirm_each' : 'session', autoGenerate: !ask }
}

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

/** The text model, then one to eight image services; the first image service is the primary one. */
const providerListSchema = z.tuple([llmProviderConfigSchema, imageProviderConfigSchema], imageProviderConfigSchema).superRefine((providers, context) => {
  const images = providers.slice(1)
  if (images.length > MAX_IMAGE_PROVIDERS) context.addIssue({ code: 'custom', message: `最多保存 ${MAX_IMAGE_PROVIDERS} 个生图服务。` })
  if (providers[1].id !== PRIMARY_IMAGE_PROVIDER_ID) context.addIssue({ code: 'custom', path: [1, 'id'], message: 'The first image service keeps the primary id.' })
  if (new Set(images.map((image) => image.id)).size !== images.length) context.addIssue({ code: 'custom', message: 'Image service ids must be unique.' })
})

const currentProviderConfigFields = {
  providers: providerListSchema,
  /** The image service the agent and quick generation use unless another is chosen. */
  defaultImageProviderId: imageProviderIdSchema,
  executionPolicy: storedProviderExecutionPolicySchema
}

function defaultImageIsSaved(file: { readonly providers: readonly ProviderPublicConfig[]; readonly defaultImageProviderId: string }, context: z.RefinementCtx): void {
  if (!file.providers.slice(1).some((provider) => provider.id === file.defaultImageProviderId)) {
    context.addIssue({ code: 'custom', path: ['defaultImageProviderId'], message: 'The default image service must be one of the saved services.' })
  }
}

const providerConfigFileV6Schema = z.object({ version: z.literal(6), ...currentProviderConfigFields }).superRefine(defaultImageIsSaved)

/** Version 7 has the same shape; its time limits are at least the ones above. */
const providerConfigFileV7Schema = z.object({ version: z.literal(7), ...currentProviderConfigFields }).superRefine(defaultImageIsSaved)

/** Version 8 adds the vision and backup text models and each service's latest 测试. */
const providerConfigFileV8Schema = z.object({
  version: z.literal(8),
  ...currentProviderConfigFields,
  textHelpers: textHelpersSchema.default({ vision: null, backup: null }),
  checks: z.record(configurableProviderIdSchema, providerCheckSchema).default({})
}).superRefine(defaultImageIsSaved)

export const PROVIDER_CONFIG_VERSION = 8

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
    imageProviderConfigSchema.parse({ ...image, protocol: inferImageProtocol(image.baseUrl) })
  ]
}

function migrateV3Providers(
  providers: z.infer<typeof providerConfigFileV3Schema>['providers']
): z.infer<typeof providerConfigFileV5Schema>['providers'] {
  const [llm, image] = providers
  return [withLegacyTransport(llm), imageProviderConfigSchema.parse({ ...image, protocol: inferImageProtocol(image.baseUrl) })]
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

function asV6(
  providers: z.infer<typeof providerConfigFileV5Schema>['providers'],
  executionPolicy: z.infer<typeof storedProviderExecutionPolicySchema>
): z.infer<typeof providerConfigFileV6Schema> {
  return { version: 6, providers, defaultImageProviderId: PRIMARY_IMAGE_PROVIDER_ID, executionPolicy }
}

/**
 * Settings saved before version 7 gave up on a thinking model after 30 to 45
 * seconds of silence and on an image after two minutes; they are raised to
 * the new defaults, and longer ones are kept.
 */
function asV7(file: z.infer<typeof providerConfigFileV6Schema>): z.infer<typeof providerConfigFileV7Schema> {
  const [llm, ...images] = file.providers
  return {
    ...file,
    version: 7,
    providers: [
      llmProviderConfigSchema.parse({
        ...llm,
        timeoutMs: Math.max(llm.timeoutMs, DEFAULT_LLM_TIMEOUT_MS),
        transport: {
          ...llm.transport,
          firstEventTimeoutMs: Math.max(llm.transport.firstEventTimeoutMs, DEFAULT_LLM_TRANSPORT_TIMEOUTS.firstEventTimeoutMs),
          idleTimeoutMs: Math.max(llm.transport.idleTimeoutMs, DEFAULT_LLM_TRANSPORT_TIMEOUTS.idleTimeoutMs)
        }
      }),
      ...images.map((image) => ({ ...image, timeoutMs: Math.max(image.timeoutMs, DEFAULT_IMAGE_TIMEOUT_MS) }))
    ] as z.infer<typeof providerListSchema>
  }
}

/** Settings saved before version 8 have no helper text models and no stored checks. */
function asV8(file: z.infer<typeof providerConfigFileV7Schema>): z.infer<typeof providerConfigFileV8Schema> {
  return { ...file, version: 8, textHelpers: { vision: null, backup: null }, checks: {} }
}

export const providerConfigFileSchema = z.union([
  providerConfigFileV8Schema,
  providerConfigFileV7Schema.transform(asV8),
  providerConfigFileV6Schema.transform((value) => asV8(asV7(value))),
  providerConfigFileV5Schema.transform((value) => asV8(asV7(asV6(value.providers, value.executionPolicy)))),
  providerConfigFileV4Schema.transform((value) => asV8(asV7(asV6(migrateV4Providers(value.providers), value.executionPolicy)))),
  providerConfigFileV3Schema.transform((value) => asV8(asV7(asV6(migrateV3Providers(value.providers), value.executionPolicy)))),
  providerConfigFileV2Schema.transform((value) => asV8(asV7(asV6(migrateLegacyProviders(value.providers), value.executionPolicy)))),
  providerConfigFileV1Schema.transform((value) => asV8(asV7(asV6(migrateLegacyProviders(value.providers), DEFAULT_PROVIDER_EXECUTION_POLICY))))
])

export const providerSettingSchema = z.union([
  llmProviderConfigSchema.and(z.object({ configured: z.boolean() })),
  imageProviderConfigSchema.extend({ configured: z.boolean() })
])

const textHelperSettingSchema = textHelperConfigSchema.and(z.object({ configured: z.boolean() }))

export const providerSettingsSnapshotSchema = z.object({
  providers: z.array(providerSettingSchema).min(2).max(1 + MAX_IMAGE_PROVIDERS),
  defaultImageProviderId: imageProviderIdSchema,
  realCallsAuthorized: z.boolean(),
  executionPolicy: providerExecutionPolicySchema,
  textHelpers: z.object({ vision: textHelperSettingSchema.nullable(), backup: textHelperSettingSchema.nullable() }),
  checks: z.record(z.string(), providerCheckSchema)
})

export const providerConnectionTestInputSchema = z.object({
  providerId: z.literal('openai-compatible-llm'),
  confirmed: z.literal(true),
  /** `agent_loop` runs two steps with thinking and the tool result sent back, as the multi-step agent does. */
  scope: z.enum(['tool_call', 'agent_loop']).default('tool_call')
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
  requestsUsed: z.number().int().min(0).max(2),
  generatedImages: z.literal(0),
  costCeilingCny: z.number().min(0).max(10),
  agentLoop: z.object({
    dialect: z.string().trim().min(1).max(64),
    thinkingObserved: z.boolean(),
    /** Null when the model is not declared to see images. */
    visionVerified: z.boolean().nullable()
  }).nullable().default(null)
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
/** What a caller may send: fields with defaults, such as prices, can be left out. */
export type ProviderPublicConfigInput = z.input<typeof providerPublicConfigSchema>
export type ProviderConfigFile = z.infer<typeof providerConfigFileSchema>
export type ProviderExecutionPolicy = z.infer<typeof providerExecutionPolicySchema>
/** A policy as it may be sent: fields with a default can be left out. */
export type ProviderExecutionPolicyInput = z.input<typeof providerExecutionPolicySchema>
export type ProviderSettingsSnapshot = z.infer<typeof providerSettingsSnapshotSchema>
export type ProviderCheck = z.infer<typeof providerCheckSchema>
export type TextHelperConfig = z.infer<typeof textHelperConfigSchema>
export type MainTextModelConfig = z.infer<typeof llmProviderConfigSchema>
export type ProviderConnectionTestInput = z.input<typeof providerConnectionTestInputSchema>
export type ProviderConnectionTestResult = z.infer<typeof providerConnectionTestResultSchema>

export function resolveLlmProtocolEndpoint(baseUrl: string, protocol: z.infer<typeof llmProtocolSchema>): string {
  if (baseUrl === '') return ''
  const direct = new URL(baseUrl)
  const normalizedPath = direct.pathname.replace(/\/+$/, '')
  // Anthropic-style addresses are given without the version segment, e.g. https://api.anthropic.com or …/anthropic.
  const target = protocol === 'openai-chat-completions'
    ? 'chat/completions'
    : protocol === 'anthropic-messages'
      ? /\/v\d+$/.test(normalizedPath) ? 'messages' : 'v1/messages'
      : 'responses'
  if (normalizedPath.endsWith(protocol === 'anthropic-messages' ? '/messages' : `/${target}`)) return direct.toString()
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  return new URL(target, base).toString()
}

export function resolveLlmEndpoint(config: { readonly baseUrl: string; readonly protocol: z.infer<typeof llmProtocolSchema> }): string {
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
  version: 8,
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
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      transport: { mode: 'auto', ...DEFAULT_LLM_TRANSPORT_TIMEOUTS },
      concurrency: 1,
      capabilities: { streaming: true, toolCalling: true, vision: true },
      pricing: null
    },
    {
      id: 'image-provider',
      kind: 'image',
      label: '火山方舟 · Seedream 5.0',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'doubao-seedream-5-0-260128',
      protocol: 'ark-seedream',
      timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
      concurrency: 1,
      capabilities: {
        textToImage: true,
        imageReferences: true,
        maskEditing: true,
        multipleReferences: true,
        transparentOutput: false
      },
      pricePerImageCny: null
    }
  ],
  defaultImageProviderId: PRIMARY_IMAGE_PROVIDER_ID,
  executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY,
  textHelpers: { vision: null, backup: null },
  checks: {}
}

export type ImageProviderConfig = z.infer<typeof imageProviderConfigSchema>

export function imageProviderConfigs(config: { readonly providers: readonly ProviderPublicConfig[] }): ImageProviderConfig[] {
  return config.providers.filter((provider): provider is ImageProviderConfig => provider.kind === 'image')
}

/** The default image service; falls back to the primary one, which always exists. */
export function defaultImageProviderConfig(config: Pick<ProviderConfigFile, 'providers' | 'defaultImageProviderId'>): ImageProviderConfig {
  const images = imageProviderConfigs(config)
  return images.find((image) => image.id === config.defaultImageProviderId) ?? images[0]!
}

/** A new, empty image service; nothing is sent until a protocol, address and model are filled in. */
export function newImageProviderConfig(id: string): ImageProviderConfig {
  return imageProviderConfigSchema.parse({
    id,
    kind: 'image',
    label: '新的生图服务',
    baseUrl: '',
    defaultModel: '',
    protocol: 'unconfigured',
    timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
    concurrency: 1,
    capabilities: { textToImage: true, imageReferences: false, maskEditing: false, multipleReferences: false, transparentOutput: false }
  })
}

const TEXT_HELPER_LABELS: Record<TextHelperRole, string> = { vision: '看图模型', backup: '备用模型' }

/** An empty helper text model; it sends nothing until it has an address, a model and a key. */
export function newTextHelperConfig(role: TextHelperRole): TextHelperConfig {
  const main = DEFAULT_PROVIDER_CONFIG.providers[0]
  return textHelperConfigSchema.parse({
    ...main,
    id: TEXT_HELPER_IDS[role],
    label: TEXT_HELPER_LABELS[role],
    baseUrl: '',
    defaultModel: '',
    protocol: 'openai-chat-completions',
    capabilities: { streaming: true, toolCalling: role === 'backup', vision: role === 'vision' },
    pricing: null
  })
}

export function textHelperRoleOf(id: string): TextHelperRole | null {
  return id === TEXT_HELPER_IDS.vision ? 'vision' : id === TEXT_HELPER_IDS.backup ? 'backup' : null
}

/** A helper text model that can be called: an address, a model and a key. */
export function textHelperReady(helper: TextHelperConfig | null, hasKey: boolean): helper is TextHelperConfig {
  return helper !== null && helper.baseUrl !== '' && helper.defaultModel !== '' && hasKey
}
