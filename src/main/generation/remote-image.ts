import { ProviderError } from './provider'

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

export interface RemoteImage {
  readonly bytes: Buffer
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly finalUrl: string
}

export interface RemoteImageOptions {
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxRedirects?: number
}

function validatedUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new ProviderError('REMOTE_IMAGE_PROTOCOL', 'Remote images must use HTTPS.', 'localizing')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProviderError('REMOTE_IMAGE_CREDENTIALS', 'Remote image URLs cannot contain credentials.', 'localizing')
  }
  return url
}

function sanitizedSourceUrl(value: URL): string {
  const sanitized = new URL(value)
  sanitized.search = ''
  sanitized.hash = ''
  return sanitized.toString()
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) throw new ProviderError('REMOTE_IMAGE_EMPTY', 'Remote image response was empty.', 'localizing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ProviderError('REMOTE_IMAGE_TOO_LARGE', `Remote image exceeds ${maxBytes} bytes.`, 'localizing')
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size)
}

export async function downloadRemoteImage(inputUrl: string, options: RemoteImageOptions): Promise<RemoteImage> {
  const fetcher = options.fetcher ?? fetch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? 2
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = AbortSignal.any([options.signal, timeout])
  let url = validatedUrl(inputUrl)

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let response: Response
    try {
      response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal })
    } catch (error) {
      if (signal.aborted) throw new ProviderError('REMOTE_IMAGE_ABORTED', 'Remote image download was cancelled or timed out.', 'localizing')
      throw error
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null || redirectCount === maxRedirects) {
        throw new ProviderError('REMOTE_IMAGE_REDIRECT', 'Remote image redirected too many times.', 'localizing')
      }
      url = validatedUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) throw new ProviderError('REMOTE_IMAGE_HTTP', `Remote image returned HTTP ${response.status}.`, 'localizing')

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      throw new ProviderError('REMOTE_IMAGE_TYPE', 'Remote response is not a supported PNG, JPEG or WebP image.', 'localizing')
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ProviderError('REMOTE_IMAGE_TOO_LARGE', `Remote image exceeds ${maxBytes} bytes.`, 'localizing')
    }
    const bytes = await readLimitedBody(response, maxBytes)
    if (bytes.length === 0) throw new ProviderError('REMOTE_IMAGE_EMPTY', 'Remote image response was empty.', 'localizing')
    return { bytes, mimeType: mimeType as RemoteImage['mimeType'], finalUrl: sanitizedSourceUrl(url) }
  }

  throw new ProviderError('REMOTE_IMAGE_REDIRECT', 'Remote image redirected too many times.', 'localizing')
}
