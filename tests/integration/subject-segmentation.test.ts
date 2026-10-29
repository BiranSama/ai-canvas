import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createIsnetSession, runIsnet } from '../../src/main/segmentation/isnet-core'
import { ModelDownloader } from '../../src/main/segmentation/model-download'
import { SubjectSegmentation, type SubjectRunner } from '../../src/main/segmentation/subject-segmentation'
import { maskIoU } from '../../src/shared/mask-raster'
import { SUBJECT_MODEL, type DownloadableModel, type SubjectModelStatus } from '../../src/shared/segmentation'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'models-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

interface Served {
  readonly url: string
  readonly requests: Array<string | undefined>
}

/** A file server that honours ranges, and can cut the first answer short or send the wrong bytes first. */
async function serve(bytes: Buffer, behaviour: { cutFirstAt?: number; wrongFirst?: boolean } = {}): Promise<Served> {
  const requests: Array<string | undefined> = []
  const server: Server = createServer((request, response) => {
    const range = request.headers.range
    requests.push(range)
    const first = requests.length === 1
    const body = first && behaviour.wrongFirst === true ? Buffer.alloc(bytes.length, 7) : bytes
    const start = range === undefined ? 0 : Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
    response.writeHead(range === undefined ? 200 : 206, { 'content-length': String(body.length - start), 'accept-ranges': 'bytes' })
    if (first && behaviour.cutFirstAt !== undefined) {
      response.write(body.subarray(start, behaviour.cutFirstAt), () => response.destroy())
      return
    }
    response.end(body.subarray(start))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No address.')
  return { url: `http://127.0.0.1:${address.port}/model.onnx`, requests }
}

function modelFor(bytes: Buffer, url: string): DownloadableModel {
  return { id: 'test-model', file: 'test.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url }
}

const fetchModel = (url: string, init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }): Promise<Response> => fetch(url, init)

describe('downloading the Select Subject model', () => {
  it('resumes an interrupted download from where it stopped and checks it before keeping it', async () => {
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251))
    const served = await serve(bytes, { cutFirstAt: 120_000 })
    const directory = await folder()
    const statuses: SubjectModelStatus[] = []
    const downloader = new ModelDownloader({ model: modelFor(bytes, served.url), directory, fetch: fetchModel, onStatus: (status) => statuses.push(status) })
    expect((await downloader.status()).state).toBe('missing')

    const broken = await downloader.download()
    expect(broken.state).toBe('failed')
    expect(broken.error).toContain('接着下载')
    expect(broken.receivedBytes).toBeGreaterThan(0)
    expect(existsSync(downloader.path)).toBe(false)

    const done = await downloader.download()
    expect(done).toMatchObject({ state: 'ready', receivedBytes: bytes.length, error: null })
    expect(served.requests).toEqual([undefined, `bytes=${broken.receivedBytes}-`])
    expect(await readFile(downloader.path)).toEqual(bytes)
    expect(statuses.some((status) => status.state === 'verifying')).toBe(true)
    expect((await downloader.status()).state).toBe('ready')
  })

  it('throws away a file that fails the checksum and downloads it again from the start', async () => {
    const bytes = Buffer.from(Array.from({ length: 50_000 }, (_, index) => (index * 7) % 256))
    const served = await serve(bytes, { wrongFirst: true })
    const directory = await folder()
    const downloader = new ModelDownloader({ model: modelFor(bytes, served.url), directory, fetch: fetchModel })
    expect(await downloader.download()).toMatchObject({ state: 'ready' })
    expect(served.requests).toEqual([undefined, undefined])
    expect(await readFile(downloader.path)).toEqual(bytes)
  })

  it('gives up after a second bad file, keeps nothing, and fetches from a mirror when asked', async () => {
    const bytes = Buffer.alloc(10_000, 3)
    const wrong = await serve(Buffer.alloc(10_000, 9))
    const directory = await folder()
    const downloader = new ModelDownloader({ model: modelFor(bytes, wrong.url), directory, fetch: fetchModel })
    const failed = await downloader.download()
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('校验没有通过')
    expect(existsSync(`${downloader.path}.part`)).toBe(false)

    const mirror = await serve(bytes)
    expect(await downloader.download(mirror.url)).toMatchObject({ state: 'ready' })
  })

  it('fails the download, not the app, when the file cannot be written', async () => {
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251))
    const served = await serve(bytes)
    const directory = await folder()
    const downloader = new ModelDownloader({ model: modelFor(bytes, served.url), directory, fetch: fetchModel })
    // A folder where the partial file goes: the write stream fails after it opens.
    await mkdir(`${downloader.path}.part`)
    const failed = await downloader.download()
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('下载没有完成')
    expect(existsSync(downloader.path)).toBe(false)
  })

  it('stops when cancelled and says so', async () => {
    const bytes = Buffer.alloc(2_000_000, 1)
    const served = await serve(bytes)
    const directory = await folder()
    const downloader = new ModelDownloader({
      model: modelFor(bytes, served.url),
      directory,
      fetch: async (url, init) => { const response = await fetchModel(url, init); downloader.cancel(); return response }
    })
    const cancelled = await downloader.download()
    expect(cancelled.state).toBe('failed')
    expect(cancelled.error).toContain('已取消')
  })

  it('names the published ISNet file and its checksum', () => {
    expect(SUBJECT_MODEL).toMatchObject({ bytes: 178_648_008, url: expect.stringMatching(/^https:\/\/github\.com\//) })
    expect(SUBJECT_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// The 170 MB model is not in the repository; point AI_CANVAS_SUBJECT_MODEL_DIR at a folder holding it to run this.
const modelDirectory = process.env.AI_CANVAS_SUBJECT_MODEL_DIR
const modelPresent = modelDirectory !== undefined && existsSync(join(modelDirectory, SUBJECT_MODEL.file))

describe.skipIf(!modelPresent)('Select Subject with ISNet', () => {
  it('finds the subject of a photo-like picture with an intersection over union of at least 0.9', async () => {
    const width = 640
    const height = 480
    // A shaded orange vase on a soft blue-gray wall and a wooden table.
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9D3DC"/><stop offset="1" stop-color="#9FAAB5"/></linearGradient>
        <linearGradient id="table" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7A5636"/><stop offset="1" stop-color="#94693F"/></linearGradient>
        <radialGradient id="vase" cx="0.38" cy="0.35" r="0.75"><stop offset="0" stop-color="#F6A14A"/><stop offset="0.6" stop-color="#D86C1F"/><stop offset="1" stop-color="#8E3F0D"/></radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#wall)"/>
      <rect y="360" width="${width}" height="120" fill="url(#table)"/>
      <path id="subject" d="M 280 120 C 270 150 250 170 240 210 C 225 270 230 330 260 370 L 380 370 C 410 330 415 270 400 210 C 390 170 370 150 360 120 Z" fill="url(#vase)"/>
    </svg>`
    const picture = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
    const truthSvg = svg.replace('fill="url(#vase)"', 'fill="#FFFFFF"').replace(/<rect[^>]*>/g, '')
    const truth = await sharp(Buffer.from(truthSvg.replace('<defs>', '<rect width="640" height="480" fill="#000000"/><defs>'))).extractChannel(0).raw().toBuffer()
    const directory = modelDirectory!
    const session = await createIsnetSession(join(directory, SUBJECT_MODEL.file))
    const runner: SubjectRunner = { segment: (_path, rgb) => runIsnet(session, rgb), dispose: () => undefined }
    const segmentation = new SubjectSegmentation({ downloader: new ModelDownloader({ model: SUBJECT_MODEL, directory, fetch: fetchModel }), runner })
    const result = await segmentation.segment({ width, height, rgba: new Uint8Array(picture) })
    expect([result.width, result.height]).toEqual([width, height])
    const iou = maskIoU({ width, height, data: result.mask }, { width, height, data: new Uint8Array(truth) })
    await writeFile(join(tmpdir(), 'isnet-subject.png'), await sharp(Buffer.from(result.mask), { raw: { width, height, channels: 1 } }).png().toBuffer())
    expect(iou).toBeGreaterThanOrEqual(0.9)
  }, 60_000)
})
