import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  configurableProviderIdSchema,
  imageProviderConfigs,
  MAIN_TEXT_MODEL_ID,
  resolveImageEndpoint,
  textHelperRoleOf,
  type ImageProviderConfig,
  type ProviderCheck,
  providerConnectionTestInputSchema,
  providerConnectionTestResultSchema,
  resolveLlmEndpoint,
  type ProviderConfigFile,
  type ProviderConnectionTestInput,
  type MainTextModelConfig,
  type ProviderConnectionTestResult,
  type TextHelperConfig
} from '../../shared/provider-settings'

type TextModelConfig = MainTextModelConfig | TextHelperConfig
import { createConfiguredLlmProtocol, createConfiguredTurnProtocol } from '../agent/llm-protocol-factory'
import { turnText, turnToolCalls, type LlmAssistantTurn, type LlmTurnInput } from '../agent/llm/transcript'
import { ArkHttpClient, ArkHttpError } from './ark-http-client'
import type { ProviderUsageReservation } from './provider-usage-ledger'

const CONNECTION_COST_CEILING_CNY = 0.05

interface ProviderConnectionValidatorOptions {
  readonly config: { read(): Promise<ProviderConfigFile> }
  readonly secrets: { get(id: string): Promise<string | null> }
  readonly authorization: { reserve(input: ProviderUsageReservation): Promise<unknown> }
  readonly fetcher?: typeof fetch
}

const verificationArgumentsSchema = z.object({ ok: z.literal(true) }).strict()

const VERIFY_TOOL = {
  name: 'verifyAiCanvasConnection',
  description: '确认文字模型可以返回结构化工具调用。',
  parameters: {
    type: 'object',
    properties: { ok: { type: 'boolean', description: '必须设为 true。' } },
    required: ['ok'],
    additionalProperties: false
  }
}

/** A 16×16 solid red PNG for checking that images inside tool results are seen. */
const RED_SQUARE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN4oKBAEmIY1TCqYfhqAADc5yAQocSb7AAAAABJRU5ErkJggg=='

function showsThinking(turn: LlmAssistantTurn): boolean {
  if (turn.parts.some((part) => part.type === 'reasoning') || (turn.usage?.reasoningTokens ?? 0) > 0) return true
  const payload = turn.native.payload
  const entries: unknown[] = Array.isArray(payload) ? payload : [payload]
  return entries.some((entry) => typeof entry === 'object' && entry !== null && (
    ['reasoning', 'thinking', 'redacted_thinking'].includes(String((entry as Record<string, unknown>).type))
    || typeof (entry as Record<string, unknown>).reasoning_content === 'string'
  ))
}

function failurePresentation(error: unknown): {
  code: string
  title: string
  detail: string
  nextAction: string
  httpStatus: number | null
  contentType: string | null
} {
  const sourceCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof z.ZodError ? 'PROVIDER_PROTOCOL_MISMATCH' : 'PROVIDER_VALIDATION_FAILED'
  const detail = error instanceof Error
    ? error.message.slice(0, 1_000)
    : '连接验证未完成。'
  const code = sourceCode === 'PROVIDER_HTTP_ERROR' && /thinking mode does not support (?:this )?tool_choice/i.test(detail)
    ? 'PROVIDER_THINKING_TOOL_CHOICE_UNSUPPORTED'
    : sourceCode
  const httpStatus = error instanceof ArkHttpError ? error.status : null
  const contentType = error instanceof ArkHttpError ? error.contentType : null

  if (code === 'PROVIDER_KEY_MISSING') {
    return { code, title: '尚未保存凭据', detail, nextAction: '先保存 API Key，再重新验证。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_AUTH_FAILED') {
    return { code, title: '凭据未通过验证', detail, nextAction: '检查 API Key 是否有效，以及账号是否有权使用当前模型。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_RATE_LIMITED') {
    return { code, title: '供应商暂时限流', detail, nextAction: '稍后手动重试；AI Canvas 不会自动重复提交。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_NETWORK_ERROR') {
    return { code, title: '未能连接供应商', detail, nextAction: '检查网络、代理、Base URL 和超时时间后手动重试。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_UPSTREAM_ERROR') {
    return { code, title: '供应商上游异常', detail, nextAction: '先核对协议与地址；若配置无误，请稍后手动重试。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_RESPONSE_TRUNCATED') {
    return { code, title: '模型输出在工具参数完成前被截断', detail, nextAction: '降低思考强度或提高模型输出预算后，再手动验证。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_THINKING_TOOL_CHOICE_UNSUPPORTED') {
    return { code, title: '思考模式不接受强制工具选择', detail, nextAction: '连接验证将在思考模式下改用自动工具选择；不会自动重试本次请求。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_REPLAY_REJECTED') {
    return { code, title: '多步工具调用未通过', detail, nextAction: '第一步正常，但服务拒绝了交回的思考内容或工具结果。请换用该厂商推荐的协议后重试，或把这条结果发给开发者。', httpStatus, contentType }
  }
  if (code === 'PROVIDER_PROTOCOL_MISMATCH' || code === 'MODEL_TOOL_CALL_MISSING') {
    return { code, title: '协议或工具调用不匹配', detail, nextAction: '核对协议选项、Base URL 和模型的 Function Calling 能力。', httpStatus, contentType }
  }
  if (code.startsWith('PROVIDER_') && code.includes('BUDGET')) {
    return { code, title: '费用或请求上限阻止了验证', detail, nextAction: '在费用控制中提高单任务上限后，再手动验证。', httpStatus, contentType }
  }
  return { code, title: '连接验证未通过', detail, nextAction: '检查已保存配置后手动重试；不会自动重复提交。', httpStatus, contentType }
}

export class ProviderConnectionValidator {
  readonly #options: ProviderConnectionValidatorOptions

  constructor(options: ProviderConnectionValidatorOptions) {
    this.#options = options
  }

  async validate(inputValue: ProviderConnectionTestInput): Promise<ProviderConnectionTestResult> {
    const input = providerConnectionTestInputSchema.parse(inputValue)
    const llm = (await this.#options.config.read()).providers[0]
    if (input.scope === 'agent_loop') return this.#validateAgentLoop(llm, this.#base(llm))
    return this.#validateToolCalling(llm)
  }

  #base(llm: TextModelConfig): Omit<ProviderConnectionTestResult, 'ok' | 'requestsUsed' | 'toolCallingVerified' | 'failure' | 'agentLoop'> {
    return {
      providerId: llm.id,
      providerLabel: llm.label,
      protocol: llm.protocol,
      model: llm.defaultModel,
      endpoint: resolveLlmEndpoint(llm),
      checkedAt: new Date().toISOString(),
      generatedImages: 0 as const,
      costCeilingCny: CONNECTION_COST_CEILING_CNY
    }
  }

  /**
   * 测试 on a service's card: the main and backup models must call a tool,
   * the vision model must say what colour a small square is, and an image
   * service must accept its key on a request that cannot make a picture.
   */
  async check(idValue: string): Promise<ProviderCheck> {
    const id = configurableProviderIdSchema.parse(idValue)
    const config = await this.#options.config.read()
    const started = Date.now()
    const done = (ok: boolean, summary: string): ProviderCheck => ({
      ok,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      summary: summary.slice(0, 400)
    })
    const role = textHelperRoleOf(id)
    if (id === MAIN_TEXT_MODEL_ID || role === 'backup') {
      const llm = id === MAIN_TEXT_MODEL_ID ? config.providers[0] : config.textHelpers.backup
      if (llm === null) return done(false, '还没有设置备用模型。')
      const result = await this.#validateToolCalling(llm)
      return result.ok ? done(true, '连上了，能调用工具。') : done(false, `${result.failure.title}：${result.failure.detail} ${result.failure.nextAction}`)
    }
    if (role === 'vision') {
      const helper = config.textHelpers.vision
      if (helper === null) return done(false, '还没有设置看图模型。')
      const seen = await this.#validateVision(helper)
      return seen === null ? done(true, '连上了，能看图。') : done(false, seen)
    }
    const image = imageProviderConfigs(config).find((candidate) => candidate.id === id)
    if (image === undefined) return done(false, '这个生图服务已经不存在。')
    const problem = await this.#validateImageKey(image)
    return problem === null ? done(true, '地址和 Key 可用。测试没有生成图片，也不收费。') : done(false, problem)
  }

  /** Null when the model named the colour of a small red square; otherwise what went wrong. */
  async #validateVision(llm: TextHelperConfig): Promise<string | null> {
    try {
      if (llm.baseUrl === '' || llm.defaultModel === '') throw new ArkHttpError('PROVIDER_CONFIG_INCOMPLETE', '请先保存完整的地址、模型名和接口类型。')
      const protocol = createConfiguredTurnProtocol(llm)
      const request = protocol.buildTurnRequest({
        system: '你在帮 AI Canvas 验证看图能力。只用一个词回答图片的颜色。',
        messages: [{ role: 'user', parts: [
          { type: 'text', text: '这张图是什么颜色？' },
          { type: 'image', image: { mimeType: 'image/png', base64: RED_SQUARE_PNG } }
        ] }],
        tools: [],
        maxOutputTokens: Math.max(1_024, Math.min(4_096, llm.maxOutputTokens))
      }, false)
      const http = new ArkHttpClient({
        secrets: this.#options.secrets,
        authorization: this.#options.authorization,
        allowedBaseUrls: [llm.baseUrl],
        ...(this.#options.fetcher === undefined ? {} : { fetcher: this.#options.fetcher })
      })
      const turn = protocol.parseTurnResponse(await http.postLlmJson({
        ...request,
        secretId: llm.id,
        providerId: llm.id,
        providerLabel: llm.label,
        authorizationScopeId: `provider-connection:${randomUUID()}`,
        expectedImages: 0,
        costCeilingCny: CONNECTION_COST_CEILING_CNY,
        signal: new AbortController().signal,
        timeoutMs: llm.timeoutMs,
        connectTimeoutMs: llm.transport.connectTimeoutMs,
        firstEventTimeoutMs: llm.transport.firstEventTimeoutMs,
        idleTimeoutMs: llm.transport.idleTimeoutMs
      }))
      return /红|red/i.test(turnText(turn)) ? null : '连上了，但模型没有认出图片里的颜色，可能不能看图。换一个能看图的模型。'
    } catch (error) {
      const failure = failurePresentation(error)
      return `${failure.title}：${failure.detail} ${failure.nextAction}`
    }
  }

  /**
   * Null when the service takes the key. The request names the model and
   * nothing else: with no prompt there is nothing to draw, so the service
   * answers 400 once it has accepted the key, and 401 or 403 when it has not.
   */
  async #validateImageKey(image: ImageProviderConfig): Promise<string | null> {
    if (image.protocol === 'unconfigured' || image.baseUrl === '' || image.defaultModel === '') return '请先选接口类型，填好地址和模型名并保存。'
    const http = new ArkHttpClient({
      secrets: this.#options.secrets,
      authorization: this.#options.authorization,
      allowedBaseUrls: [image.baseUrl],
      ...(this.#options.fetcher === undefined ? {} : { fetcher: this.#options.fetcher })
    })
    try {
      await http.postJson({
        url: resolveImageEndpoint(image, 'generate'),
        body: { model: image.defaultModel },
        secretId: image.id,
        providerId: image.id,
        providerLabel: image.label,
        authorizationScopeId: `provider-connection:${randomUUID()}`,
        expectedImages: 0,
        costCeilingCny: 0,
        signal: new AbortController().signal,
        timeoutMs: Math.min(image.timeoutMs, 30_000)
      })
      return null
    } catch (error) {
      if (!(error instanceof ArkHttpError)) return '测试没有完成，请稍后再试。'
      const status = error.status
      if (status === 400 || status === 422) return null
      if (status === 401 || status === 403) return `Key 没有被接受（HTTP ${status}）。到厂商控制台确认 Key 是否有效、是否开通了这个模型。`
      if (status === 404) return '地址不对（HTTP 404）。核对接口地址和接口类型。'
      if (status === 429) return null
      if (status !== null && status >= 500) return `服务暂时出错（HTTP ${status}），稍后再试。`
      if (error.code === 'PROVIDER_KEY_MISSING') return '还没有保存 Key。'
      return error.message
    }
  }

  /** One small request that must come back as a structured tool call. */
  async #validateToolCalling(llm: TextModelConfig): Promise<ProviderConnectionTestResult> {
    const base = this.#base(llm)
    let requestReserved = false
    try {
      if (llm.baseUrl === '' || llm.defaultModel === '') {
        throw new ArkHttpError('PROVIDER_CONFIG_INCOMPLETE', '请先保存完整的 Base URL、模型 ID 和协议。')
      }
      const protocol = createConfiguredLlmProtocol(llm)
      const transportMode = llm.transport.mode === 'buffered'
        ? 'buffered'
        : llm.transport.mode === 'stream'
          ? 'stream'
          : llm.capabilities.streaming
            ? 'stream'
            : 'buffered'
      if (transportMode === 'stream' && !protocol.capabilities.streaming) {
        throw new ArkHttpError('PROVIDER_STREAM_UNSUPPORTED', '当前协议没有声明流式能力；验证请求尚未发送。')
      }
      const request = protocol.buildRequest({
        messages: [
          { role: 'system', content: '只调用 verifyAiCanvasConnection，并把 ok 设为 true。不要输出其他内容。' },
          { role: 'user', content: '验证 AI Canvas 的结构化工具调用连接。' }
        ],
        tools: [{
          name: 'verifyAiCanvasConnection',
          description: '确认文字模型可以返回结构化工具调用。',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean', description: '必须设为 true。' } },
            required: ['ok'],
            additionalProperties: false
          }
        }],
        toolChoice: llm.reasoningEffort === 'none' ? { name: 'verifyAiCanvasConnection' } : 'auto',
        maxOutputTokens: Math.max(2_048, Math.min(8_192, llm.maxOutputTokens))
      }, transportMode === 'stream')
      const http = new ArkHttpClient({
        secrets: this.#options.secrets,
        authorization: this.#options.authorization,
        allowedBaseUrls: [llm.baseUrl],
        ...(this.#options.fetcher === undefined ? {} : { fetcher: this.#options.fetcher })
      })
      const liveRequest = {
        ...request,
        secretId: llm.id,
        providerId: llm.id,
        providerLabel: llm.label,
        authorizationScopeId: `provider-connection:${randomUUID()}`,
        expectedImages: 0,
        costCeilingCny: CONNECTION_COST_CEILING_CNY,
        signal: new AbortController().signal,
        timeoutMs: llm.timeoutMs,
        connectTimeoutMs: llm.transport.connectTimeoutMs,
        firstEventTimeoutMs: llm.transport.firstEventTimeoutMs,
        idleTimeoutMs: llm.transport.idleTimeoutMs,
        observe: (event: { readonly phase: string }) => {
          if (event.phase === 'reserved') requestReserved = true
        }
      } as const
      const response = transportMode === 'stream'
        ? await http.postEventStream(liveRequest, protocol.createStreamAccumulator())
        : protocol.parseResponse(await http.postLlmJson(liveRequest))
      const calls = response.toolCalls.filter((call) => call.name === 'verifyAiCanvasConnection')
      if (calls.length !== 1 || !verificationArgumentsSchema.safeParse(calls[0]!.arguments).success) {
        throw new ArkHttpError(
          'MODEL_TOOL_CALL_MISSING',
          '模型返回了响应，但没有返回唯一且有效的验证工具调用。'
        )
      }
      return providerConnectionTestResultSchema.parse({
        ...base,
        ok: true,
        requestsUsed: 1,
        toolCallingVerified: true,
        failure: null
      })
    } catch (error) {
      return providerConnectionTestResultSchema.parse({
        ...base,
        ok: false,
        requestsUsed: requestReserved ? 1 : 0,
        toolCallingVerified: false,
        failure: failurePresentation(error)
      })
    }
  }

  /**
   * Two real steps, as the multi-step agent takes them: thinking on, a tool
   * call, then the step's own output and the tool result sent back (with a
   * small image when the model is declared to see images).
   */
  async #validateAgentLoop(
    llm: TextModelConfig,
    base: Omit<ProviderConnectionTestResult, 'ok' | 'requestsUsed' | 'toolCallingVerified' | 'failure' | 'agentLoop'>
  ): Promise<ProviderConnectionTestResult> {
    let requestsUsed = 0
    let step = 1
    try {
      if (llm.baseUrl === '' || llm.defaultModel === '') {
        throw new ArkHttpError('PROVIDER_CONFIG_INCOMPLETE', '请先保存完整的 Base URL、模型 ID 和协议。')
      }
      const protocol = createConfiguredTurnProtocol(llm)
      const stream = llm.transport.mode === 'stream' || llm.transport.mode === 'auto' && llm.capabilities.streaming
      if (stream && !protocol.capabilities.streaming) {
        throw new ArkHttpError('PROVIDER_STREAM_UNSUPPORTED', '当前协议没有声明流式能力；验证请求尚未发送。')
      }
      const http = new ArkHttpClient({
        secrets: this.#options.secrets,
        authorization: this.#options.authorization,
        allowedBaseUrls: [llm.baseUrl],
        ...(this.#options.fetcher === undefined ? {} : { fetcher: this.#options.fetcher })
      })
      const scopeId = randomUUID()
      const send = async (input: LlmTurnInput): Promise<LlmAssistantTurn> => {
        const request = protocol.buildTurnRequest(input, stream)
        const live = {
          ...request,
          secretId: llm.id,
          providerId: llm.id,
          providerLabel: llm.label,
          authorizationScopeId: `provider-connection:${scopeId}:${step}`,
          expectedImages: 0,
          costCeilingCny: CONNECTION_COST_CEILING_CNY,
          signal: new AbortController().signal,
          timeoutMs: llm.timeoutMs,
          connectTimeoutMs: llm.transport.connectTimeoutMs,
          firstEventTimeoutMs: llm.transport.firstEventTimeoutMs,
          idleTimeoutMs: llm.transport.idleTimeoutMs,
          observe: (event: { readonly phase: string }) => {
            if (event.phase === 'reserved') requestsUsed += 1
          }
        } as const
        return stream
          ? http.postEventStream(live, protocol.createTurnStreamAccumulator())
          : protocol.parseTurnResponse(await http.postLlmJson(live))
      }
      const maxOutputTokens = Math.max(2_048, Math.min(8_192, llm.maxOutputTokens))
      const system = '你在帮 AI Canvas 验证连接。先调用 verifyAiCanvasConnection 并把 ok 设为 true；收到工具结果后，只按结果里的要求用一句话回复。'
      const user = { role: 'user' as const, parts: [{ type: 'text' as const, text: '开始验证多步工具调用。' }] }
      const first = await send({ system, messages: [user], tools: [VERIFY_TOOL], maxOutputTokens })
      const call = turnToolCalls(first).find((candidate) => candidate.name === VERIFY_TOOL.name)
      if (call === undefined || !verificationArgumentsSchema.safeParse(call.arguments).success) {
        throw new ArkHttpError('MODEL_TOOL_CALL_MISSING', '模型返回了响应，但没有返回唯一且有效的验证工具调用。')
      }
      const vision = llm.capabilities.vision
      step = 2
      let second: LlmAssistantTurn
      try {
        second = await send({
          system,
          messages: [
            user,
            { role: 'assistant', parts: [...first.parts], native: first.native },
            {
              role: 'tool',
              results: [{
                callId: call.callId,
                name: call.name,
                isError: false,
                content: [
                  { type: 'text', text: vision ? '验证成功。附带的图片是一个纯色方块，请用一个词说出它的颜色。' : '验证成功。请回复「完成」。' },
                  ...(vision ? [{ type: 'image' as const, image: { mimeType: 'image/png' as const, base64: RED_SQUARE_PNG } }] : [])
                ]
              }]
            }
          ],
          tools: [VERIFY_TOOL],
          maxOutputTokens
        })
      } catch (error) {
        if (error instanceof ArkHttpError && error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 429) {
          throw new ArkHttpError('PROVIDER_REPLAY_REJECTED', error.message, error.status, error.contentType)
        }
        throw error
      }
      return providerConnectionTestResultSchema.parse({
        ...base,
        ok: true,
        requestsUsed,
        toolCallingVerified: true,
        failure: null,
        agentLoop: {
          dialect: protocol.dialect.label,
          thinkingObserved: showsThinking(first) || showsThinking(second),
          visionVerified: vision ? /红|red/i.test(turnText(second)) : null
        }
      })
    } catch (error) {
      return providerConnectionTestResultSchema.parse({
        ...base,
        ok: false,
        requestsUsed,
        toolCallingVerified: false,
        failure: failurePresentation(error)
      })
    }
  }
}
