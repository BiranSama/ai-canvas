import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RedactedLogger, type DiagnosticLogger, type RedactedLogRecord } from './redacted-logger'

export class FileRedactedLogger implements DiagnosticLogger {
  readonly #logger: RedactedLogger
  #pending: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.#logger = new RedactedLogger((record) => {
      this.#pending = this.#pending
        .then(async () => {
          await mkdir(dirname(filePath), { recursive: true })
          await appendFile(filePath, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8')
        })
        .catch(() => undefined)
    })
  }

  write(level: RedactedLogRecord['level'], event: string, details: unknown, correlationId?: string): string {
    return this.#logger.write(level, event, details, correlationId)
  }

  async flush(): Promise<void> {
    await this.#pending
  }
}
