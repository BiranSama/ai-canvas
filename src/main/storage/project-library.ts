import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type {
  ProjectLibraryMigrationReport,
  ProjectLibrarySettings,
  ProjectMigrationItem
} from '../../shared/project'
import { deserializeSceneSnapshot, type Scene } from '../../domain'
import type { AssetMetadata } from './project-repository'

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const PROJECT_SUFFIX = '.aicanvas'
const SETTINGS_SCHEMA = z.object({
  version: z.literal(1),
  rootDirectory: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true })
})

export interface ProjectCoverResult {
  readonly source: 'generated' | 'scene' | 'fallback' | 'none'
  readonly dataUrl: string | null
}

export interface ProjectPackageInspection {
  readonly id: string
  readonly name: string
  readonly scene: Scene
  readonly assets: readonly AssetMetadata[]
  readonly preferredAssetId: string | null
  readonly hasMissingAssets: boolean
}

export interface ProjectLibraryMigrationOptions {
  readonly idFactory?: () => string
  readonly now?: () => string
}

export function sanitizeProjectName(input: string): string {
  const normalized = input
    .normalize('NFKC')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 96)

  if (normalized.length === 0 || WINDOWS_RESERVED_NAME.test(normalized)) return '未命名创作'
  return normalized
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function allocateProjectDirectory(
  libraryDirectory: string,
  suggestedName: string
): Promise<{ readonly directory: string; readonly name: string }> {
  await mkdir(libraryDirectory, { recursive: true })
  const baseName = sanitizeProjectName(suggestedName)
  for (let suffix = 1; suffix <= 9_999; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName} ${suffix}`
    const directory = join(libraryDirectory, `${name}${PROJECT_SUFFIX}`)
    if (!(await pathExists(directory))) return { directory, name }
  }
  throw new Error('项目库中同名项目过多，请换一个名称。')
}

export class LibrarySettingsStore {
  readonly #filePath: string
  readonly #defaultRoot: string
  readonly #now: () => string

  constructor(filePath: string, defaultRoot: string, now: () => string = () => new Date().toISOString()) {
    this.#filePath = filePath
    this.#defaultRoot = resolve(defaultRoot)
    this.#now = now
  }

  async get(): Promise<ProjectLibrarySettings> {
    try {
      return SETTINGS_SCHEMA.parse(JSON.parse(await readFile(this.#filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof SyntaxError === false && error instanceof z.ZodError === false) throw error
      return { rootDirectory: this.#defaultRoot, updatedAt: this.#now() }
    }
  }

  async set(rootDirectory: string): Promise<ProjectLibrarySettings> {
    const settings = SETTINGS_SCHEMA.parse({ version: 1, rootDirectory: resolve(rootDirectory), updatedAt: this.#now() })
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(settings), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
    return { rootDirectory: settings.rootDirectory, updatedAt: settings.updatedAt }
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

async function verifyProjectCopy(source: string, destination: string): Promise<{ readonly assetCount: number; readonly verifiedAssetCount: number }> {
  await inspectProjectPackage(destination)
  const sourceFiles = await listFiles(source)
  const destinationFiles = await listFiles(destination)
  const sourceRelative = sourceFiles.map((file) => relative(source, file)).filter((file) => !/project\.db-(wal|shm)$/i.test(file))
  const destinationRelative = destinationFiles.map((file) => relative(destination, file)).filter((file) => !/project\.db-(wal|shm)$/i.test(file))
  if (sourceRelative.join('\n') !== destinationRelative.join('\n')) throw new Error('Copied project file inventory does not match the source.')
  let verifiedAssetCount = 0
  for (const relativePath of sourceRelative.filter((file) => file.startsWith(`assets${process.platform === 'win32' ? '\\' : '/'}`))) {
    if (await fileSha256(join(source, relativePath)) !== await fileSha256(join(destination, relativePath))) {
      throw new Error(`Asset verification failed: ${relativePath}`)
    }
    verifiedAssetCount += 1
  }
  return { assetCount: sourceRelative.filter((file) => file.includes('assets')).length, verifiedAssetCount }
}

export async function migrateProjectLibrary(
  sourceDirectory: string,
  destinationDirectory: string,
  options: ProjectLibraryMigrationOptions = {}
): Promise<ProjectLibraryMigrationReport> {
  const now = options.now ?? (() => new Date().toISOString())
  const idFactory = options.idFactory ?? randomUUID
  const source = resolve(sourceDirectory)
  const destination = resolve(destinationDirectory)
  if (source.toLocaleLowerCase() === destination.toLocaleLowerCase()) throw new Error('新项目库位置与当前位置相同。')
  await mkdir(destination, { recursive: true })
  const startedAt = now()
  const items: ProjectMigrationItem[] = []
  const entries = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.toLocaleLowerCase().endsWith(PROJECT_SUFFIX))
  for (const entry of entries) {
    const sourceProject = join(source, entry.name)
    const destinationProject = join(destination, entry.name)
    if (await pathExists(destinationProject)) {
      items.push({ projectName: entry.name, status: 'skipped', assetCount: 0, verifiedAssetCount: 0, message: '目标位置已存在同名项目；未覆盖。' })
      continue
    }
    const temporaryProject = join(destination, `.${entry.name}.migrating-${idFactory()}`)
    try {
      await cp(sourceProject, temporaryProject, { recursive: true, errorOnExist: true, force: false })
      const verified = await verifyProjectCopy(sourceProject, temporaryProject)
      await rename(temporaryProject, destinationProject)
      items.push({ projectName: entry.name, status: 'copied', ...verified, message: '复制并校验完成；原项目已保留。' })
    } catch (error) {
      await rm(temporaryProject, { recursive: true, force: true })
      items.push({ projectName: entry.name, status: 'failed', assetCount: 0, verifiedAssetCount: 0, message: error instanceof Error ? error.message : '迁移校验失败。' })
    }
  }
  const switched = items.every((item) => item.status === 'copied')
  return {
    id: idFactory(),
    sourceDirectory: source,
    destinationDirectory: destination,
    startedAt,
    completedAt: now(),
    switched,
    sourcePreserved: true,
    items
  }
}

function safeBackground(color: string): { readonly r: number; readonly g: number; readonly b: number; readonly alpha: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (match === null) return { r: 224, g: 230, b: 238, alpha: 1 }
  const value = Number.parseInt(match[1] ?? 'E0E6EE', 16)
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255, alpha: 1 }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}

function sceneCoverSvg(scene: Scene): Buffer {
  const width = 720
  const height = 540
  const background = /^#[0-9a-f]{6}$/i.test(scene.canvas.backgroundColor) ? scene.canvas.backgroundColor : '#E2E8EF'
  const elements = scene.elements.filter((element) => element.visible).map((element) => {
    const x = Math.round(element.transform.x * width)
    const y = Math.round(element.transform.y * height)
    const elementWidth = Math.max(4, Math.round(element.transform.width * width))
    const elementHeight = Math.max(4, Math.round(element.transform.height * height))
    const opacity = Math.max(.08, element.opacity)
    if (element.type === 'text') {
      const fontSize = Math.max(12, Math.min(72, Math.round(element.fontSize * .42)))
      return `<text x="${x + elementWidth / 2}" y="${y + elementHeight / 2}" dominant-baseline="middle" text-anchor="middle" fill="${escapeXml(element.fill)}" opacity="${opacity}" font-family="serif" font-size="${fontSize}" letter-spacing="${Math.max(0, element.letterSpacing * .3)}">${escapeXml(element.content.slice(0, 48))}</text>`
    }
    if (element.type === 'shape') {
      if (element.shape === 'ellipse') return `<ellipse cx="${x + elementWidth / 2}" cy="${y + elementHeight / 2}" rx="${elementWidth / 2}" ry="${elementHeight / 2}" fill="${escapeXml(element.fill)}" opacity="${opacity}" />`
      if (element.shape === 'line') return `<line x1="${x}" y1="${y + elementHeight}" x2="${x + elementWidth}" y2="${y}" stroke="${escapeXml(element.stroke ?? element.fill)}" stroke-width="2" opacity="${opacity}" />`
      return `<rect x="${x}" y="${y}" width="${elementWidth}" height="${elementHeight}" rx="${Math.round(element.cornerRadius * Math.min(elementWidth, elementHeight))}" fill="${escapeXml(element.fill)}" opacity="${opacity}" />`
    }
    if (element.type === 'sketch') {
      return element.strokes.slice(0, 80).map((stroke) => `<polyline points="${stroke.points.slice(0, 500).map((point) => `${Math.round((element.transform.x + point.x * element.transform.width) * width)},${Math.round((element.transform.y + point.y * element.transform.height) * height)}`).join(' ')}" fill="none" stroke="${escapeXml(stroke.color)}" stroke-width="${Math.max(1, stroke.width * width)}" opacity="${stroke.opacity * opacity}" stroke-linecap="round" stroke-linejoin="round" />`).join('')
    }
    if (element.type === 'light') return `<ellipse cx="${x + elementWidth / 2}" cy="${y + elementHeight / 2}" rx="${elementWidth / 2}" ry="${elementHeight / 2}" fill="${escapeXml(element.color)}" opacity="${element.intensity * .38}" filter="url(#soft)" />`
    if (element.type === 'placeholder') return `<rect x="${x}" y="${y}" width="${elementWidth}" height="${elementHeight}" rx="${element.frameShape === 'ellipse' ? elementHeight / 2 : 18}" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.58)" stroke-width="2" stroke-dasharray="9 8" opacity="${opacity}" /><text x="${x + 14}" y="${y + 26}" fill="rgba(255,255,255,.72)" font-size="13">${escapeXml(element.subject.slice(0, 28))}</text>`
    return `<rect x="${x}" y="${y}" width="${elementWidth}" height="${elementHeight}" rx="12" fill="rgba(255,255,255,.1)" stroke="rgba(255,255,255,.34)" opacity="${opacity}" />`
  }).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><radialGradient id="wash" cx="72%" cy="18%"><stop offset="0" stop-color="rgba(255,255,255,.34)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="30"/></filter></defs><rect width="720" height="540" fill="${escapeXml(background)}"/><rect width="720" height="540" fill="url(#wash)"/>${elements}</svg>`)
}

async function readCover(filePath: string): Promise<ProjectCoverResult | null> {
  try {
    const bytes = await readFile(filePath)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if ((metadata.width ?? 0) <= 0 || (metadata.height ?? 0) <= 0) throw new Error('Invalid cover cache.')
    return { source: 'scene', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }
  } catch {
    return null
  }
}

export async function rebuildProjectCover(
  projectDirectory: string,
  scene: Scene,
  assets: readonly AssetMetadata[],
  preferredAssetId: string | null = null,
  refresh = false
): Promise<ProjectCoverResult> {
  const previewDirectory = join(projectDirectory, 'preview')
  const coverPath = join(previewDirectory, 'cover.webp')
  const cached = refresh ? null : await readCover(coverPath)
  if (cached !== null) return cached
  const candidates = [
    ...(preferredAssetId === null ? [] : assets.filter((asset) => asset.id === preferredAssetId)),
    ...assets.filter((asset) => asset.sourceType === 'generated' && asset.id !== preferredAssetId),
    ...assets.filter((asset) => asset.status === 'available' && asset.id !== preferredAssetId)
  ]
  let source: ProjectCoverResult['source']
  let cover: ReturnType<typeof sharp>
  const selected = candidates.find((asset) => asset.status === 'available')
  if (selected !== undefined) {
    try {
      cover = sharp(await readFile(join(projectDirectory, selected.thumbnailRelativePath)), { failOn: 'error' })
      source = selected.sourceType === 'generated' ? 'generated' : 'scene'
    } catch {
      cover = scene.elements.length > 0
        ? sharp(sceneCoverSvg(scene))
        : sharp({ create: { width: 720, height: 540, channels: 4, background: safeBackground(scene.canvas.backgroundColor) } })
      source = 'fallback'
    }
  } else if (scene.elements.length > 0) {
    cover = sharp(sceneCoverSvg(scene))
    source = 'fallback'
  } else {
    return { source: 'none', dataUrl: null }
  }
  await mkdir(previewDirectory, { recursive: true })
  const temporaryPath = join(previewDirectory, `cover.${randomUUID()}.tmp.webp`)
  await cover.resize({ width: 720, height: 540, fit: 'cover', position: 'attention' }).webp({ quality: 78 }).toFile(temporaryPath)
  await rename(temporaryPath, coverPath)
  return { source, dataUrl: `data:image/webp;base64,${(await readFile(coverPath)).toString('base64')}` }
}

export async function projectPackageStatus(projectDirectory: string): Promise<'ready' | 'missing' | 'damaged'> {
  try {
    if (!(await stat(projectDirectory)).isDirectory()) return 'missing'
    if (!(await stat(join(projectDirectory, 'project.db'))).isFile()) return 'damaged'
    return 'ready'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'damaged'
  }
}

export async function inspectProjectPackage(projectDirectory: string): Promise<ProjectPackageInspection> {
  const databasePath = join(projectDirectory, 'project.db')
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const project = database.prepare('SELECT id, name FROM projects LIMIT 1').get() as { id: string; name: string } | undefined
    if (project === undefined) throw new Error('Project metadata is missing.')
    const snapshots = database.prepare('SELECT scene_json FROM scene_snapshots ORDER BY created_at DESC, scene_revision DESC').all() as Array<{ scene_json: string }>
    let scene: Scene | null = null
    for (const snapshot of snapshots) {
      try {
        scene = deserializeSceneSnapshot(snapshot.scene_json)
        break
      } catch {
        // A card may fall back to an older immutable snapshot without mutating the project.
      }
    }
    if (scene === null) throw new Error('No valid scene snapshot is available.')
    const rows = database.prepare('SELECT * FROM assets ORDER BY created_at ASC').all() as Array<{
      id: string
      project_id: string
      relative_path: string
      thumbnail_relative_path: string
      content_hash: string
      width: number
      height: number
      format: AssetMetadata['format']
      has_alpha: number
      source_type: AssetMetadata['sourceType']
      source_id: string | null
      status: AssetMetadata['status']
      created_at: string
    }>
    const assets: AssetMetadata[] = rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      relativePath: row.relative_path,
      thumbnailRelativePath: row.thumbnail_relative_path,
      contentHash: row.content_hash,
      width: row.width,
      height: row.height,
      format: row.format,
      hasAlpha: row.has_alpha === 1,
      sourceType: row.source_type,
      sourceId: row.source_id,
      status: row.status,
      createdAt: row.created_at
    }))
    let hasMissingAssets = false
    for (const asset of assets) {
      if (
        asset.status === 'missing' ||
        !(await pathExists(join(projectDirectory, asset.relativePath))) ||
        !(await pathExists(join(projectDirectory, asset.thumbnailRelativePath)))
      ) {
        hasMissingAssets = true
        break
      }
    }
    const preferred = database.prepare(`
      SELECT asset_id FROM generation_results
      WHERE project_id = ?
      ORDER BY favorite DESC, created_at DESC, variant_index ASC LIMIT 1
    `).get(project.id) as { asset_id: string } | undefined
    return {
      id: project.id,
      name: project.name,
      scene,
      assets,
      preferredAssetId: preferred?.asset_id ?? null,
      hasMissingAssets
    }
  } finally {
    database.close()
  }
}

export function isProjectPackageDirectory(path: string): boolean {
  return basename(path).toLocaleLowerCase().endsWith(PROJECT_SUFFIX)
}
