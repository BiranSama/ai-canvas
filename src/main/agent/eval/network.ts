import sharp from 'sharp'

/**
 * Process-wide fetch router for one eval case at a time. Text-model requests
 * go to the configured upstream (live or replayed), image-provider requests
 * are answered by a local mock that never leaves the process, and every other
 * destination is refused and logged. Request headers are never recorded.
 */

export type EvalRoute = 'llm' | 'image' | 'blocked'

export interface EvalTokenUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

export interface EvalRequestLogEntry {
  readonly seq: number
  readonly route: EvalRoute
  readonly method: string
  /** Path relative to the configured base for llm/image routes; origin and path for blocked requests. */
  readonly target: string
  readonly status: number | null
  readonly startedAtMs: number
  readonly durationMs: number | null
  readonly requestBytes: number
  readonly responseBytes: number | null
  readonly usage: EvalTokenUsage | null
  readonly error: string | null
}

export interface CapturedLlmRequest {
  readonly url: URL
  /** Path below the configured text-model base URL, e.g. "responses". */
  readonly endpoint: string
  readonly method: string
  readonly bodyText: string
  readonly init: RequestInit
}

export interface CompletedLlmExchange {
  readonly seq: number
  readonly endpoint: string
  readonly method: string
  readonly requestBodyText: string
  readonly status: number
  readonly contentType: string | null
  readonly responseText: string
}

export interface LlmUpstreamResult {
  readonly response: Response
  /** Settles when the client has consumed the whole body. */
  readonly completed: Promise<{ readonly status: number; readonly contentType: string | null; readonly text: string }>
}

export interface LlmUpstream {
  handle(request: CapturedLlmRequest): Promise<LlmUpstreamResult>
}

export interface EvalNetworkOptions {
  readonly llmBaseUrl: string
  readonly imageBaseUrl: string
  readonly upstream: LlmUpstream
  readonly onLlmExchange?: (exchange: CompletedLlmExchange) => void
}

export class EvalNetworkBlockedError extends Error {
  readonly code = 'EVAL_NETWORK_BLOCKED'

  constructor(target: string) {
    super(`The eval network refused a request outside the configured providers: ${target}`)
    this.name = 'EvalNetworkBlockedError'
  }
}

function baseOf(value: string): URL {
  return new URL(value.endsWith('/') ? value : `${value}/`)
}

function relativeTo(base: URL, url: URL): string | null {
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null
  return url.pathname.slice(base.pathname.length)
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

function bodyLength(body: RequestInit['body']): number {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8')
  if (body instanceof Uint8Array) return body.byteLength
  return 0
}

function frames(text: string): readonly unknown[] {
  const payloads: unknown[] = []
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (data === '' || data === '[DONE]') continue
    try { payloads.push(JSON.parse(data)) } catch { /* not JSON */ }
  }
  return payloads
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

/** Reads token usage from a Responses or Chat Completions body, buffered or streamed. */
export function extractTokenUsage(text: string, contentType: string | null): EvalTokenUsage | null {
  let candidates: readonly unknown[]
  if (/text\/event-stream/i.test(contentType ?? '') || /^\s*(?:event|data):/m.test(text)) {
    candidates = frames(text)
  } else {
    try { candidates = [JSON.parse(text)] } catch { return null }
  }
  let found: EvalTokenUsage | null = null
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const nested = typeof record.response === 'object' && record.response !== null ? record.response as Record<string, unknown> : null
    const usage = (record.usage ?? nested?.usage) as Record<string, unknown> | undefined | null
    if (typeof usage !== 'object' || usage === null) continue
    found = {
      inputTokens: numberOrNull(usage.input_tokens ?? usage.prompt_tokens),
      outputTokens: numberOrNull(usage.output_tokens ?? usage.completion_tokens)
    }
  }
  return found
}

function parseSize(value: unknown): { readonly width: number; readonly height: number } {
  const match = typeof value === 'string' ? value.match(/^(\d{2,5})x(\d{2,5})$/) : null
  const width = match === null ? 1024 : Number(match[1])
  const height = match === null ? 1024 : Number(match[2])
  const scale = Math.min(1, 512 / Math.max(width, height))
  return { width: Math.max(64, Math.round(width * scale)), height: Math.max(64, Math.round(height * scale)) }
}

async function imageFields(init: RequestInit): Promise<Record<string, unknown>> {
  if (typeof init.body === 'string') {
    try { return JSON.parse(init.body) as Record<string, unknown> } catch { return {} }
  }
  if (init.body instanceof FormData) {
    const fields: Record<string, unknown> = {}
    for (const [name, value] of init.body.entries()) if (typeof value === 'string') fields[name] = value
    return fields
  }
  return {}
}

let mockImageSerial = 0

/** A synthetic, deterministic-size PNG per requested output. It is never billed. */
async function mockImageResponse(init: RequestInit): Promise<Response> {
  const fields = await imageFields(init)
  const count = Math.max(1, Math.min(4, Number(fields.n ?? 1) || 1))
  const size = parseSize(fields.size)
  const data = []
  for (let index = 0; index < count; index += 1) {
    mockImageSerial += 1
    const shade = 120 + (mockImageSerial * 37) % 100
    const png = await sharp({
      create: { width: size.width, height: size.height, channels: 3, background: { r: shade, g: 150, b: 200 - (shade % 60) } }
    }).png().toBuffer()
    data.push({ b64_json: png.toString('base64') })
  }
  return Response.json({ data })
}

export class EvalNetwork {
  readonly #llmBase: URL
  readonly #imageBase: URL
  readonly #upstream: LlmUpstream
  readonly #onLlmExchange: EvalNetworkOptions['onLlmExchange']
  readonly #log: EvalRequestLogEntry[] = []
  readonly #pending = new Set<Promise<void>>()
  #seq = 0
  #startedAt = Date.now()

  constructor(options: EvalNetworkOptions) {
    this.#llmBase = baseOf(options.llmBaseUrl)
    this.#imageBase = baseOf(options.imageBaseUrl)
    this.#upstream = options.upstream
    this.#onLlmExchange = options.onLlmExchange
  }

  /** One ordering clock for network traffic and simulated user decisions. */
  nextSeq(): number {
    this.#seq += 1
    return this.#seq
  }

  get seq(): number {
    return this.#seq
  }

  entries(): readonly EvalRequestLogEntry[] {
    return [...this.#log]
  }

  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
  }

  /** Replaces the global fetch until the returned function restores it. */
  install(): () => void {
    const previous = globalThis.fetch
    const routed = ((input: string | URL | Request, init?: RequestInit) => this.#route(input, init ?? {})) as typeof fetch
    globalThis.fetch = routed
    return () => {
      if (globalThis.fetch === routed) globalThis.fetch = previous
    }
  }

  async #route(input: string | URL | Request, init: RequestInit): Promise<Response> {
    const url = requestUrl(input)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const seq = this.nextSeq()
    const startedAtMs = Date.now() - this.#startedAt
    const llmEndpoint = relativeTo(this.#llmBase, url)
    const imageEndpoint = llmEndpoint === null ? relativeTo(this.#imageBase, url) : null
    if (llmEndpoint !== null) return this.#llm(seq, startedAtMs, url, llmEndpoint, method, init)
    if (imageEndpoint !== null) {
      init.signal?.throwIfAborted()
      const response = await mockImageResponse(init)
      this.#log.push({
        seq, route: 'image', method, target: imageEndpoint, status: response.status, startedAtMs,
        durationMs: Date.now() - this.#startedAt - startedAtMs, requestBytes: bodyLength(init.body),
        responseBytes: null, usage: null, error: null
      })
      return response
    }
    const target = `${url.origin}${url.pathname}`
    this.#log.push({
      seq, route: 'blocked', method, target, status: null, startedAtMs, durationMs: 0,
      requestBytes: bodyLength(init.body), responseBytes: null, usage: null, error: 'EVAL_NETWORK_BLOCKED'
    })
    throw new EvalNetworkBlockedError(target)
  }

  async #llm(seq: number, startedAtMs: number, url: URL, endpoint: string, method: string, init: RequestInit): Promise<Response> {
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const entry: { -readonly [K in keyof EvalRequestLogEntry]: EvalRequestLogEntry[K] } = {
      seq, route: 'llm', method, target: endpoint, status: null, startedAtMs, durationMs: null,
      requestBytes: bodyLength(init.body), responseBytes: null, usage: null, error: null
    }
    this.#log.push(entry)
    let result: LlmUpstreamResult
    try {
      result = await this.#upstream.handle({ url, endpoint, method, bodyText, init })
    } catch (error) {
      entry.error = error instanceof Error ? error.message.slice(0, 500) : 'Upstream request failed.'
      entry.durationMs = Date.now() - this.#startedAt - startedAtMs
      throw error
    }
    entry.status = result.response.status
    const pending = result.completed.then((completed) => {
      entry.durationMs = Date.now() - this.#startedAt - startedAtMs
      entry.responseBytes = Buffer.byteLength(completed.text, 'utf8')
      entry.usage = extractTokenUsage(completed.text, completed.contentType)
      this.#onLlmExchange?.({
        seq, endpoint, method, requestBodyText: bodyText,
        status: completed.status, contentType: completed.contentType, responseText: completed.text
      })
    }, (error: unknown) => {
      entry.durationMs = Date.now() - this.#startedAt - startedAtMs
      entry.error = error instanceof Error ? error.message.slice(0, 500) : 'The response body was not completed.'
    }).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return result.response
  }
}

/** Forwards to the real network and captures the body as the client reads it. */
export class LiveLlmUpstream implements LlmUpstream {
  readonly #fetch: typeof fetch

  constructor(realFetch: typeof fetch) {
    this.#fetch = realFetch
  }

  async handle(request: CapturedLlmRequest): Promise<LlmUpstreamResult> {
    const response = await this.#fetch(request.url, request.init)
    const contentType = response.headers.get('content-type')
    const headers = contentType === null ? undefined : { 'content-type': contentType }
    if (response.body === null) {
      return { response, completed: Promise.resolve({ status: response.status, contentType, text: '' }) }
    }
    const chunks: Buffer[] = []
    let done = false
    let settle: (value: { status: number; contentType: string | null; text: string }) => void = () => undefined
    let fail: (error: unknown) => void = () => undefined
    const completed = new Promise<{ status: number; contentType: string | null; text: string }>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const finish = (): void => {
      if (done) return
      done = true
      settle({ status: response.status, contentType, text: Buffer.concat(chunks).toString('utf8') })
    }
    const reader = response.body.getReader()
    // Pull-based so deadlines in the client keep their meaning. A client that
    // stops after the protocol terminal frame still leaves a complete capture.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            finish()
            return
          }
          chunks.push(Buffer.from(next.value))
          controller.enqueue(next.value)
        } catch (error) {
          done = true
          fail(error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        finish()
        await reader.cancel(reason).catch(() => undefined)
      }
    })
    return {
      response: new Response(body, { status: response.status, statusText: response.statusText, ...(headers === undefined ? {} : { headers }) }),
      completed
    }
  }
}
