import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadableModel, SubjectModelStatus } from '../../shared/segmentation'

/*
 * Fetches a model into the app's model folder once: into a .part file that
 * a broken connection resumes (an HTTP range request), then checked against
 * its SHA-256 before it is renamed into place. A file that fails the check
 * is thrown away and fetched again from the start, once.
 */

export type ModelFetch = (url: string, init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }) => Promise<Response>

const PROGRESS_EVERY_MS = 200

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class ModelDownloader {
  readonly #model: DownloadableModel
  readonly #directory: string
  readonly #fetch: ModelFetch
  readonly #onStatus: (status: SubjectModelStatus) => void
  #status: SubjectModelStatus
  #controller: AbortController | null = null
  #running: Promise<SubjectModelStatus> | null = null

  constructor(input: { readonly model: DownloadableModel; readonly directory: string; readonly fetch: ModelFetch; readonly onStatus?: (status: SubjectModelStatus) => void }) {
    this.#model = input.model
    this.#directory = input.directory
    this.#fetch = input.fetch
    this.#onStatus = input.onStatus ?? (() => undefined)
    this.#status = { state: 'missing', receivedBytes: 0, totalBytes: input.model.bytes, error: null }
  }

  /** Where the model is once ready. */
  get path(): string {
    return join(this.#directory, this.#model.file)
  }

  get #partPath(): string {
    return `${this.path}.part`
  }

  #set(status: Partial<SubjectModelStatus>): void {
    this.#status = { ...this.#status, ...status }
    this.#onStatus(this.#status)
  }

  /** Whether the model is on disk, and how much of an interrupted download is. */
  async status(): Promise<SubjectModelStatus> {
    if (this.#running !== null) return this.#status
    if (await sizeOf(this.path) === this.#model.bytes) {
      this.#status = { ...this.#status, state: 'ready', receivedBytes: this.#model.bytes, error: null }
    } else {
      this.#status = { ...this.#status, state: this.#status.state === 'failed' ? 'failed' : 'missing', receivedBytes: await sizeOf(this.#partPath) }
    }
    return this.#status
  }

  /** Starts the download (or joins the one under way) and resolves when it ends. */
  download(mirrorUrl: string | null = null): Promise<SubjectModelStatus> {
    if (this.#running !== null) return this.#running
    this.#running = this.#run(mirrorUrl ?? this.#model.url).finally(() => {
      this.#running = null
      this.#controller = null
    })
    return this.#running
  }

  /** Stops the download; what arrived stays for the next one to resume from. */
  cancel(): void {
    this.#controller?.abort()
  }

  async #run(url: string): Promise<SubjectModelStatus> {
    await mkdir(this.#directory, { recursive: true })
    if (await sizeOf(this.path) === this.#model.bytes) {
      this.#set({ state: 'ready', receivedBytes: this.#model.bytes, error: null })
      return this.#status
    }
    const controller = new AbortController()
    this.#controller = controller
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.#fetchPart(url, controller.signal)
        this.#set({ state: 'verifying' })
        if (await sha256(this.#partPath) === this.#model.sha256) {
          await rename(this.#partPath, this.path)
          this.#set({ state: 'ready', receivedBytes: this.#model.bytes, error: null })
          return this.#status
        }
        // A file that is not the published model is never kept: start again from nothing.
        await rm(this.#partPath, { force: true })
        this.#set({ state: 'downloading', receivedBytes: 0 })
      }
      this.#set({ state: 'failed', error: '下载的文件校验没有通过，已经删掉。换个下载地址再试。' })
    } catch (error) {
      const message = controller.signal.aborted
        ? '已取消，下次会从断开的地方接着下载。'
        : `下载没有完成：${error instanceof Error ? error.message : String(error)}。再试一次会从断开的地方接着下载。`
      this.#set({ state: 'failed', receivedBytes: await sizeOf(this.#partPath), error: message })
    }
    return this.#status
  }

  async #fetchPart(url: string, signal: AbortSignal): Promise<void> {
    let have = await sizeOf(this.#partPath)
    if (have > this.#model.bytes) {
      await rm(this.#partPath, { force: true })
      have = 0
    }
    this.#set({ state: 'downloading', receivedBytes: have, error: null })
    if (have === this.#model.bytes) return
    const response = await this.#fetch(url, { headers: have > 0 ? { range: `bytes=${have}-` } : {}, signal })
    if (!response.ok || response.body === null) throw new Error(`服务器返回 ${response.status}`)
    // A server that ignores the range sends the whole file again.
    if (have > 0 && response.status !== 206) have = 0
    const file = createWriteStream(this.#partPath, { flags: have > 0 ? 'a' : 'w' })
    let received = have
    let reported = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > this.#model.bytes) throw new Error('文件比预期的大')
        if (!file.write(value)) await new Promise((resolve) => file.once('drain', resolve))
        const now = Date.now()
        if (now - reported >= PROGRESS_EVERY_MS) {
          reported = now
          this.#set({ receivedBytes: received })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()))
    }
    this.#set({ receivedBytes: received })
    if (received !== this.#model.bytes) throw new Error('连接提前断开了')
  }
}
