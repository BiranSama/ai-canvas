import { z } from 'zod'
import type {
  KrillGetRequest,
  KrillImageDownload,
  KrillJsonRequest,
  KrillTransport
} from '../generation'

const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const DEFAULT_BASE_URL = 'https://api.krill-ai.net/v1'
const MAX_READ_RETRIES = 2
const TRANSIENT_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

interface SecretSource {
  get(id: 'image-provider'): Promise<string | null>
  startRequest?(id: string, send: (secret: string) => Promise<Response>): Promise<Response>
}

export type KrillHttpOperation = 'models' | 'submit' | 'poll' | 'download'

export interface KrillRequestAuthorization {
  /** Must persistently reserve the operation before any external fetch occurs. */
  reserve(input: {
    readonly operation: KrillHttpOperation
    readonly scopeId: string
    readonly providerId: 'image-provider'
    readonly requests: 1
    readonly expectedImages: 0 | 1
    readonly costCeilingCny: number
  }): Promise<void>
}

function scopeId(value: string | undefined, url: URL): string {
  const fallbackTask = url.pathname.match(/^\/v1\/images\/([A-Za-z0-9._:-]+)(?:\/content)?$/)?.[1]
  const taskScope = fallbackTask === undefined || fallbackTask === 'generations' ? null : `krill-task:${fallbackTask}`
  return z.string().trim().min(1).max(240).parse(value ?? taskScope ?? 'krill-provider')
}

function submissionCostCeiling(body: Readonly<Record<string, unknown>>): number {
  const model = typeof body.model === 'string' ? body.model : ''
  if (model.endsWith('-pro')) return 5
  if (model === 'qwen-image-2.0' || model === 'wan2.7-image') return 2
  return 5
}

export class KrillHttpError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(code: string, message: string, status: number | null = null) {
    super(message)
    this.name = 'KrillHttpError'
    this.code = code
    this.status = status
  }
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new KrillHttpError('KRILL_DESTINATION_DENIED', '异步图片供应商地址必须使用不含凭据、查询或片段的 HTTPS。')
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith('/images/generations')) {
    url.pathname = normalizedPath.slice(0, -'/images/generations'.length) || '/'
  }
  return new URL(url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function approvedUrl(value: string, operation: KrillHttpOperation, base: URL): URL {
  const url = new URL(value)
  if (url.origin !== base.origin || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new KrillHttpError('KRILL_DESTINATION_DENIED', '异步图片请求只能发往已保存的供应商地址。')
  }
  const task = '[A-Za-z0-9._:-]+'
  const prefix = escapeRegExp(base.pathname.replace(/\/+$/, ''))
  const allowed = operation === 'models'
    ? new RegExp(`^${prefix}/models$`)
    : operation === 'submit'
      ? new RegExp(`^${prefix}/images/generations$`)
      : operation === 'poll'
        ? new RegExp(`^${prefix}/images/${task}$`)
        : new RegExp(`^${prefix}/images/${task}/content$`)
  if (!allowed.test(url.pathname)) {
    throw new KrillHttpError('KRILL_DESTINATION_DENIED', `异步图片 ${operation} 请求路径不在已保存的供应商范围内。`)
  }
  return url
}

async function readLimited(response: Response, maxBytes: number, providerLabel: string): Promise<Buffer> {
  if (response.body === null) throw new KrillHttpError('KRILL_EMPTY_RESPONSE', `${providerLabel}返回了空响应。`, response.status)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new KrillHttpError('KRILL_RESPONSE_TOO_LARGE', `${providerLabel}响应超过了本地安全上限。`, response.status)
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

async function readJson(response: Response, providerLabel: string): Promise<unknown> {
  const bytes = await readLimited(response, MAX_JSON_BYTES, providerLabel)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new KrillHttpError('KRILL_INVALID_JSON', `${providerLabel}返回了无法解析的 JSON。`, response.status)
  }
}

function safeErrorMessage(value: unknown, status: number, providerLabel: string): string {
  const parsed = z.object({
    error: z.object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().max(2_000).optional()
    }).optional(),
    message: z.string().max(2_000).optional()
  }).safeParse(value)
  if (!parsed.success) return `${providerLabel}请求返回 HTTP ${status}。`
  const code = parsed.data.error?.code
  const message = parsed.data.error?.message ?? parsed.data.message
  return [code === undefined ? null : String(code), message]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(': ') || `${providerLabel}请求返回 HTTP ${status}。`
}

async function waitForReadRetry(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new KrillHttpError('KRILL_ABORTED', '读取请求已取消。')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new KrillHttpError('KRILL_ABORTED', '读取请求已取消。'))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, attempt === 1 ? 150 : 350)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class KrillHttpTransport implements KrillTransport {
  readonly #secrets: SecretSource
  readonly #authorization: KrillRequestAuthorization
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #approvedBase: URL
  readonly #submissionCostCeilingCny: number | null
  readonly #providerLabel: string

  constructor(options: {
    readonly secrets: SecretSource
    readonly authorization: KrillRequestAuthorization
    readonly fetcher?: typeof fetch
    readonly timeoutMs?: number
    readonly baseUrl?: string
    readonly submissionCostCeilingCny?: number
    readonly providerLabel?: string
  }) {
    this.#secrets = options.secrets
    this.#authorization = options.authorization
    this.#fetcher = options.fetcher ?? fetch
    this.#timeoutMs = Math.max(1_000, Math.min(300_000, options.timeoutMs ?? 30_000))
    this.#approvedBase = normalizedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.#submissionCostCeilingCny = options.submissionCostCeilingCny === undefined
      ? null
      : Math.max(0, options.submissionCostCeilingCny)
    this.#providerLabel = options.providerLabel?.trim() || 'Krill'
  }

  async postJson(request: KrillJsonRequest, signal: AbortSignal): Promise<unknown> {
    const url = approvedUrl(request.url, 'submit', this.#approvedBase)
    const serialized = JSON.stringify(request.body)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      throw new KrillHttpError('KRILL_REQUEST_TOO_LARGE', 'Krill JSON request exceeded the local safety limit.')
    }
    const response = await this.#fetch(url, 'submit', signal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serialized
    }, request.authorizationScopeId, this.#submissionCostCeilingCny ?? submissionCostCeiling(request.body))
    const value = await readJson(response, this.#providerLabel)
    if (!response.ok) throw new KrillHttpError('KRILL_HTTP_ERROR', safeErrorMessage(value, response.status, this.#providerLabel), response.status)
    return value
  }

  async getJson(request: KrillGetRequest, signal: AbortSignal): Promise<unknown> {
    const operation: KrillHttpOperation = request.url.endsWith('/models') ? 'models' : 'poll'
    const url = approvedUrl(request.url, operation, this.#approvedBase)
    const response = await this.#fetchRead(url, operation, signal, request.authorizationScopeId)
    const value = await readJson(response, this.#providerLabel)
    if (!response.ok) throw new KrillHttpError('KRILL_HTTP_ERROR', safeErrorMessage(value, response.status, this.#providerLabel), response.status)
    return value
  }

  async getImage(request: KrillGetRequest, signal: AbortSignal): Promise<KrillImageDownload> {
    const url = approvedUrl(request.url, 'download', this.#approvedBase)
    const response = await this.#fetchRead(url, 'download', signal, request.authorizationScopeId)
    if (!response.ok) {
      const value = await readJson(response, this.#providerLabel)
      throw new KrillHttpError('KRILL_HTTP_ERROR', safeErrorMessage(value, response.status, this.#providerLabel), response.status)
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      throw new KrillHttpError('KRILL_IMAGE_TYPE', `${this.#providerLabel}的内容接口没有返回 PNG、JPEG 或 WebP。`, response.status)
    }
    return { bytes: await readLimited(response, MAX_IMAGE_BYTES, this.#providerLabel), mimeType }
  }

  async #fetchRead(
    url: URL,
    operation: Exclude<KrillHttpOperation, 'submit'>,
    callerSignal: AbortSignal,
    authorizationScopeId: string | undefined
  ): Promise<Response> {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt += 1) {
      try {
        const response = await this.#fetch(url, operation, callerSignal, { method: 'GET' }, authorizationScopeId, 0)
        if (!TRANSIENT_READ_STATUSES.has(response.status) || attempt === MAX_READ_RETRIES) return response
        await response.body?.cancel()
      } catch (error) {
        lastError = error
        const transient = error instanceof KrillHttpError
          && (error.code === 'KRILL_NETWORK_ERROR' || error.code === 'KRILL_TIMEOUT')
        if (!transient || attempt === MAX_READ_RETRIES) throw error
      }
      await waitForReadRetry(attempt + 1, callerSignal)
    }
    throw lastError instanceof Error ? lastError : new KrillHttpError('KRILL_NETWORK_ERROR', `${this.#providerLabel}读取请求失败。`)
  }

  async #fetch(
    url: URL,
    operation: KrillHttpOperation,
    callerSignal: AbortSignal,
    init: Omit<RequestInit, 'signal' | 'credentials' | 'redirect'>,
    authorizationScopeId: string | undefined,
    costCeilingCny: number
  ): Promise<Response> {
    if (callerSignal.aborted) throw new KrillHttpError('KRILL_ABORTED', `${this.#providerLabel}请求在发送前已取消。`)
    const apiKey = await this.#secrets.get('image-provider')
    if (apiKey === null) throw new KrillHttpError('KRILL_KEY_MISSING', `请先在供应商设置中安全保存${this.#providerLabel}的 API Key。`)
    await this.#authorization.reserve({
      operation,
      scopeId: scopeId(authorizationScopeId, url),
      providerId: 'image-provider',
      requests: 1,
      expectedImages: operation === 'submit' ? 1 : 0,
      costCeilingCny
    })
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.#timeoutMs)])
    try {
      const send = (key: string) => this.#fetcher(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${key}` },
        credentials: 'omit',
        redirect: 'error',
        signal
      })
      return await (this.#secrets.startRequest?.('image-provider', send) ?? send(apiKey))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'REQUEST_IDENTITY_UNAVAILABLE') throw error
      if (callerSignal.aborted) throw new KrillHttpError('KRILL_ABORTED', `${this.#providerLabel}请求已取消。`)
      if (signal.aborted) throw new KrillHttpError('KRILL_TIMEOUT', `${this.#providerLabel}请求超时。`)
      throw new KrillHttpError('KRILL_NETWORK_ERROR', error instanceof Error ? error.message : `${this.#providerLabel}网络请求失败。`)
    }
  }
}
