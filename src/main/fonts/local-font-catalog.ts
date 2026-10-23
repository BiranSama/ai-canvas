import type { Dirent } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalFontFamily } from '../../shared/local-fonts'

/** One face as its name and OS/2 tables describe it. */
export interface FontFaceNames {
  readonly family: string
  readonly localName: string | null
  readonly style: string
  readonly chinese: boolean
}

const FONT_FILE = /\.(?:ttf|otf|ttc|otc)$/i
const MAX_DEPTH = 5
const MAX_FILES = 20_000
const MAX_FACES_PER_COLLECTION = 64
const MAX_NAME_TABLE_BYTES = 512 * 1024
const PARALLEL_READS = 32

const ENGLISH = 0x0409
/** Simplified Chinese first, then Singapore, Taiwan, Hong Kong and Macao. */
const CHINESE = [0x0804, 0x1004, 0x0404, 0x0c04, 0x1404]
/** OS/2 code page bits for GB 936 and Big5 950. */
const CHINESE_CODE_PAGES = (1 << 18) | (1 << 20)

/** Where each system keeps installed fonts, the user's own folders included. */
export function systemFontDirectories(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = homedir()
  if (platform === 'win32') {
    return [
      join(environment.WINDIR ?? 'C:\\Windows', 'Fonts'),
      ...(environment.LOCALAPPDATA === undefined ? [] : [join(environment.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')])
    ]
  }
  if (platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')]
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local', 'share', 'fonts'), join(home, '.fonts')]
}

interface NameRecord {
  readonly platform: number
  readonly language: number
  readonly nameId: number
  readonly value: string
}

function decodeName(bytes: Buffer, platform: number, encoding: number): string | null {
  if (platform === 0 || platform === 3) {
    const swapped = Buffer.alloc(bytes.length - (bytes.length % 2))
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      swapped[index] = bytes[index + 1]!
      swapped[index + 1] = bytes[index]!
    }
    return swapped.toString('utf16le')
  }
  // Mac Roman only; other Mac encodings hold names the Windows records repeat.
  return platform === 1 && encoding === 0 ? bytes.toString('latin1') : null
}

function nameRecords(table: Buffer): readonly NameRecord[] {
  if (table.length < 6) return []
  const count = table.readUInt16BE(2)
  const storage = table.readUInt16BE(4)
  const records: NameRecord[] = []
  for (let index = 0; index < count && 6 + index * 12 + 12 <= table.length; index += 1) {
    const at = 6 + index * 12
    const nameId = table.readUInt16BE(at + 6)
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue
    const start = storage + table.readUInt16BE(at + 10)
    const end = start + table.readUInt16BE(at + 8)
    if (end > table.length) continue
    const value = decodeName(table.subarray(start, end), table.readUInt16BE(at), table.readUInt16BE(at + 2))?.replace(/\0/g, '').trim()
    if (value) records.push({ platform: table.readUInt16BE(at), language: table.readUInt16BE(at + 4), nameId, value })
  }
  return records
}

/** The first record found, trying name IDs in order (a typographic name before its legacy one). */
function pick(records: readonly NameRecord[], nameIds: readonly number[], accept: (record: NameRecord) => boolean): string | null {
  for (const nameId of nameIds) {
    const found = records.find((record) => record.nameId === nameId && accept(record))
    if (found !== undefined) return found.value
  }
  return null
}

/** Reads a face's names from its name table and its Chinese coverage from OS/2. */
export function faceNames(nameTable: Buffer, os2Table: Buffer | null): FontFaceNames | null {
  const records = nameRecords(nameTable)
  const family = pick(records, [16, 1], (record) => record.platform === 3 && record.language === ENGLISH)
    ?? pick(records, [16, 1], (record) => record.platform === 3 || record.platform === 0)
    ?? pick(records, [16, 1], (record) => record.platform === 1)
  if (family === null || family.startsWith('.')) return null
  let localName: string | null = null
  for (const language of CHINESE) {
    localName = pick(records, [16, 1], (record) => record.platform === 3 && record.language === language)
    if (localName !== null) break
  }
  const style = pick(records, [17, 2], (record) => record.platform === 3 && record.language === ENGLISH)
    ?? pick(records, [17, 2], () => true)
    ?? 'Regular'
  const codePages = os2Table !== null && os2Table.length >= 82 && os2Table.readUInt16BE(0) >= 1 ? os2Table.readUInt32BE(78) : 0
  return {
    family,
    localName: localName === null || localName === family ? null : localName,
    style,
    chinese: (codePages & CHINESE_CODE_PAGES) !== 0 || localName !== null
  }
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

async function readFace(file: FileHandle, offset: number): Promise<FontFaceNames | null> {
  const header = await readAt(file, offset, 12)
  if (header.length < 12) return null
  const tables = Math.min(header.readUInt16BE(4), 512)
  const directory = await readAt(file, offset + 12, tables * 16)
  let name: { offset: number; length: number } | null = null
  let os2: { offset: number; length: number } | null = null
  for (let index = 0; index + 16 <= directory.length; index += 16) {
    const tag = directory.toString('latin1', index, index + 4)
    const entry = { offset: directory.readUInt32BE(index + 8), length: directory.readUInt32BE(index + 12) }
    if (tag === 'name') name = entry
    else if (tag === 'OS/2') os2 = entry
  }
  if (name === null || name.length > MAX_NAME_TABLE_BYTES) return null
  return faceNames(await readAt(file, name.offset, name.length), os2 === null ? null : await readAt(file, os2.offset, Math.min(os2.length, 96)))
}

/** Every face in a font file; a collection (.ttc) holds several. Unreadable files give none. */
export async function readFontFile(path: string): Promise<readonly FontFaceNames[]> {
  let file: FileHandle | null = null
  try {
    file = await open(path, 'r')
    const head = await readAt(file, 0, 12)
    if (head.length < 12) return []
    let offsets = [0]
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const table = await readAt(file, 12, Math.min(head.readUInt32BE(8), MAX_FACES_PER_COLLECTION) * 4)
      offsets = Array.from({ length: Math.floor(table.length / 4) }, (_value, index) => table.readUInt32BE(index * 4))
    }
    const faces: FontFaceNames[] = []
    for (const offset of offsets) {
      const face = await readFace(file, offset)
      if (face !== null) faces.push(face)
    }
    return faces
  } catch {
    return []
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function fontFiles(directories: readonly string[]): Promise<readonly string[]> {
  const found: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && FONT_FILE.test(entry.name)) found.push(path)
    }
  }
  for (const directory of directories) await walk(directory, 0)
  return found
}

/** Faces grouped into families, sorted by family name. */
export function groupFontFaces(faces: readonly FontFaceNames[]): readonly LocalFontFamily[] {
  const families = new Map<string, { family: string; localName: string | null; styles: Set<string>; chinese: boolean }>()
  for (const face of faces) {
    const key = face.family.toLowerCase()
    const existing = families.get(key)
    if (existing === undefined) {
      families.set(key, { family: face.family, localName: face.localName, styles: new Set([face.style]), chinese: face.chinese })
    } else {
      existing.styles.add(face.style)
      existing.localName ??= face.localName
      existing.chinese ||= face.chinese
    }
  }
  return [...families.values()]
    .map((family) => ({ ...family, styles: [...family.styles].sort() }))
    .sort((left, right) => left.family.localeCompare(right.family, 'en'))
}

/** Scans the font folders once per run; installing a font shows up after a restart or a rescan. */
export class LocalFontCatalog {
  readonly #directories: () => readonly string[]
  #scan: Promise<readonly LocalFontFamily[]> | null = null

  constructor(directories: () => readonly string[] = () => systemFontDirectories()) {
    this.#directories = directories
  }

  list(options: { readonly rescan?: boolean } = {}): Promise<readonly LocalFontFamily[]> {
    if (this.#scan === null || options.rescan === true) this.#scan = this.#read()
    return this.#scan
  }

  async #read(): Promise<readonly LocalFontFamily[]> {
    const files = await fontFiles(this.#directories())
    const faces: FontFaceNames[] = []
    for (let start = 0; start < files.length; start += PARALLEL_READS) {
      for (const read of await Promise.all(files.slice(start, start + PARALLEL_READS).map(readFontFile))) faces.push(...read)
    }
    return groupFontFaces(faces)
  }
}

/** The catalog of this computer's fonts, shared by the settings UI and the agent. */
export const localFontCatalog = new LocalFontCatalog()
