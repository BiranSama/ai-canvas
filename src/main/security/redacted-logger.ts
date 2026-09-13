import { randomUUID } from 'node:crypto'

const SENSITIVE_PATTERNS = [
  /\b(?:sk|sk-proj|api)[-_][A-Za-z0-9_-]{8,}\b/gi,
  /((?:authorization|api[-_]?key|token|secret)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi
]

const LOCAL_PATH_PATTERNS = [
  /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g,
  /\/(?:Users|home|var|tmp|etc)\/[^\s"'<>|]+/g
] as const

export function redactSensitive(value: string): string {
  return value
    .replace(SENSITIVE_PATTERNS[0] as RegExp, '[REDACTED]')
    .replace(SENSITIVE_PATTERNS[1] as RegExp, '$1[REDACTED]')
}

export function redactDiagnosticText(value: string): string {
  return LOCAL_PATH_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[LOCAL_PATH]'),
    redactSensitive(value)
  )
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (Array.isArray(value)) return value.map(redactDiagnosticValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      /key|token|secret|authorization/i.test(key) ? '[REDACTED]' : redactDiagnosticValue(nested)
    ]))
  }
  return value
}

export interface RedactedLogRecord {
  readonly level: 'info' | 'warn' | 'error'
  readonly correlationId: string
  readonly event: string
  readonly details: unknown
}

export interface DiagnosticLogger {
  write(level: RedactedLogRecord['level'], event: string, details: unknown, correlationId?: string): string
}

export class RedactedLogger implements DiagnosticLogger {
  readonly #sink: (record: RedactedLogRecord) => void

  constructor(sink: (record: RedactedLogRecord) => void = () => undefined) {
    this.#sink = sink
  }

  write(level: RedactedLogRecord['level'], event: string, details: unknown, correlationId: string = randomUUID()): string {
    this.#sink({ level, correlationId, event: redactDiagnosticText(event), details: redactDiagnosticValue(details) })
    return correlationId
  }
}
