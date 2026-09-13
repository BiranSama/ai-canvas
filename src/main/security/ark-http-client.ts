import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { G2UsageLedger } from './g2-usage-ledger'
import type { ProviderUsageReservation } from './provider-usage-ledger'
import {
  MAX_LLM_RESPONSE_BYTES,
  SseDecoder,
  type LlmStreamAccumulator,
  type LlmStreamObservation
} from '../agent/llm-stream'

const MAX_JSON_BYTES = 100 * 1024 * 1024
const MAX_REQUEST_JSON_BYTES = 100 * 1024 * 1024
const DEFAULT_APPROVED_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

interface SecretSource {
  get(id: string): Promise<string | null>
  startRequest?(id: string, send: (secret: string) => Promise<Response>): Promise<Response>
}

export interface ArkJsonRequest {
  readonly url: string
  readonly body: Readonly<Record<string, unknown>>
  readonly secretId: 'openai-compatible-llm' | 'image-provider'
  readonly expectedImages: number
  /** Conservative pre-request charge ceiling used by the persistent Provider ledger. */
  readonly costCeilingCny: number
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly authorizationScopeId?: string
  readonly providerId?: string
  readonly providerLabel?: string
}

export type ArkLlmTransportPhase = 'reserved' | 'connecting' | 'headers' | 'first_event' | 'receiving' | 'completed' | 'failed' | 'cancelled'

export interface ArkLlmTransportObservation {
  /** Internal delivery hint; never part of the public Provider event payload. */
  readonly checkpoint?: boolean
  readonly phase: ArkLlmTransportPhase
  readonly elapsedMs: number
  readonly lastTransportActivityAt: string | null
  readonly lastSemanticProgressAt: string | null
  readonly receivedBytes: number
  readonly recognizedEventCount: number
  readonly providerResponseId: string | null
  readonly httpStatus: number | null
  readonly failureCode: string | null
}

export interface ArkLlmRequest extends ArkJsonRequest {
  readonly connectTimeoutMs: number
  readonly firstEventTimeoutMs: number
  readonly idleTimeoutMs: number
  readonly totalTimeoutCode?: 'PROVIDER_TOTAL_TIMEOUT' | 'BUDGET_WALL_TIME'
  readonly observe?: (observation: ArkLlmTransportObservation) => void | Promise<void>
}

export interface ProviderMultipartFile {
  readonly field: string
  readonly name: string
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly bytes: Buffer
}

export interface ProviderMultipartRequest extends Omit<ArkJsonRequest, 'body'> {
  readonly fields: Readonly<Record<string, string>>
  readonly files: readonly ProviderMultipartFile[]
}

export class ArkHttpError extends Error {
  readonly code: string
  readonly status: number | null
  readonly contentType: string | null

  constructor(
    code: string,
    message: string,
    status: number | null = null,
    contentType: string | null = null
  ) {
    super(message)
    this.name = 'ArkHttpError'
    this.code = code
    this.status = status
    this.contentType = contentType
  }
}

function normalizedApprovedBase(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ArkHttpError('PROVIDER_DESTINATION_DENIED', '供应商地址必须使用 HTTPS，且不能包含凭据、查询参数或片段。')
  }
  return url
}

function approvedUrl(value: string, approvedBases: readonly URL[]): URL {
  const url = new URL(value)
  const allowed = approvedBases.some((base) => {
    if (url.origin !== base.origin) return false
    const approvedPath = base.pathname === '/' ? '/' : base.pathname.replace(/\/+$/, '')
    return approvedPath === '/'
      ? url.pathname.startsWith('/')
      : url.pathname === approvedPath || url.pathname.startsWith(`${approvedPath}/`)
  })
  if (!allowed) {
    throw new ArkHttpError('PROVIDER_DESTINATION_DENIED', '请求目标不在已保存的供应商地址范围内。')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ArkHttpError('PROVIDER_DESTINATION_DENIED', '请求地址不能包含凭据、查询参数或片段。')
  }
  return url
}

async function readBoundedText(response: Response, providerLabel: string): Promise<string> {
  if (response.body === null) {
    throw new ArkHttpError(
      'PROVIDER_EMPTY_RESPONSE',
      `${providerLabel} 返回了空响应。`,
      response.status,
      response.headers.get('content-type')
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_JSON_BYTES) {
      await reader.cancel()
      throw new ArkHttpError(
        'PROVIDER_RESPONSE_TOO_LARGE',
        `${providerLabel} 的响应超过了本地安全上限。`,
        response.status,
        response.headers.get('content-type')
      )
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
}

function parseJson(text: string): unknown | null {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function safeErrorMessage(value: unknown, status: number, providerLabel: string): string {
  if (providerHttpCodeForStatus(status, value) === 'PROVIDER_CONTENT_FILTERED') {
    return '图片服务的内容审核未通过，本次没有返回图片。请检查创作内容和参考图；应用不会自动重复提交。'
  }
  const parsed = z.object({
    error: z.object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().max(2_000).optional()
    }).optional()
  }).safeParse(value)
  if (!parsed.success) return `${providerLabel} 返回 HTTP ${status}。`
  const code = parsed.data.error?.code
  const message = parsed.data.error?.message
  return [code === undefined ? null : String(code), message].filter((part) => part !== null && part !== undefined && part !== '').join(': ')
    || `${providerLabel} 返回 HTTP ${status}。`
}

function redactKnownSecret(value: string, secret: string): string {
  return secret.length < 4 ? value : value.split(secret).join('[REDACTED]')
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function providerHttpCodeForStatus(status: number, value?: unknown): string {
  const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(value)
  if (error.success && ['OutputImageSensitiveContentDetected', 'InputImageSensitiveContentDetected', 'InputTextSensitiveContentDetected'].includes(error.data.error.code)) {
    return 'PROVIDER_CONTENT_FILTERED'
  }
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED'
  if (status === 408 || status === 504) return 'PROVIDER_TIMEOUT'
  if (status === 429) return 'PROVIDER_RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UPSTREAM_ERROR'
  return 'PROVIDER_HTTP_ERROR'
}

export class ArkHttpClient {
  readonly #secrets: SecretSource
  readonly #authorization: { reserve(input: ProviderUsageReservation): Promise<unknown> }
  readonly #approvedBases: readonly URL[]
  readonly #fetcher: typeof fetch

  constructor(options: {
    readonly secrets: SecretSource
    readonly ledger?: G2UsageLedger
    readonly authorization?: { reserve(input: ProviderUsageReservation): Promise<unknown> }
    readonly allowedBaseUrls?: readonly string[]
    readonly fetcher?: typeof fetch
  }) {
    this.#secrets = options.secrets
    if (options.authorization !== undefined) {
      this.#authorization = options.authorization
    } else if (options.ledger !== undefined) {
      this.#authorization = {
        reserve: (input) => options.ledger!.reserve({
          requests: 1,
          images: input.images,
          costCeilingCny: input.costCeilingCny
        })
      }
    } else {
      throw new Error('ArkHttpClient requires a provider request authorizer.')
    }
    this.#approvedBases = (options.allowedBaseUrls ?? [DEFAULT_APPROVED_BASE_URL]).map(normalizedApprovedBase)
    this.#fetcher = options.fetcher ?? fetch
  }

  async postJson(request: ArkJsonRequest): Promise<unknown> {
    const url = approvedUrl(request.url, this.#approvedBases)
    const providerLabel = request.providerLabel?.trim() || '供应商'
    if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求在发送前已取消。')
    const serializedBody = JSON.stringify(request.body)
    if (Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_JSON_BYTES) {
      throw new ArkHttpError('PROVIDER_REQUEST_TOO_LARGE', '请求内容超过了本地安全上限。')
    }
    const apiKey = await this.#secrets.get(request.secretId)
    if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求在发送前已取消。')
    if (apiKey === null) throw new ArkHttpError('PROVIDER_KEY_MISSING', `请先为${providerLabel}安全保存 API Key。`)
    await this.#authorization.reserve({
      scopeId: request.authorizationScopeId ?? `${request.secretId}:${randomUUID()}`,
      providerId: request.providerId ?? request.secretId,
      requests: 1,
      images: request.expectedImages,
      costCeilingCny: request.costCeilingCny
    })
    const timeoutSignal = AbortSignal.timeout(Math.max(1_000, Math.min(300_000, request.timeoutMs)))
    const signal = AbortSignal.any([request.signal, timeoutSignal])
    let response: Response
    try {
      const send = (key: string) => this.#fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`
        },
        body: serializedBody,
        redirect: 'error',
        credentials: 'omit',
        signal
      })
      response = await (this.#secrets.startRequest?.(request.secretId, send) ?? send(apiKey))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'REQUEST_IDENTITY_UNAVAILABLE') throw error
      if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '供应商请求已取消。')
      if (timeoutSignal.aborted) {
        throw new ArkHttpError('PROVIDER_TIMEOUT', `${providerLabel}在 ${request.timeoutMs} 毫秒内没有响应。`)
      }
      throw new ArkHttpError(
        'PROVIDER_NETWORK_ERROR',
        `无法连接到${providerLabel}。请检查网络、供应商地址和代理设置。${error instanceof Error && error.message !== '' ? `（${error.message.slice(0, 240)}）` : ''}`
      )
    }
    const contentType = response.headers.get('content-type')
    let text: string
    try {
      text = await readBoundedText(response, providerLabel)
    } catch (error) {
      if (error instanceof ArkHttpError) throw error
      if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '读取供应商响应时请求已取消。')
      if (timeoutSignal.aborted) {
        throw new ArkHttpError('PROVIDER_TIMEOUT', `${providerLabel}在 ${request.timeoutMs} 毫秒内没有完成响应。`)
      }
      throw new ArkHttpError('PROVIDER_NETWORK_ERROR', `读取${providerLabel}响应时网络连接中断。`)
    }
    const value = parseJson(text)
    if (!response.ok) {
      const detail = value === null
        ? `${providerLabel} 返回 HTTP ${response.status}，但响应类型是 ${contentType ?? '未知格式'}，不是可解析的 JSON。请核对 Base URL 与协议。`
        : safeErrorMessage(value, response.status, providerLabel)
      throw new ArkHttpError(
        providerHttpCodeForStatus(response.status, value),
        redactKnownSecret(detail, apiKey),
        response.status,
        contentType
      )
    }
    if (value === null) {
      throw new ArkHttpError(
        text.trim() === '' ? 'PROVIDER_EMPTY_RESPONSE' : 'PROVIDER_PROTOCOL_MISMATCH',
        text.trim() === ''
          ? `${providerLabel} 返回了空响应。`
          : `${providerLabel} 返回了 ${contentType ?? '未知格式'}，但当前协议要求 JSON。请核对 Base URL 与协议。`,
        response.status,
        contentType
      )
    }
    return value
  }

  /** LLM-only buffered transport with connect/first-byte/idle/total deadlines. */
  async postLlmJson(request: ArkLlmRequest): Promise<unknown> {
    return this.#postLlm(request, null)
  }

  /** LLM-only SSE transport. Image Provider POST behavior intentionally remains separate. */
  async postEventStream(request: ArkLlmRequest, accumulator: LlmStreamAccumulator): Promise<ReturnType<LlmStreamAccumulator['finalize']>> {
    return this.#postLlm(request, accumulator) as Promise<ReturnType<LlmStreamAccumulator['finalize']>>
  }

  async #postLlm(request: ArkLlmRequest, accumulator: LlmStreamAccumulator | null): Promise<unknown> {
    const startedAt = Date.now()
    const url = approvedUrl(request.url, this.#approvedBases)
    const providerLabel = request.providerLabel?.trim() || '供应商'
    if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求在发送前已取消。')
    const serializedBody = JSON.stringify(request.body)
    if (Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_JSON_BYTES) {
      throw new ArkHttpError('PROVIDER_REQUEST_TOO_LARGE', '请求内容超过了本地安全上限。')
    }
    const apiKey = await this.#secrets.get(request.secretId)
    if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求在发送前已取消。')
    if (apiKey === null) throw new ArkHttpError('PROVIDER_KEY_MISSING', `请先为${providerLabel}安全保存 API Key。`)

    let receivedBytes = 0
    let recognizedEventCount = 0
    let lastTransportActivityAt: string | null = null
    let lastSemanticProgressAt: string | null = null
    let providerResponseId: string | null = null
    let httpStatus: number | null = null
    let terminalFailureCode: string | null = null
    let observationQueue = Promise.resolve()
    const observe = (phase: ArkLlmTransportPhase, checkpoint = true): Promise<void> => {
      const observation: ArkLlmTransportObservation = {
        checkpoint,
        phase,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        lastTransportActivityAt,
        lastSemanticProgressAt,
        receivedBytes,
        recognizedEventCount,
        providerResponseId,
        httpStatus,
        failureCode: terminalFailureCode
      }
      observationQueue = observationQueue.then(async () => { await request.observe?.(observation) }).catch(() => undefined)
      return observationQueue
    }

    await this.#authorization.reserve({
      scopeId: request.authorizationScopeId ?? `${request.secretId}:${randomUUID()}`,
      providerId: request.providerId ?? request.secretId,
      requests: 1,
      images: request.expectedImages,
      costCeilingCny: request.costCeilingCny
    })
    await observe('reserved')
    if (request.signal.aborted) {
      terminalFailureCode = 'PROVIDER_CANCELLED'
      await observe('cancelled')
      throw new ArkHttpError('PROVIDER_CANCELLED', '供应商请求已取消。')
    }

    const transportController = new AbortController()
    let timeoutCode: string | null = null
    let phaseTimer: ReturnType<typeof setTimeout> | null = null
    let receivingTimer: ReturnType<typeof setTimeout> | null = null
    const totalTimer = setTimeout(() => {
      timeoutCode = request.totalTimeoutCode ?? 'PROVIDER_TOTAL_TIMEOUT'
      transportController.abort(timeoutCode)
    }, Math.max(1, Math.min(300_000, request.timeoutMs) - (Date.now() - startedAt)))
    const callerDeadlineExpired = (): boolean => typeof request.signal.reason === 'object'
      && request.signal.reason !== null && request.signal.reason.code === 'BUDGET_WALL_TIME'
    const onCallerAbort = (): void => {
      if (callerDeadlineExpired()) timeoutCode = 'BUDGET_WALL_TIME'
      transportController.abort(callerDeadlineExpired() ? 'BUDGET_WALL_TIME' : 'PROVIDER_CANCELLED')
    }
    request.signal.addEventListener('abort', onCallerAbort, { once: true })
    const setPhaseTimer = (code: string, durationMs: number): void => {
      if (phaseTimer !== null) clearTimeout(phaseTimer)
      phaseTimer = setTimeout(() => {
        timeoutCode = code
        transportController.abort(code)
      }, Math.max(1, durationMs))
    }
    const clearTimers = (): void => {
      clearTimeout(totalTimer)
      if (phaseTimer !== null) clearTimeout(phaseTimer)
      if (receivingTimer !== null) clearTimeout(receivingTimer)
      receivingTimer = null
      request.signal.removeEventListener('abort', onCallerAbort)
    }
    const throwTransportFailure = async (error: unknown): Promise<never> => {
      const cancelled = request.signal.aborted && !callerDeadlineExpired() || transportController.signal.reason === 'PROVIDER_CANCELLED'
      const code = cancelled ? 'PROVIDER_CANCELLED' : timeoutCode ?? 'PROVIDER_NETWORK_ERROR'
      terminalFailureCode = code
      await observe(cancelled ? 'cancelled' : 'failed')
      if (code === 'PROVIDER_CONNECT_TIMEOUT') throw new ArkHttpError(code, `连接${providerLabel}超过了 ${request.connectTimeoutMs} 毫秒。`)
      if (code === 'PROVIDER_FIRST_EVENT_TIMEOUT') throw new ArkHttpError(code, `${providerLabel}已建立响应，但在 ${request.firstEventTimeoutMs} 毫秒内没有返回首个数据。`, httpStatus)
      if (code === 'PROVIDER_IDLE_TIMEOUT') throw new ArkHttpError(code, `${providerLabel}响应已开始，但连续 ${request.idleTimeoutMs} 毫秒没有新数据。`, httpStatus)
      if (code === 'BUDGET_WALL_TIME') throw new ArkHttpError(code, '本轮剩余时间不足，当前模型尝试已停止。', httpStatus)
      if (code === 'PROVIDER_TOTAL_TIMEOUT') throw new ArkHttpError(code, `${providerLabel}达到单次请求总时间上限。`, httpStatus)
      if (code === 'PROVIDER_CANCELLED') throw new ArkHttpError(code, '供应商请求已取消。', httpStatus)
      throw new ArkHttpError(code, `读取${providerLabel}响应时网络连接中断。${error instanceof Error && error.message !== '' ? `（${error.message.slice(0, 240)}）` : ''}`, httpStatus)
    }

    let response: Response
    try {
      const preflightElapsedMs = Date.now() - startedAt
      if (preflightElapsedMs >= request.timeoutMs) {
        timeoutCode = request.totalTimeoutCode ?? 'PROVIDER_TOTAL_TIMEOUT'
        throw new Error('Request deadline elapsed before send.')
      }
      if (preflightElapsedMs >= request.connectTimeoutMs) {
        timeoutCode = 'PROVIDER_CONNECT_TIMEOUT'
        throw new Error('Connection deadline elapsed before send.')
      }
      setPhaseTimer('PROVIDER_CONNECT_TIMEOUT', Math.max(1, request.connectTimeoutMs - preflightElapsedMs))
      await observe('connecting')
      response = await this.#fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: accumulator === null ? 'application/json' : 'text/event-stream',
          authorization: `Bearer ${apiKey}`
        },
        body: serializedBody,
        redirect: 'error',
        credentials: 'omit',
        signal: transportController.signal
      })
      httpStatus = response.status
      // HTTP request IDs are not model Response IDs and cannot authorize query.
      providerResponseId = null
      setPhaseTimer('PROVIDER_FIRST_EVENT_TIMEOUT', request.firstEventTimeoutMs)
      await observe('headers')
    } catch (error) {
      clearTimers()
      return throwTransportFailure(error)
    }

    const contentType = response.headers.get('content-type')
    if (!response.ok) {
      let text = ''
      if (response.body !== null) {
        const errorReader = response.body.getReader()
        const errorChunks: Uint8Array[] = []
        let errorBytes = 0
        let firstBodyChunk = true
        try {
          while (true) {
            const next = await readWithAbort(errorReader, transportController.signal)
            if (next.done) break
            errorBytes += next.value.byteLength
            receivedBytes += next.value.byteLength
            if (errorBytes > MAX_LLM_RESPONSE_BYTES) {
              terminalFailureCode = 'PROVIDER_RESPONSE_TOO_LARGE'
              await errorReader.cancel(terminalFailureCode)
              await observe('failed')
              throw new ArkHttpError(terminalFailureCode, `${providerLabel}错误响应超过了 16 MiB 安全上限。`, response.status, contentType)
            }
            lastTransportActivityAt = new Date().toISOString()
            if (firstBodyChunk) {
              firstBodyChunk = false
              await observe('first_event')
            }
            setPhaseTimer('PROVIDER_IDLE_TIMEOUT', request.idleTimeoutMs)
            errorChunks.push(next.value)
          }
          text = Buffer.concat(errorChunks.map((chunk) => Buffer.from(chunk)), errorBytes).toString('utf8')
        } catch (error) {
          if (error instanceof ArkHttpError) throw error
          return throwTransportFailure(error)
        } finally {
          clearTimers()
          try { await errorReader.cancel() } catch { /* response is closed */ }
          try { errorReader.releaseLock() } catch { /* already released */ }
        }
      }
      clearTimers()
      const value = parseJson(text)
      const code = providerHttpCodeForStatus(response.status, value)
      terminalFailureCode = code
      await observe('failed')
      const detail = value === null
        ? `${providerLabel} 返回 HTTP ${response.status}。`
        : safeErrorMessage(value, response.status, providerLabel)
      throw new ArkHttpError(code, redactKnownSecret(detail, apiKey), response.status, contentType)
    }
    if (response.body === null) {
      clearTimers()
      terminalFailureCode = 'PROVIDER_EMPTY_RESPONSE'
      await observe('failed')
      throw new ArkHttpError('PROVIDER_EMPTY_RESPONSE', `${providerLabel} 返回了空响应。`, response.status, contentType)
    }
    if (accumulator !== null && !/^text\/event-stream(?:;|$)/i.test(contentType ?? '')) {
      clearTimers()
      try { await response.body.cancel() } catch { /* response is closed */ }
      terminalFailureCode = 'PROVIDER_CONTENT_TYPE_MISMATCH'
      await observe('failed')
      throw new ArkHttpError('PROVIDER_CONTENT_TYPE_MISMATCH', `${providerLabel}没有返回 text/event-stream；请核对协议和流式能力。`, response.status, contentType)
    }

    const reader = response.body.getReader()
    const decoder = accumulator === null ? null : new SseDecoder()
    const chunks: Uint8Array[] = []
    let firstEvent = true
    let lastReceivingCheckpoint = Number.NEGATIVE_INFINITY
    let lastReceivingDelivery = Number.NEGATIVE_INFINITY
    const receiving = async (forceCheckpoint = false): Promise<void> => {
      const now = Date.now()
      const checkpoint = forceCheckpoint || now - lastReceivingCheckpoint >= 5_000
      if (checkpoint || now - lastReceivingDelivery >= 100) {
        if (receivingTimer !== null) clearTimeout(receivingTimer)
        receivingTimer = null
        lastReceivingDelivery = now
        if (checkpoint) lastReceivingCheckpoint = now
        await observe('receiving', checkpoint)
      } else if (receivingTimer === null) {
        receivingTimer = setTimeout(() => {
          receivingTimer = null
          lastReceivingDelivery = Date.now()
          void observe('receiving', false)
        }, Math.max(1, 100 - (now - lastReceivingDelivery)))
      }
    }
    const acceptFrames = async (frames: readonly ReturnType<SseDecoder['finish']>[number][]): Promise<{
      readonly terminal: boolean
      readonly immediateCheckpoint: boolean
    }> => {
      let terminal = false
      let immediateCheckpoint = false
      for (const frame of frames) {
        const observations = accumulator!.accept(frame)
        recognizedEventCount += frame.commentOnly ? 0 : 1
        for (const item of observations) {
          const observation = item as LlmStreamObservation
          providerResponseId = observation.responseId ?? providerResponseId
          if (observation.semantic) lastSemanticProgressAt = new Date().toISOString()
          terminal ||= observation.kind === 'terminal'
          immediateCheckpoint ||= observation.kind === 'tool_arguments_complete' || observation.kind === 'terminal'
        }
      }
      return { terminal, immediateCheckpoint }
    }
    let protocolTerminated = false
    try {
      while (true) {
        const next = await readWithAbort(reader, transportController.signal)
        if (next.done) break
        receivedBytes += next.value.byteLength
        if (receivedBytes > MAX_LLM_RESPONSE_BYTES) {
          terminalFailureCode = 'PROVIDER_RESPONSE_TOO_LARGE'
          await reader.cancel(terminalFailureCode)
          throw new ArkHttpError(terminalFailureCode, `${providerLabel}响应超过了 16 MiB 安全上限。`, response.status, contentType)
        }
        lastTransportActivityAt = new Date().toISOString()
        if (decoder === null) {
          chunks.push(next.value)
          if (firstEvent) {
            firstEvent = false
            setPhaseTimer('PROVIDER_IDLE_TIMEOUT', request.idleTimeoutMs)
            await observe('first_event')
          } else {
            setPhaseTimer('PROVIDER_IDLE_TIMEOUT', request.idleTimeoutMs)
          }
        } else {
          const frames = decoder.push(next.value)
          const accepted = await acceptFrames(frames)
          if (firstEvent && frames.some((frame) => !frame.commentOnly && frame.data.trim() !== '')) {
            firstEvent = false
            setPhaseTimer('PROVIDER_IDLE_TIMEOUT', request.idleTimeoutMs)
            await observe('first_event')
          } else if (!firstEvent) {
            setPhaseTimer('PROVIDER_IDLE_TIMEOUT', request.idleTimeoutMs)
          }
          if (accepted.immediateCheckpoint && !firstEvent) await receiving(true)
          protocolTerminated ||= accepted.terminal
        }
        if (!firstEvent) await receiving()
        if (protocolTerminated) {
          try { await reader.cancel('protocol-terminal') } catch { /* response is already complete */ }
          break
        }
      }
      if (decoder !== null && !protocolTerminated) {
        const accepted = await acceptFrames(decoder.finish())
        protocolTerminated ||= accepted.terminal
        if (accepted.immediateCheckpoint) await receiving(true)
      }
      const value = accumulator === null
        ? parseJson(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), receivedBytes).toString('utf8'))
        : accumulator.finalize()
      if (value === null) throw new ArkHttpError('PROVIDER_PROTOCOL_MISMATCH', `${providerLabel}没有返回可解析的 JSON。`, response.status, contentType)
      if (accumulator === null && typeof value === 'object' && 'id' in value && typeof value.id === 'string') providerResponseId = value.id
      if (receivingTimer !== null) clearTimeout(receivingTimer)
      receivingTimer = null
      await observe('completed')
      return value
    } catch (error) {
      if (receivingTimer !== null) clearTimeout(receivingTimer)
      receivingTimer = null
      try { await reader.cancel() } catch { /* reader may already be closed */ }
      if (error instanceof ArkHttpError || error instanceof Error && 'code' in error && typeof error.code === 'string') {
        const code = (error as { readonly code: string }).code
        terminalFailureCode = code
        await observe(code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'failed')
        throw error
      }
      return throwTransportFailure(error)
    } finally {
      clearTimers()
      try { reader.releaseLock() } catch { /* already released */ }
    }
  }

  async postMultipart(request: ProviderMultipartRequest): Promise<unknown> {
    const url = approvedUrl(request.url, this.#approvedBases)
    const providerLabel = request.providerLabel?.trim() || '供应商'
    if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求在发送前已取消。')
    const totalBytes = request.files.reduce((total, file) => total + file.bytes.length, 0)
    if (totalBytes <= 0 || totalBytes > MAX_REQUEST_JSON_BYTES || request.files.length > 9) {
      throw new ArkHttpError('PROVIDER_REQUEST_TOO_LARGE', '图片上传内容为空、数量过多或超过本地安全上限。')
    }
    const apiKey = await this.#secrets.get(request.secretId)
    if (apiKey === null) throw new ArkHttpError('PROVIDER_KEY_MISSING', `请先为${providerLabel}安全保存 API Key。`)
    await this.#authorization.reserve({
      scopeId: request.authorizationScopeId ?? `${request.secretId}:${randomUUID()}`,
      providerId: request.providerId ?? request.secretId,
      requests: 1,
      images: request.expectedImages,
      costCeilingCny: request.costCeilingCny
    })
    const form = new FormData()
    for (const [name, value] of Object.entries(request.fields)) form.append(name, value)
    for (const file of request.files) {
      form.append(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name)
    }
    const timeoutSignal = AbortSignal.timeout(Math.max(1_000, Math.min(300_000, request.timeoutMs)))
    const signal = AbortSignal.any([request.signal, timeoutSignal])
    let response: Response
    try {
      const send = (key: string) => this.#fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        redirect: 'error',
        credentials: 'omit',
        signal
      })
      response = await (this.#secrets.startRequest?.(request.secretId, send) ?? send(apiKey))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'REQUEST_IDENTITY_UNAVAILABLE') throw error
      if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '请求已取消。')
      if (timeoutSignal.aborted) throw new ArkHttpError('PROVIDER_TIMEOUT', `${providerLabel}在 ${request.timeoutMs} 毫秒内没有响应。`)
      throw new ArkHttpError(
        'PROVIDER_NETWORK_ERROR',
        `无法连接到${providerLabel}。请检查网络、供应商地址和代理设置。${error instanceof Error && error.message !== '' ? `（${error.message.slice(0, 240)}）` : ''}`
      )
    }
    const contentType = response.headers.get('content-type')
    let text: string
    try {
      text = await readBoundedText(response, providerLabel)
    } catch (error) {
      if (error instanceof ArkHttpError) throw error
      if (request.signal.aborted) throw new ArkHttpError('PROVIDER_CANCELLED', '读取供应商响应时请求已取消。')
      if (timeoutSignal.aborted) throw new ArkHttpError('PROVIDER_TIMEOUT', `${providerLabel}在 ${request.timeoutMs} 毫秒内没有完成响应。`)
      throw new ArkHttpError('PROVIDER_NETWORK_ERROR', `读取${providerLabel}响应时网络连接中断。`)
    }
    const value = parseJson(text)
    if (!response.ok) {
      const detail = value === null
        ? `${providerLabel} 返回 HTTP ${response.status}，但响应类型是 ${contentType ?? '未知格式'}，不是可解析的 JSON。请核对 Base URL 与协议。`
        : safeErrorMessage(value, response.status, providerLabel)
      throw new ArkHttpError(
        providerHttpCodeForStatus(response.status, value),
        redactKnownSecret(detail, apiKey),
        response.status,
        contentType
      )
    }
    if (value === null) {
      throw new ArkHttpError(
        text.trim() === '' ? 'PROVIDER_EMPTY_RESPONSE' : 'PROVIDER_PROTOCOL_MISMATCH',
        text.trim() === ''
          ? `${providerLabel} 返回了空响应。`
          : `${providerLabel} 返回了 ${contentType ?? '未知格式'}，但当前协议要求 JSON。请核对 Base URL 与协议。`,
        response.status,
        contentType
      )
    }
    return value
  }
}
