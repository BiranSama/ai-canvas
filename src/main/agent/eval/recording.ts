import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { llmProtocolSchema } from '../../../shared/provider-settings'
import type { CapturedLlmRequest, CompletedLlmExchange, LlmUpstream, LlmUpstreamResult } from './network'

/**
 * Raw text-model HTTP exchanges for one case run. A recording keeps the
 * request only as hashes plus a structural shape, and the response body
 * verbatim (JSON or SSE text), so CI can replay a real run offline.
 */

export const AGENT_EVAL_RECORDING_FORMAT = 'ai-canvas-agent-eval-recording'

export const llmRequestShapeSchema = z.object({
  endpoint: z.string().max(200),
  method: z.string().max(10),
  stream: z.boolean(),
  toolNames: z.array(z.string().max(200)).max(50),
  toolChoice: z.string().max(400),
  messageRoles: z.array(z.string().max(40)).max(200),
  hasImages: z.boolean(),
  instructionsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  toolsSha256: z.string().regex(/^[0-9a-f]{64}$/)
}).strict()

export const recordedExchangeSchema = z.object({
  index: z.number().int().nonnegative(),
  request: z.object({
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    normalizedBodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    shape: llmRequestShapeSchema
  }).strict(),
  response: z.object({
    status: z.number().int().min(100).max(599),
    contentType: z.string().max(200).nullable(),
    body: z.string().max(16 * 1024 * 1024)
  }).strict()
}).strict()

export const agentEvalRecordingSchema = z.object({
  format: z.literal(AGENT_EVAL_RECORDING_FORMAT),
  formatVersion: z.literal(1),
  source: z.enum(['live', 'hand-written']),
  caseId: z.string().regex(/^[a-z]+(?:-[a-z]+)*-\d{2}$/),
  run: z.number().int().positive(),
  engine: z.object({ id: z.string().trim().min(1).max(80), version: z.number().int().positive() }).strict(),
  promptFingerprint: z.string().max(200).nullable(),
  llm: z.object({ protocol: llmProtocolSchema, transport: z.enum(['stream', 'buffered']) }).strict(),
  recordedAt: z.string().datetime({ offset: true }),
  note: z.string().max(2_000).optional(),
  exchanges: z.array(recordedExchangeSchema).max(100)
}).strict()

export type LlmRequestShape = z.infer<typeof llmRequestShapeSchema>
export type RecordedExchange = z.infer<typeof recordedExchangeSchema>
export type AgentEvalRecording = z.infer<typeof agentEvalRecordingSchema>

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const DATETIME_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function parseBody(bodyText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : '').join('')
  }
  return ''
}

/** Protocol-neutral structure of one text-model request (Responses or Chat Completions). */
export function llmRequestShape(endpoint: string, method: string, bodyText: string): LlmRequestShape {
  const body = parseBody(bodyText)
  const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : []
  const input = Array.isArray(body.input) ? body.input as Record<string, unknown>[] : messages.filter((message) => message.role !== 'system')
  const instructions = typeof body.instructions === 'string'
    ? body.instructions
    : messages.filter((message) => message.role === 'system').map((message) => messageText(message.content)).join('\n\n')
  const tools = Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : []
  const toolNames = tools.flatMap((tool) => {
    const nested = typeof tool.function === 'object' && tool.function !== null ? tool.function as Record<string, unknown> : null
    const name = tool.name ?? nested?.name
    return typeof name === 'string' ? [name] : []
  })
  const serializedInput = JSON.stringify(input)
  return {
    endpoint,
    method,
    stream: body.stream === true,
    toolNames,
    toolChoice: canonical(body.tool_choice ?? null),
    messageRoles: input.map((message) => String(message.role ?? message.type ?? 'unknown')),
    hasImages: serializedInput.includes('input_image') || serializedInput.includes('image_url'),
    instructionsSha256: sha256(instructions),
    toolsSha256: sha256(canonical(tools))
  }
}

/** Identifies the system prompt plus tool schema that produced a request. */
export function promptFingerprint(shape: LlmRequestShape): string {
  return `p1-${sha256(`${shape.instructionsSha256}:${shape.toolsSha256}`).slice(0, 16)}`
}

/** Hash that ignores the model name, generated IDs and timestamps. Used to flag drift, never to fail a replay. */
export function normalizedBodySha256(bodyText: string): string {
  const body = parseBody(bodyText)
  delete body.model
  const ids = new Map<string, string>()
  const normalized = canonical(body)
    .replace(UUID_PATTERN, (value) => {
      const key = value.toLowerCase()
      if (!ids.has(key)) ids.set(key, `<id-${ids.size + 1}>`)
      return ids.get(key)!
    })
    .replace(DATETIME_PATTERN, '<time>')
  return sha256(normalized)
}

export function recordExchange(index: number, exchange: Pick<CompletedLlmExchange, 'endpoint' | 'method' | 'requestBodyText' | 'status' | 'contentType' | 'responseText'>): RecordedExchange {
  return {
    index,
    request: {
      bodySha256: sha256(exchange.requestBodyText),
      normalizedBodySha256: normalizedBodySha256(exchange.requestBodyText),
      shape: llmRequestShape(exchange.endpoint, exchange.method, exchange.requestBodyText)
    },
    response: { status: exchange.status, contentType: exchange.contentType, body: exchange.responseText }
  }
}

export interface RecordingHeader {
  readonly caseId: string
  readonly run: number
  readonly engine: { readonly id: string; readonly version: number }
  readonly protocol: AgentEvalRecording['llm']['protocol']
}

/** Collects live exchanges of one case run in request order. */
export class RecordingCollector {
  readonly #header: RecordingHeader
  readonly #exchanges: CompletedLlmExchange[] = []

  constructor(header: RecordingHeader) {
    this.#header = header
  }

  add(exchange: CompletedLlmExchange): void {
    this.#exchanges.push(exchange)
  }

  build(recordedAt = new Date().toISOString()): AgentEvalRecording {
    const exchanges = [...this.#exchanges].sort((left, right) => left.seq - right.seq).map((exchange, index) => recordExchange(index, exchange))
    const first = exchanges[0]?.request.shape
    return agentEvalRecordingSchema.parse({
      format: AGENT_EVAL_RECORDING_FORMAT,
      formatVersion: 1,
      source: 'live',
      caseId: this.#header.caseId,
      run: this.#header.run,
      engine: { id: this.#header.engine.id, version: this.#header.engine.version },
      promptFingerprint: first === undefined ? null : promptFingerprint(first),
      llm: { protocol: this.#header.protocol, transport: exchanges.some((exchange) => exchange.request.shape.stream) ? 'stream' : 'buffered' },
      recordedAt,
      exchanges
    })
  }
}

export async function readRecording(path: string): Promise<AgentEvalRecording> {
  return agentEvalRecordingSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function writeRecording(path: string, recording: AgentEvalRecording): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(agentEvalRecordingSchema.parse(recording), null, 2)}\n`, 'utf8')
}

export type ReplayProblemCode = 'STALE_ENGINE' | 'STALE_PROMPT' | 'SHAPE_MISMATCH' | 'EXHAUSTED' | 'UNCONSUMED' | 'CASE_MISMATCH'

export interface ReplayProblem {
  readonly code: ReplayProblemCode
  readonly message: string
}

export class EvalReplayError extends Error {
  readonly code: ReplayProblemCode

  constructor(problem: ReplayProblem) {
    super(problem.message)
    this.name = 'EvalReplayError'
    this.code = problem.code
  }
}

const PROMPT_FIELDS = new Set<keyof LlmRequestShape>(['instructionsSha256', 'toolsSha256'])

function shapeDifferences(recorded: LlmRequestShape, actual: LlmRequestShape): readonly (keyof LlmRequestShape)[] {
  return (Object.keys(recorded) as (keyof LlmRequestShape)[]).filter((key) => canonical(recorded[key]) !== canonical(actual[key]))
}

function describe(value: unknown): string {
  const text = canonical(value)
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`
}

/**
 * Serves a recording in order. In strict mode any structural difference is a
 * loud failure; a changed system prompt or tool schema is reported as a stale
 * recording. Refresh mode serves the same responses but captures the current
 * request shapes, so hand-written fixtures can be re-stamped deliberately.
 */
export class ReplayLlmUpstream implements LlmUpstream {
  readonly #recording: AgentEvalRecording
  readonly #mode: 'strict' | 'refresh'
  readonly #problems: ReplayProblem[] = []
  readonly #observed: RecordedExchange[] = []
  #next = 0

  constructor(recording: AgentEvalRecording, mode: 'strict' | 'refresh' = 'strict') {
    this.#recording = recording
    this.#mode = mode
  }

  get problems(): readonly ReplayProblem[] {
    return [...this.#problems]
  }

  async handle(request: CapturedLlmRequest): Promise<LlmUpstreamResult> {
    request.init.signal?.throwIfAborted()
    const index = this.#next
    this.#next += 1
    const recorded = this.#recording.exchanges[index]
    const actual = recordExchange(index, {
      endpoint: request.endpoint, method: request.method, requestBodyText: request.bodyText, status: 200, contentType: null, responseText: ''
    })
    if (recorded === undefined) {
      return this.#fail({
        code: 'EXHAUSTED',
        message: `Recording ${this.#label()} has ${this.#recording.exchanges.length} exchange(s), but the engine sent request #${index + 1}.`
      })
    }
    if (this.#mode === 'strict') {
      const differences = shapeDifferences(recorded.request.shape, actual.request.shape)
      if (differences.some((field) => PROMPT_FIELDS.has(field))) {
        return this.#fail({
          code: 'STALE_PROMPT',
          message: `Recording ${this.#label()} is stale: the ${differences.filter((field) => PROMPT_FIELDS.has(field)).map((field) => field === 'instructionsSha256' ? 'system prompt' : 'tool schema').join(' and ')} changed since it was recorded `
            + `(recorded ${this.#recording.promptFingerprint ?? 'unknown'}, current ${promptFingerprint(actual.request.shape)}). Re-record it with pnpm eval:agent, or re-stamp a hand-written fixture with AI_CANVAS_EVAL_REFRESH_RECORDINGS=1.`
        })
      }
      if (differences.length > 0) {
        return this.#fail({
          code: 'SHAPE_MISMATCH',
          message: `Request #${index + 1} of ${this.#label()} differs from the recording in ${differences.map((field) => `${field} (recorded ${describe(recorded.request.shape[field])}, now ${describe(actual.request.shape[field])})`).join('; ')}.`
        })
      }
    }
    this.#observed.push({ ...actual, response: recorded.response })
    const headers = recorded.response.contentType === null ? undefined : { 'content-type': recorded.response.contentType }
    return {
      response: new Response(recorded.response.body, { status: recorded.response.status, ...(headers === undefined ? {} : { headers }) }),
      completed: Promise.resolve({ status: recorded.response.status, contentType: recorded.response.contentType, text: recorded.response.body })
    }
  }

  /** Records unconsumed exchanges as a problem; call after the case run ends. */
  finish(): readonly ReplayProblem[] {
    if (this.#mode === 'strict' && this.#problems.length === 0 && this.#next < this.#recording.exchanges.length) {
      this.#problems.push({
        code: 'UNCONSUMED',
        message: `Recording ${this.#label()} still has ${this.#recording.exchanges.length - this.#next} unused exchange(s); the engine made fewer text-model requests than when it was recorded.`
      })
    }
    return this.problems
  }

  /** The recording re-stamped with the request shapes observed in refresh mode. */
  refreshed(recordedAt = new Date().toISOString()): AgentEvalRecording {
    const first = this.#observed[0]?.request.shape
    return agentEvalRecordingSchema.parse({
      ...this.#recording,
      promptFingerprint: first === undefined ? this.#recording.promptFingerprint : promptFingerprint(first),
      recordedAt,
      exchanges: this.#observed.map((exchange, index) => ({ ...exchange, index }))
    })
  }

  #label(): string {
    return `${this.#recording.caseId}#${this.#recording.run}`
  }

  #fail(problem: ReplayProblem): never {
    this.#problems.push(problem)
    throw new EvalReplayError(problem)
  }
}
