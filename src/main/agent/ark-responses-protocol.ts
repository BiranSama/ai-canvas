import { z } from 'zod'
import {
  resolveLlmProtocolEndpoint,
  type LlmImageDetail,
  type LlmReasoningEffort
} from '../../shared/provider-settings'
import {
  LlmProtocolError,
  openAiCompatibleRequestSchema,
  type LlmProtocolAdapter,
  type LlmProtocolRequest,
  type NormalizedLlmResponse,
  type NormalizedLlmStreamEvent,
  type OpenAiCompatibleRequest
} from './llm-provider'
import { parseModelToolArguments, ToolArgumentsParseError } from './tool-arguments'
import { createResponsesStreamAccumulator, type LlmStreamAccumulator } from './llm-stream'

const responsesBaseUrlSchema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}, 'Responses API base URL must use HTTPS and cannot contain credentials.')

const arkFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
  status: z.string().optional(),
  id: z.string().optional()
})

const arkOutputTextSchema = z.object({
  type: z.literal('output_text'),
  text: z.string()
})

const arkMessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.union([
    arkOutputTextSchema,
    z.object({ type: z.string() }).passthrough()
  ])).default([])
})

const arkResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().nullable().default(null),
  incomplete_details: z.object({ reason: z.string().nullable().default(null) }).nullable().optional(),
  output: z.array(z.unknown()).default([])
})

const arkStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('response.output_text.delta'),
    response_id: z.string().optional(),
    item_id: z.string().optional(),
    delta: z.string()
  }),
  z.object({
    type: z.literal('response.output_item.added'),
    response_id: z.string().optional(),
    output_index: z.number().int().min(0),
    item: z.object({
      type: z.literal('function_call'),
      id: z.string().optional(),
      call_id: z.string().min(1),
      name: z.string().min(1),
      arguments: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('response.function_call_arguments.delta'),
    response_id: z.string().optional(),
    item_id: z.string().optional(),
    output_index: z.number().int().min(0),
    delta: z.string()
  }),
  z.object({
    type: z.literal('response.completed'),
    response: z.object({ id: z.string().min(1), status: z.string().nullable().default(null) })
  })
])

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

function responsesUrl(baseUrl: string): string {
  return resolveLlmProtocolEndpoint(baseUrl, 'openai-responses')
}

function lastUserMessageIndex(messages: OpenAiCompatibleRequest['messages']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function eventPayloads(value: string): readonly unknown[] {
  const payloads: unknown[] = []
  for (const frame of value.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (data === '' || data === '[DONE]') continue
    payloads.push(JSON.parse(data))
  }
  return payloads
}

/**
 * Responses-compatible protocol shared by Ark and other relays.
 *
 * This class only maps and validates protocol data. Authentication and network
 * I/O remain in the Main-process provider runtime behind the Owner policy and persistent budget gate.
 */
export class ResponsesLlmProtocol implements LlmProtocolAdapter {
  readonly id: string
  readonly label: string
  readonly capabilities: { readonly streaming: boolean; readonly toolCalling: true; readonly vision: boolean }
  readonly #baseUrl: string
  readonly #model: string
  readonly #reasoningEffort: LlmReasoningEffort
  readonly #imageDetail: LlmImageDetail

  constructor(config: {
    readonly baseUrl: string
    readonly model: string
    readonly id?: string
    readonly label?: string
    readonly reasoningEffort?: LlmReasoningEffort
    readonly imageDetail?: LlmImageDetail
    readonly vision?: boolean
    readonly streaming?: boolean
  }) {
    this.id = config.id ?? 'openai-responses-llm'
    this.label = config.label ?? 'Responses 兼容协议'
    this.#baseUrl = responsesBaseUrlSchema.parse(config.baseUrl)
    this.#model = z.string().trim().min(1).max(160).parse(config.model)
    this.#reasoningEffort = config.reasoningEffort ?? 'auto'
    this.#imageDetail = config.imageDetail ?? 'auto'
    this.capabilities = { streaming: config.streaming ?? true, toolCalling: true, vision: config.vision ?? false }
    responsesUrl(this.#baseUrl)
  }

  buildRequest(inputValue: OpenAiCompatibleRequest, stream: boolean): LlmProtocolRequest {
    const input = openAiCompatibleRequestSchema.parse(inputValue)
    const images = this.capabilities.vision ? input.images ?? [] : []
    const instructions = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const lastUserIndex = lastUserMessageIndex(input.messages)
    const messages = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const originalIndex = input.messages.indexOf(message)
        return {
          type: 'message',
          role: message.role,
          content: originalIndex === lastUserIndex && images.length > 0
            ? [
                { type: 'input_text', text: message.content },
                ...images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.base64}`,
                  ...(this.#imageDetail === 'auto' ? {} : { detail: this.#imageDetail })
                }))
              ]
            : message.content
        }
      })

    return {
      url: responsesUrl(this.#baseUrl),
      body: {
        model: this.#model,
        input: messages,
        stream,
        store: false,
        ...(instructions === '' ? {} : { instructions }),
        ...(input.tools.length === 0 ? {} : {
          tools: input.tools.map((item) => ({
            type: 'function',
            name: item.name,
            description: item.description,
            parameters: item.parameters
          })),
          tool_choice: input.toolChoice === undefined || input.toolChoice === 'auto'
            ? 'auto'
            : input.toolChoice === 'required'
              ? 'required'
              : { type: 'function', name: input.toolChoice.name }
        }),
        ...(this.#reasoningEffort === 'auto' ? {} : { reasoning: { effort: this.#reasoningEffort } }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens })
      }
    }
  }

  parseResponse(value: unknown): NormalizedLlmResponse {
    const parsed = arkResponseSchema.parse(value)
    if (parsed.status === 'failed') {
      throw new LlmProtocolError('PROVIDER_RESPONSE_FAILED', '供应商明确返回响应失败；本次没有执行任何工具。')
    }
    if (parsed.status === 'incomplete' && parsed.incomplete_details?.reason === 'content_filter') {
      throw new LlmProtocolError('MODEL_OUTPUT_FILTERED', '供应商因内容策略停止了本次响应；本次没有执行任何工具。')
    }
    if (parsed.status === 'incomplete') {
      throw new LlmProtocolError(
        'PROVIDER_RESPONSE_TRUNCATED',
        '模型响应达到输出上限，工具参数可能不完整；请提高输出预算或降低思考强度。'
      )
    }
    if (parsed.status !== null && parsed.status !== 'completed') {
      throw new LlmProtocolError('PROVIDER_STREAM_INCOMPLETE', '供应商响应尚未完成；本次没有执行工具。')
    }
    const text: string[] = []
    const toolCalls: NormalizedLlmResponse['toolCalls'][number][] = []
    for (const item of parsed.output) {
      const message = arkMessageSchema.safeParse(item)
      if (message.success) {
        for (const content of message.data.content) {
          const outputText = arkOutputTextSchema.safeParse(content)
          if (outputText.success) text.push(outputText.data.text)
        }
      }
      const functionCall = arkFunctionCallSchema.safeParse(item)
      if (functionCall.success) {
        if (functionCall.data.status === 'incomplete') {
          throw new LlmProtocolError(
            'PROVIDER_RESPONSE_TRUNCATED',
            '模型没有完整输出操作参数；本次没有修改画布。请降低单次操作复杂度，或提高模型输出预算后重试。'
          )
        }
        toolCalls.push({
          id: functionCall.data.call_id,
          name: functionCall.data.name,
          arguments: parseToolArguments(functionCall.data.arguments)
        })
      }
    }
    return {
      id: parsed.id,
      text: text.join(''),
      toolCalls,
      finishReason: parsed.status
    }
  }

  parseEventStream(value: string): readonly NormalizedLlmStreamEvent[] {
    const events: NormalizedLlmStreamEvent[] = []
    for (const payload of eventPayloads(value)) {
      const parsed = arkStreamEventSchema.safeParse(payload)
      if (!parsed.success) continue
      const event = parsed.data
      if (event.type === 'response.output_text.delta') {
        events.push({
          type: 'text-delta',
          id: event.response_id ?? event.item_id ?? 'ark-response',
          text: event.delta
        })
      } else if (event.type === 'response.output_item.added') {
        events.push({
          type: 'tool-call-delta',
          id: event.response_id ?? event.item.id ?? event.item.call_id,
          index: event.output_index,
          callId: event.item.call_id,
          name: event.item.name,
          argumentsDelta: event.item.arguments ?? ''
        })
      } else if (event.type === 'response.function_call_arguments.delta') {
        events.push({
          type: 'tool-call-delta',
          id: event.response_id ?? event.item_id ?? 'ark-response',
          index: event.output_index,
          callId: null,
          name: null,
          argumentsDelta: event.delta
        })
      } else {
        events.push({
          type: 'finish',
          id: event.response.id,
          finishReason: event.response.status
        })
      }
    }
    return events
  }

  createStreamAccumulator(): LlmStreamAccumulator {
    return createResponsesStreamAccumulator((value) => this.parseResponse(value))
  }
}

/** Explicit Ark preset retained for existing imports and Ark-specific UI copy. */
export class ArkResponsesLlmProtocol extends ResponsesLlmProtocol {
  constructor(config: {
    readonly baseUrl: string
    readonly model: string
    readonly reasoningEffort?: LlmReasoningEffort
    readonly imageDetail?: LlmImageDetail
    readonly vision?: boolean
    readonly streaming?: boolean
  }) {
    super({
      ...config,
      id: 'ark-responses-llm',
      label: '火山方舟 Responses API'
    })
  }
}
