import type { LlmReasoningEffort } from '../../../shared/provider-settings'

export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const EFFORT_ORDER: readonly ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface ChatDialect {
  /** How thinking is switched on; `model-default` models think without a switch. */
  readonly thinking: 'thinking-type' | 'enable-thinking' | 'model-default'
  /** Carries the effort when the owner picked one. */
  readonly effortField: 'reasoning_effort' | null
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** Asks for a final usage chunk while streaming. */
  readonly streamUsage: boolean
}

export interface ResponsesDialect {
  readonly thinking: 'reasoning' | 'ark-thinking'
  /** Requests encrypted reasoning so it can be replayed without server-side storage. */
  readonly includeEncryptedReasoning: boolean
  /** Requests a readable reasoning summary for display. */
  readonly reasoningSummary: boolean
  /**
   * Which reasoning items go back on later steps. With `encrypted-only`, items
   * without encrypted content are dropped, since nothing is stored server side.
   */
  readonly replayReasoning: 'all' | 'encrypted-only'
  readonly toolResultImages: 'inline' | 'user-message'
}

export interface AnthropicDialect {
  readonly thinking: 'adaptive' | 'budget'
  readonly promptCaching: boolean
  readonly toolResultImages: 'inline' | 'user-message'
}

/**
 * What one vendor needs to think, call tools and get its own output back. This
 * is data: the protocol adapters read it and contain no vendor branches.
 */
export interface LlmDialect {
  readonly id: string
  readonly label: string
  /** Effort levels the vendor accepts, lightest first. */
  readonly efforts: readonly ThinkingEffort[]
  readonly chat: ChatDialect
  readonly responses: ResponsesDialect
  readonly anthropic: AnthropicDialect
  /** Earlier steps must be sent back unchanged, so old screenshots cannot be dropped. */
  readonly appendOnlyHistory: boolean
  /** Takes a `prompt_cache_key` that routes requests sharing a prefix to the same cache. */
  readonly promptCacheKey: boolean
}

const GENERIC_CHAT: ChatDialect = {
  thinking: 'model-default',
  effortField: 'reasoning_effort',
  maxTokensField: 'max_tokens',
  streamUsage: false
}

const GENERIC_RESPONSES: ResponsesDialect = {
  thinking: 'reasoning',
  includeEncryptedReasoning: false,
  reasoningSummary: false,
  replayReasoning: 'encrypted-only',
  toolResultImages: 'user-message'
}

const COMPATIBLE_ANTHROPIC: AnthropicDialect = {
  thinking: 'budget',
  promptCaching: false,
  toolResultImages: 'user-message'
}

export const GENERIC_DIALECT: LlmDialect = {
  id: 'generic',
  label: '通用兼容',
  efforts: ['low', 'medium', 'high'],
  chat: GENERIC_CHAT,
  responses: GENERIC_RESPONSES,
  anthropic: COMPATIBLE_ANTHROPIC,
  appendOnlyHistory: false,

  promptCacheKey: false
}

export const LLM_DIALECTS: readonly LlmDialect[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    chat: { ...GENERIC_CHAT, maxTokensField: 'max_completion_tokens', streamUsage: true },
    responses: {
      thinking: 'reasoning',
      includeEncryptedReasoning: true,
      reasoningSummary: true,
      replayReasoning: 'encrypted-only',
      toolResultImages: 'inline'
    },
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: true
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    efforts: ['low', 'medium', 'high', 'max'],
    chat: { ...GENERIC_CHAT, effortField: null },
    responses: GENERIC_RESPONSES,
    anthropic: { thinking: 'adaptive', promptCaching: true, toolResultImages: 'inline' },
    appendOnlyHistory: true,

    promptCacheKey: false
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    efforts: ['low', 'medium', 'high'],
    chat: { thinking: 'thinking-type', effortField: 'reasoning_effort', maxTokensField: 'max_tokens', streamUsage: true },
    responses: { ...GENERIC_RESPONSES, replayReasoning: 'all', toolResultImages: 'inline' },
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'ark',
    label: '火山方舟',
    efforts: ['low', 'medium', 'high'],
    chat: { thinking: 'thinking-type', effortField: 'reasoning_effort', maxTokensField: 'max_tokens', streamUsage: true },
    responses: {
      thinking: 'ark-thinking',
      includeEncryptedReasoning: false,
      reasoningSummary: false,
      replayReasoning: 'all',
      toolResultImages: 'user-message'
    },
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'xai',
    label: 'xAI',
    efforts: ['low', 'high'],
    chat: { ...GENERIC_CHAT, streamUsage: true },
    responses: {
      thinking: 'reasoning',
      includeEncryptedReasoning: true,
      reasoningSummary: false,
      replayReasoning: 'encrypted-only',
      toolResultImages: 'user-message'
    },
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    efforts: ['low', 'medium', 'high'],
    chat: { ...GENERIC_CHAT, streamUsage: true },
    responses: GENERIC_RESPONSES,
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'qwen',
    label: '通义千问',
    efforts: [],
    chat: { thinking: 'enable-thinking', effortField: null, maxTokensField: 'max_tokens', streamUsage: true },
    responses: GENERIC_RESPONSES,
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'kimi',
    label: 'Kimi',
    efforts: [],
    chat: { thinking: 'model-default', effortField: null, maxTokensField: 'max_tokens', streamUsage: true },
    responses: GENERIC_RESPONSES,
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    efforts: [],
    chat: { thinking: 'thinking-type', effortField: null, maxTokensField: 'max_tokens', streamUsage: true },
    responses: GENERIC_RESPONSES,
    anthropic: COMPATIBLE_ANTHROPIC,
    appendOnlyHistory: false,

    promptCacheKey: false
  }
]

const HOST_RULES: readonly (readonly [RegExp, string])[] = [
  [/^api\.openai\.com$/, 'openai'],
  [/^api\.anthropic\.com$/, 'anthropic'],
  [/^api\.deepseek\.com$/, 'deepseek'],
  [/(?:^|\.)(?:volces|bytepluses)\.com$/, 'ark'],
  [/^api\.x\.ai$/, 'xai'],
  [/^generativelanguage\.googleapis\.com$/, 'gemini'],
  [/(?:^|\.)dashscope(?:-intl)?\.aliyuncs\.com$/, 'qwen'],
  [/^api\.moonshot\.(?:cn|ai)$/, 'kimi'],
  [/^(?:open\.bigmodel\.cn|api\.z\.ai)$/, 'glm']
]

const MODEL_RULES: readonly (readonly [RegExp, string])[] = [
  [/^(?:gpt-|chatgpt-|o\d)/i, 'openai'],
  [/^claude-/i, 'anthropic'],
  [/^deepseek-/i, 'deepseek'],
  [/^(?:doubao-|seed-)/i, 'ark'],
  [/^grok-/i, 'xai'],
  [/^gemini-/i, 'gemini'],
  [/^(?:qwen|qwq-)/i, 'qwen'],
  [/^(?:kimi-|moonshot-)/i, 'kimi'],
  [/^glm-/i, 'glm']
]

export interface ResolvedLlmDialect {
  readonly dialect: LlmDialect
  /** How the dialect was chosen; a relay matched only by model name may not pass vendor fields through. */
  readonly matchedBy: 'host' | 'model' | 'default'
}

function dialectById(id: string): LlmDialect {
  return LLM_DIALECTS.find((dialect) => dialect.id === id) ?? GENERIC_DIALECT
}

/** Picks the vendor dialect from the saved address first, then from the model name. */
export function resolveLlmDialect(input: { readonly baseUrl: string; readonly model: string }): ResolvedLlmDialect {
  let host = ''
  try {
    host = new URL(input.baseUrl).hostname.toLowerCase()
  } catch {
    host = ''
  }
  const byHost = HOST_RULES.find(([pattern]) => pattern.test(host))
  if (byHost !== undefined) return { dialect: dialectById(byHost[1]), matchedBy: 'host' }
  const byModel = MODEL_RULES.find(([pattern]) => pattern.test(input.model.trim()))
  if (byModel !== undefined) return { dialect: dialectById(byModel[1]), matchedBy: 'model' }
  return { dialect: GENERIC_DIALECT, matchedBy: 'default' }
}

/**
 * Maps the owner's setting to an effort the vendor accepts. Thinking stays on:
 * `none` asks for the lightest level offered. `auto` sends no effort at all and
 * leaves the vendor's default in place.
 */
export function resolveThinkingEffort(setting: LlmReasoningEffort, supported: readonly ThinkingEffort[]): ThinkingEffort | null {
  if (setting === 'auto' || supported.length === 0) return null
  const wanted = EFFORT_ORDER.indexOf(setting === 'none' ? 'minimal' : setting)
  const atOrBelow = supported.filter((effort) => EFFORT_ORDER.indexOf(effort) <= wanted)
  return atOrBelow.at(-1) ?? supported[0] ?? null
}

/**
 * Claude models before 4.6 take a fixed thinking budget; later ones decide for
 * themselves (adaptive thinking).
 */
export function claudeUsesThinkingBudget(model: string): boolean {
  const legacy = /^claude-(\d+)(?:-(\d))?-(?:opus|sonnet|haiku)/i.exec(model)
  if (legacy !== null) return true
  const current = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/i.exec(model)
  if (current === null) return false
  const major = Number(current[1])
  const minor = current[2] === undefined ? 0 : Number(current[2])
  return major < 4 || major === 4 && minor <= 5
}
