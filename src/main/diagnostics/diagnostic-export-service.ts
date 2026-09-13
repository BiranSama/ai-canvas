import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import type { AppearanceSettingsSnapshot } from '../../shared/appearance-settings'
import type { ProviderExecutionPolicy } from '../../shared/provider-settings'
import type { ProviderUsageScopeSnapshot } from '../security/provider-usage-ledger'
import { redactDiagnosticText, redactDiagnosticValue } from '../security/redacted-logger'
import type { summarizeGenerationCosts } from '../../shared/generation-cost'

export const MAX_DIAGNOSTIC_EXPORT_BYTES = 2 * 1024 * 1024
export const MAX_DIAGNOSTIC_RECORDS = 500
const MAX_DIAGNOSTIC_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_LOG_SCAN_BYTES = 4 * 1024 * 1024
const MAX_DIAGNOSTIC_STRING_LENGTH = 2_000
const OMITTED_KEY_PATTERN = /authorization|api[-_]?key|credential|token|secret|prompt|conversation|chat|scene|memory|base64|signed[-_]?url|image[-_]?bytes|absolute[-_]?path/i
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const DATA_URI_PATTERN = /data:[^,;\s]+(?:;base64)?,[A-Za-z0-9+/=_-]+/gi
const LONG_BASE64_PATTERN = /\b[A-Za-z0-9+/]{96,}={0,2}\b/g

export interface DiagnosticExportProviderSnapshot {
  readonly id: string
  readonly kind: string
  readonly protocol: string
  readonly configured: boolean
  readonly capabilities: Readonly<Record<string, boolean | number | readonly string[]>>
}

export interface DiagnosticExportProjectSnapshot {
  readonly projectId: string
  readonly schemaVersion: number
  readonly sceneRevision: number
  readonly elementCount: number
  readonly jobCount: number
  readonly resultCount: number
  readonly recovered: boolean
  readonly recoveredFromOlderSnapshot: boolean
  readonly migration: { readonly fromVersion: number; readonly toVersion: number }
}

export interface DiagnosticExportSourceSnapshot {
  readonly runtime: {
    readonly appVersion: string
    readonly electronVersion: string
    readonly platform: string
    readonly nativeModules: {
      readonly betterSqlite3: boolean
      readonly sharp: boolean
      readonly sqliteVersion: string | null
      readonly sharpVersion: string | null
    }
  }
  readonly appearance: AppearanceSettingsSnapshot
  readonly providers: readonly DiagnosticExportProviderSnapshot[]
  readonly executionPolicy: ProviderExecutionPolicy
  readonly usage: readonly ProviderUsageScopeSnapshot[]
  readonly generationCosts?: ReturnType<typeof summarizeGenerationCosts>
  readonly project: DiagnosticExportProjectSnapshot
}

export interface DiagnosticExportReceipt {
  readonly bytes: number
  readonly recordCount: number
  readonly truncated: boolean
}

interface DiagnosticExportServiceOptions {
  readonly logFilePath: string
  readonly now?: () => Date
}

interface ExportableDiagnosticRecord {
  readonly level: string
  readonly correlationId: string
  readonly event: string
  readonly details: unknown
  readonly at: string
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function strictSanitize(value: unknown): unknown {
  const initiallyRedacted = redactDiagnosticValue(value)
  if (typeof initiallyRedacted === 'string') {
    return redactDiagnosticText(initiallyRedacted)
      .replace(DATA_URI_PATTERN, '[OMITTED_DATA]')
      .replace(LONG_BASE64_PATTERN, '[OMITTED_DATA]')
      .replace(URL_PATTERN, '[URL]')
      .slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)
  }
  if (Array.isArray(initiallyRedacted)) return initiallyRedacted.slice(0, 100).map(strictSanitize)
  if (initiallyRedacted !== null && typeof initiallyRedacted === 'object') {
    const entries: Array<[string, unknown]> = []
    for (const [key, nested] of Object.entries(initiallyRedacted)) {
      if (OMITTED_KEY_PATTERN.test(key)) continue
      entries.push([key.slice(0, 120), strictSanitize(nested)])
      if (entries.length >= 100) break
    }
    return Object.fromEntries(entries)
  }
  return initiallyRedacted
}

async function readBoundedTail(filePath: string): Promise<string> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const metadata = await handle.stat()
    const bytesToRead = Math.min(metadata.size, MAX_LOG_SCAN_BYTES)
    const start = Math.max(0, metadata.size - bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    await handle.read(buffer, 0, bytesToRead, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstLineEnd = text.indexOf('\n')
      text = firstLineEnd === -1 ? '' : text.slice(firstLineEnd + 1)
    }
    return text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  } finally {
    await handle?.close()
  }
}

function parseRecentRecords(text: string, now: Date): { readonly records: ExportableDiagnosticRecord[]; readonly malformed: number } {
  const cutoff = now.getTime() - MAX_DIAGNOSTIC_AGE_MS
  const records: ExportableDiagnosticRecord[] = []
  let malformed = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const at = typeof parsed.at === 'string' ? parsed.at : ''
      const timestamp = Date.parse(at)
      if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now.getTime() + 60_000) continue
      records.push({
        level: typeof parsed.level === 'string' ? parsed.level.slice(0, 20) : 'info',
        correlationId: typeof parsed.correlationId === 'string' ? parsed.correlationId.slice(0, 200) : 'unknown',
        event: typeof parsed.event === 'string' ? String(strictSanitize(parsed.event)) : 'unknown',
        details: strictSanitize(parsed.details),
        at: new Date(timestamp).toISOString()
      })
    } catch {
      malformed += 1
    }
  }
  return { records: records.slice(-MAX_DIAGNOSTIC_RECORDS), malformed }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export class DiagnosticExportService {
  readonly #logFilePath: string
  readonly #now: () => Date

  constructor(options: DiagnosticExportServiceOptions) {
    this.#logFilePath = options.logFilePath
    this.#now = options.now ?? (() => new Date())
  }

  async exportTo(destinationPath: string, source: DiagnosticExportSourceSnapshot): Promise<DiagnosticExportReceipt> {
    const now = this.#now()
    const parsed = parseRecentRecords(await readBoundedTail(this.#logFilePath), now)
    const records = [...parsed.records]
    const packageBase = {
      schemaVersion: 1,
      exportedAt: now.toISOString(),
      runtime: source.runtime,
      appearance: source.appearance,
      providers: source.providers,
      executionPolicy: source.executionPolicy,
      usage: source.usage.map(({ scopeId, ...snapshot }) => ({ scopeIdHash: hashIdentifier(scopeId), ...snapshot })),
      generationCosts: source.generationCosts ?? null,
      project: {
        idHash: hashIdentifier(source.project.projectId),
        schemaVersion: source.project.schemaVersion,
        sceneRevision: source.project.sceneRevision,
        elementCount: source.project.elementCount,
        jobCount: source.project.jobCount,
        resultCount: source.project.resultCount,
        recovered: source.project.recovered,
        recoveredFromOlderSnapshot: source.project.recoveredFromOlderSnapshot,
        migration: source.project.migration
      },
      redactionSummary: {
        credentials: 'excluded', authorization: 'excluded', prompts: 'excluded', conversations: 'excluded',
        absolutePaths: 'redacted', imagePayloads: 'excluded', base64: 'excluded', signedUrls: 'excluded',
        projectDatabase: 'excluded', fullScene: 'excluded'
      }
    }
    const initiallyRetained = records.length
    let truncatedForSize = false
    const buildOutput = (): string => serialize({
        ...packageBase,
        diagnostics: { retained: records.length, records },
        truncationSummary: {
          ageDays: 7,
          maximumRecords: MAX_DIAGNOSTIC_RECORDS,
          maximumBytes: MAX_DIAGNOSTIC_EXPORT_BYTES,
          malformedLinesSkipped: parsed.malformed,
          recordsRemovedForSize: initiallyRetained - records.length,
          truncatedForSize
        }
      })
    let output = buildOutput()
    while (true) {
      if (Buffer.byteLength(output, 'utf8') <= MAX_DIAGNOSTIC_EXPORT_BYTES) break
      if (records.length === 0) throw new Error('The diagnostic package cannot fit within its safe export limit.')
      records.shift()
      truncatedForSize = true
      output = buildOutput()
    }
    await writeFile(destinationPath, output, { encoding: 'utf8', flag: 'w' })
    return {
      bytes: Buffer.byteLength(output, 'utf8'),
      recordCount: records.length,
      truncated: truncatedForSize || initiallyRetained === MAX_DIAGNOSTIC_RECORDS
    }
  }
}
