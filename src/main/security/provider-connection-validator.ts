import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  providerConnectionTestInputSchema,
  providerConnectionTestResultSchema,
  resolveLlmEndpoint,
  type ProviderConfigFile,
  type ProviderConnectionTestInput,
  type ProviderConnectionTestResult,
  type ProviderPublicConfig
} from '../../shared/provider-settings'
import { createConfiguredLlmProtocol } from '../agent/llm-protocol-factory'
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
    providerConnectionTestInputSchema.parse(inputValue)
    const config = await this.#options.config.read()
    const llm = config.providers.find((provider): provider is Extract<ProviderPublicConfig, { kind: 'llm' }> => provider.kind === 'llm')!
    const base = {
      providerId: 'openai-compatible-llm' as const,
      providerLabel: llm.label,
      protocol: llm.protocol,
      model: llm.defaultModel,
      endpoint: resolveLlmEndpoint(llm),
      checkedAt: new Date().toISOString(),
      generatedImages: 0 as const,
      costCeilingCny: CONNECTION_COST_CEILING_CNY
    }

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
        temperature: 0,
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
        secretId: 'openai-compatible-llm',
        providerId: 'openai-compatible-llm',
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
}
