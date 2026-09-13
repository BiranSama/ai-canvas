import { z } from 'zod'
import {
  resolveLlmProtocolEndpoint,
  type LlmImageDetail,
  type LlmReasoningEffort
} from '../../shared/provider-settings'
import { parseModelToolArguments, ToolArgumentsParseError } from './tool-arguments'
import { createChatStreamAccumulator, type LlmStreamAccumulator } from './llm-stream'

const jsonObjectSchema = z.record(z.string(), z.unknown())

const llmBaseUrlSchema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
}, 'LLM base URL must be HTTP(S) and cannot contain credentials.')

const protocolToolSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2_048),
  parameters: jsonObjectSchema
})

const protocolMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000)
})

const protocolImageSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  base64: z.string().min(1).max(40 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+=*$/)
})

export const openAiCompatibleRequestSchema = z.object({
  messages: z.array(protocolMessageSchema).min(1).max(256),
  images: z.array(protocolImageSchema).max(8).optional(),
  tools: z.array(protocolToolSchema).max(64).default([]),
  toolChoice: z.union([
    z.enum(['auto', 'required']),
    z.object({ name: z.string().min(1).max(128) }).strict()
  ]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).max(131_072).optional()
})

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string()
  })
})

const completionResponseSchema = z.object({
  id: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      content: z.string().nullable().default(null),
      tool_calls: z.array(toolCallSchema).optional()
    })
  })).min(1)
})

const streamChunkSchema = z.object({
  id: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().min(0),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional()
      })).optional()
    })
  })).min(1)
})

export type OpenAiCompatibleRequest = z.infer<typeof openAiCompatibleRequestSchema>

export interface LlmProtocolRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface NormalizedToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface NormalizedLlmResponse {
  readonly id: string
  readonly text: string
  readonly toolCalls: readonly NormalizedToolCall[]
  readonly finishReason: string | null
}

export type NormalizedLlmStreamEvent =
  | { readonly type: 'text-delta'; readonly id: string; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly id: string; readonly index: number; readonly callId: string | null; readonly name: string | null; readonly argumentsDelta: string }
  | { readonly type: 'finish'; readonly id: string; readonly finishReason: string | null }

export interface LlmProtocolAdapter {
  readonly id: string
  readonly label: string
  readonly capabilities: { readonly streaming: boolean; readonly toolCalling: boolean; readonly vision: boolean }
  buildRequest(input: OpenAiCompatibleRequest, stream: boolean): LlmProtocolRequest
  parseResponse(value: unknown): NormalizedLlmResponse
  parseEventStream(value: string): readonly NormalizedLlmStreamEvent[]
  createStreamAccumulator(): LlmStreamAccumulator
}

export class LlmProtocolError extends Error {
  readonly code: string
  readonly schemaIssues: ToolArgumentsParseError['schemaIssues']

  constructor(code: string, message: string, schemaIssues: ToolArgumentsParseError['schemaIssues'] = []) {
    super(message)
    this.name = 'LlmProtocolError'
    this.code = code
    this.schemaIssues = schemaIssues
  }
}

function parseToolArguments(value: string): Readonly<Record<string, unknown>> {
  if (new TextEncoder().encode(value).byteLength > 4 * 1024 * 1024) {
    throw new LlmProtocolError('PROVIDER_RESPONSE_TOO_LARGE', '工具参数超过 4 MiB 安全上限；本次没有执行工具。')
  }
  try {
    return parseModelToolArguments(value)
  } catch (error) {
    if (error instanceof ToolArgumentsParseError && error.failure === 'incomplete') {
      throw new LlmProtocolError(
        'PROVIDER_RESPONSE_TRUNCATED',
        '模型返回的操作参数没有完整结束；本次没有修改画布。请降低单次操作复杂度，或提高模型输出预算后重试。',
        error.schemaIssues
      )
    }
    throw new LlmProtocolError(
      'MODEL_ARGUMENTS_INVALID',
      '模型返回的操作参数不是有效 JSON；本次没有修改画布。应用没有猜测或修补不确定的命令。',
      error instanceof ToolArgumentsParseError ? error.schemaIssues : []
    )
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  return resolveLlmProtocolEndpoint(baseUrl, 'openai-chat-completions')
}

function imageDataUri(image: z.infer<typeof protocolImageSchema>): string {
  return `data:${image.mimeType};base64,${image.base64}`
}

function lastUserMessageIndex(messages: OpenAiCompatibleRequest['messages']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function imageDetailField(imageDetail: LlmImageDetail): Readonly<Record<string, string>> {
  return imageDetail === 'auto' ? {} : { detail: imageDetail }
}

function chatMessages(
  input: OpenAiCompatibleRequest,
  vision: boolean,
  imageDetail: LlmImageDetail
): readonly Readonly<Record<string, unknown>>[] {
  const images = vision ? input.images ?? [] : []
  const lastUserIndex = lastUserMessageIndex(input.messages)
  return input.messages.map((message, index) => index === lastUserIndex && images.length > 0
    ? {
        ...message,
        content: [
          { type: 'text', text: message.content },
          ...images.map((image) => ({
            type: 'image_url',
            image_url: { url: imageDataUri(image), ...imageDetailField(imageDetail) }
          }))
        ]
      }
    : message)
}

function chatToolChoice(input: OpenAiCompatibleRequest): unknown {
  if (input.toolChoice === undefined) return 'auto'
  if (typeof input.toolChoice === 'string') return input.toolChoice
  return { type: 'function', function: { name: input.toolChoice.name } }
}

function chatReasoningFields(effort: LlmReasoningEffort): Readonly<Record<string, unknown>> {
  if (effort === 'auto') return {}
  return { reasoning_effort: effort }
}

export class OpenAiCompatibleLlmProtocol implements LlmProtocolAdapter {
  readonly id = 'openai-compatible-llm'
  readonly label = 'OpenAI-compatible LLM'
  readonly capabilities: { readonly streaming: boolean; readonly toolCalling: true; readonly vision: boolean }
  readonly #baseUrl: string
  readonly #model: string
  readonly #reasoningEffort: LlmReasoningEffort
  readonly #imageDetail: LlmImageDetail

  constructor(config: {
    readonly baseUrl: string
    readonly model: string
    readonly reasoningEffort?: LlmReasoningEffort
    readonly imageDetail?: LlmImageDetail
    readonly vision?: boolean
    readonly streaming?: boolean
  }) {
    this.#baseUrl = llmBaseUrlSchema.parse(config.baseUrl)
    this.#model = z.string().trim().min(1).max(160).parse(config.model)
    this.#reasoningEffort = config.reasoningEffort ?? 'auto'
    this.#imageDetail = config.imageDetail ?? 'auto'
    this.capabilities = { streaming: config.streaming ?? true, toolCalling: true, vision: config.vision ?? false }
    chatCompletionsUrl(config.baseUrl)
  }

  buildRequest(inputValue: OpenAiCompatibleRequest, stream: boolean): LlmProtocolRequest {
    const input = openAiCompatibleRequestSchema.parse(inputValue)
    return {
      url: chatCompletionsUrl(this.#baseUrl),
      body: {
        model: this.#model,
        messages: chatMessages(input, this.capabilities.vision, this.#imageDetail),
        stream,
        ...(input.tools.length === 0 ? {} : {
          tools: input.tools.map((item) => ({
            type: 'function',
            function: { name: item.name, description: item.description, parameters: item.parameters }
          })),
          tool_choice: chatToolChoice(input)
        }),
        ...chatReasoningFields(this.#reasoningEffort),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens })
      }
    }
  }

  parseResponse(value: unknown): NormalizedLlmResponse {
    const parsed = completionResponseSchema.parse(value)
    const choice = parsed.choices[0]!
    if (choice.finish_reason === 'content_filter') {
      throw new LlmProtocolError('MODEL_OUTPUT_FILTERED', '供应商因内容策略停止了本次响应；本次没有执行任何工具。')
    }
    const truncated = choice.finish_reason === 'length'
    if (truncated) {
      throw new LlmProtocolError(
        'PROVIDER_RESPONSE_TRUNCATED',
        '模型响应达到输出上限，工具参数可能不完整；请提高输出预算或降低思考强度。'
      )
    }
    return {
      id: parsed.id,
      text: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments)
      })),
      finishReason: choice.finish_reason
    }
  }

  parseEventStream(value: string): readonly NormalizedLlmStreamEvent[] {
    const events: NormalizedLlmStreamEvent[] = []
    for (const line of value.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      const parsed = streamChunkSchema.parse(JSON.parse(data))
      const choice = parsed.choices[0]!
      if (choice.delta.content !== undefined && choice.delta.content !== null && choice.delta.content !== '') {
        events.push({ type: 'text-delta', id: parsed.id, text: choice.delta.content })
      }
      for (const call of choice.delta.tool_calls ?? []) {
        events.push({
          type: 'tool-call-delta',
          id: parsed.id,
          index: call.index,
          callId: call.id ?? null,
          name: call.function?.name ?? null,
          argumentsDelta: call.function?.arguments ?? ''
        })
      }
      if (choice.finish_reason !== undefined) {
        events.push({ type: 'finish', id: parsed.id, finishReason: choice.finish_reason ?? null })
      }
    }
    return events
  }

  createStreamAccumulator(): LlmStreamAccumulator {
    return createChatStreamAccumulator((value) => this.parseResponse(value))
  }
}

export class LlmProviderRegistry {
  readonly #providers = new Map<string, LlmProtocolAdapter>()

  constructor(providers: readonly LlmProtocolAdapter[] = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: LlmProtocolAdapter): void {
    if (this.#providers.has(provider.id)) throw new Error(`LLM provider ${provider.id} is already registered.`)
    this.#providers.set(provider.id, provider)
  }

  get(providerId: string): LlmProtocolAdapter {
    const provider = this.#providers.get(providerId)
    if (provider === undefined) throw new Error(`LLM provider “${providerId}” is not available.`)
    return provider
  }

  list(): readonly LlmProtocolAdapter[] {
    return [...this.#providers.values()]
  }
}
