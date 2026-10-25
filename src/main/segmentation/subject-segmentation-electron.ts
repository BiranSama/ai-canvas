import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { SUBJECT_MODEL, type SubjectModelStatus } from '../../shared/segmentation'
import { ModelDownloader } from './model-download'
import { SubjectSegmentation, type SubjectRunner } from './subject-segmentation'

/** A background process lets its memory go after this long without a picture. */
const IDLE_MS = 60_000

/** The model in an Electron utility process: started on the first picture, ended when idle. */
class UtilityProcessRunner implements SubjectRunner {
  readonly #workerPath: string
  #child: UtilityProcess | null = null
  #next = 1
  readonly #pending = new Map<number, { readonly resolve: (mask: Uint8Array) => void; readonly reject: (error: Error) => void }>()
  #idle: ReturnType<typeof setTimeout> | null = null

  constructor(workerPath: string) {
    this.#workerPath = workerPath
  }

  #spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.#workerPath, [], { serviceName: 'AI Canvas 选择主体' })
    child.on('message', (message: { readonly id: number; readonly mask?: Uint8Array; readonly error?: string }) => {
      const waiting = this.#pending.get(message.id)
      if (waiting === undefined) return
      this.#pending.delete(message.id)
      if (message.mask !== undefined) waiting.resolve(message.mask)
      else waiting.reject(new Error(message.error ?? '选择主体没有完成。'))
      this.#scheduleIdle()
    })
    child.on('exit', () => {
      if (this.#child === child) this.#child = null
      for (const waiting of this.#pending.values()) waiting.reject(new Error('选择主体的后台进程意外退出了。'))
      this.#pending.clear()
    })
    this.#child = child
    return child
  }

  #scheduleIdle(): void {
    if (this.#idle !== null) clearTimeout(this.#idle)
    this.#idle = this.#pending.size > 0 ? null : setTimeout(() => this.dispose(), IDLE_MS)
  }

  segment(modelPath: string, rgb: Uint8Array): Promise<Uint8Array> {
    const child = this.#child ?? this.#spawn()
    if (this.#idle !== null) clearTimeout(this.#idle)
    const id = this.#next++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      child.postMessage({ id, modelPath, rgb })
    })
  }

  dispose(): void {
    if (this.#idle !== null) clearTimeout(this.#idle)
    this.#idle = null
    this.#child?.kill()
    this.#child = null
  }
}

let shared: SubjectSegmentation | null = null
const listeners = new Set<(status: SubjectModelStatus) => void>()

/** The one Select Subject service the app keeps; status changes reach every window that listens. */
export function subjectSegmentation(): SubjectSegmentation {
  if (shared !== null) return shared
  // Tests point at a folder that already holds the model, so nothing is downloaded.
  const directory = process.env.AI_CANVAS_SUBJECT_MODEL_DIR ?? join(app.getPath('userData'), 'models')
  const downloader = new ModelDownloader({
    model: SUBJECT_MODEL,
    directory,
    // Electron's own network stack, so the system's proxy settings apply.
    fetch: (url, init) => net.fetch(url, { headers: init.headers, signal: init.signal }),
    onStatus: (status) => { for (const listener of listeners) listener(status) }
  })
  shared = new SubjectSegmentation({ downloader, runner: new UtilityProcessRunner(join(__dirname, 'isnet-worker.js')) })
  app.once('will-quit', () => shared?.dispose())
  return shared
}

export function onSubjectModelStatus(listener: (status: SubjectModelStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The click-to-select model and MediaPipe's WebAssembly, which the page cannot fetch from its own files. */
export async function readMagicTouchAssets(): Promise<{ readonly wasm: Uint8Array; readonly model: Uint8Array }> {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm')
  const modelPath = app.isPackaged
    ? join(process.resourcesPath, 'models', 'magic_touch.tflite')
    : join(app.getAppPath(), 'resources', 'models', 'magic_touch.tflite')
  const [wasm, model] = await Promise.all([readFile(wasmPath), readFile(modelPath)])
  return { wasm: new Uint8Array(wasm), model: new Uint8Array(model) }
}
