import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { OpenFileRequest } from '../shared/desktop-api'

/*
 * Images and PSDs the system asks us to open: from the command line at start, from
 * a second launch (Explorer's 打开方式, or a file dropped on the app's
 * icon), or macOS's open-file. They wait here until the Renderer takes
 * them, since the first ones arrive before it has loaded.
 */

const MIME_BY_EXTENSION: Readonly<Record<string, OpenFileRequest['mimeType']>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.psd': 'image/vnd.adobe.photoshop'
}

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_PSD_BYTES = 1024 * 1024 * 1024
const pending: string[] = []

/** Keeps the arguments that name an image we can open, made absolute; flags and the app path are skipped. */
export function openableFileArguments(argv: readonly string[], workingDirectory: string): readonly string[] {
  return argv
    .filter((argument) => !argument.startsWith('-') && MIME_BY_EXTENSION[extname(argument).toLowerCase()] !== undefined)
    .map((argument) => resolve(workingDirectory, argument))
}

export function queueOpenFiles(paths: readonly string[]): boolean {
  const before = pending.length
  for (const path of paths) if (!pending.includes(path)) pending.push(path)
  return pending.length > before
}

/** Reads and hands over every queued image that still exists and fits; the rest are dropped. */
export async function takeOpenFileRequests(): Promise<readonly OpenFileRequest[]> {
  const paths = pending.splice(0)
  const requests: OpenFileRequest[] = []
  for (const path of paths) {
    const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()]
    if (mimeType === undefined) continue
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > (mimeType === 'image/vnd.adobe.photoshop' ? MAX_PSD_BYTES : MAX_IMAGE_BYTES)) continue
      requests.push({ name: basename(path), mimeType, bytes: new Uint8Array(await readFile(path)) })
    } catch {
      continue
    }
  }
  return requests
}
