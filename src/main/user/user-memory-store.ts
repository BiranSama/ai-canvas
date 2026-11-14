import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import {
  brandKitInputSchema,
  brandLogoInputSchema,
  CANDIDATES_PER_SUMMARY,
  emptyUserMemoryFile,
  MAX_PREFERENCE_SIGNALS,
  MAX_PROJECTS_WITHOUT_BRAND,
  MAX_USER_MEMORIES,
  SIGNALS_PER_SUMMARY,
  userMemoryChangeSchema,
  userMemoryFileSchema,
  userMemorySnapshotSchema,
  type BackgroundModelUsage,
  type BrandKit,
  type BrandKitInput,
  type PreferenceSignal,
  type PreferenceSignalKind,
  type UserMemoryCandidate,
  type UserMemoryChange,
  type UserMemoryEntry,
  type UserMemoryFile,
  type UserMemoryKind,
  type UserMemorySnapshot
} from '../../shared/user-memory'

/*
 * The person's brand and cross-project memory, in one JSON file under the
 * app's data folder, and the logo beside it. Writes go one after another and
 * replace the file whole; a file that cannot be read is set aside, so a bad
 * write never keeps the app from starting.
 */

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const

export class UserMemoryStore {
  readonly #filePath: string
  readonly #brandDirectory: string
  #cache: UserMemoryFile | null = null
  #writeChain: Promise<unknown> = Promise.resolve()
  readonly #listeners = new Set<() => void>()

  constructor(filePath: string, brandDirectory = join(dirname(filePath), '..', 'brand')) {
    this.#filePath = filePath
    this.#brandDirectory = brandDirectory
  }

  /** Called after every change, for the settings page and the canvas to refresh. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async read(): Promise<UserMemoryFile> {
    await this.#writeChain.catch(() => undefined)
    return this.#load()
  }

  /** What the settings page shows; `projectId` is the open project, for its 使用品牌 switch. */
  async snapshot(projectId: string | null = null): Promise<UserMemorySnapshot> {
    const file = await this.read()
    return userMemorySnapshotSchema.parse({
      brand: file.brand,
      logoPreview: await this.#logoPreview(file.brand),
      memories: file.memories,
      candidates: file.candidates,
      learning: { enabled: file.learning.enabled, signals: file.signals.length, newSignals: file.learning.newSignals, lastSummaryAt: file.learning.lastSummaryAt },
      backgroundUsage: file.backgroundUsage,
      projectUsesBrand: projectId === null || !file.projectsWithoutBrand.includes(projectId)
    })
  }

  /** Whether this project's turns and editor use the brand. */
  async projectUsesBrand(projectId: string): Promise<boolean> {
    return !(await this.read()).projectsWithoutBrand.includes(projectId)
  }

  async saveBrand(input: BrandKitInput): Promise<void> {
    const fields = brandKitInputSchema.parse(input)
    await this.#mutate((file) => ({ ...file, brand: { ...fields, logo: file.brand.logo } }))
  }

  async setLogo(input: { readonly mimeType: string; readonly bytes: Uint8Array }): Promise<void> {
    const { mimeType, bytes } = brandLogoInputSchema.parse(input)
    const metadata = await sharp(bytes).metadata().catch(() => null)
    if (metadata?.width === undefined || metadata.height === undefined) throw new Error('这张图片读不出来，换一张 PNG、JPG 或 WebP。')
    const fileName = `logo-${randomUUID()}.${EXTENSIONS[mimeType]}`
    await mkdir(this.#brandDirectory, { recursive: true })
    await writeFile(join(this.#brandDirectory, fileName), bytes)
    const replaced: { fileName: string | null } = { fileName: null }
    await this.#mutate((file) => {
      replaced.fileName = file.brand.logo?.fileName ?? null
      return { ...file, brand: { ...file.brand, logo: { fileName, mimeType, width: metadata.width!, height: metadata.height!, updatedAt: new Date().toISOString() } } }
    })
    if (replaced.fileName !== null) await this.#removeLogoFile(replaced.fileName)
  }

  async clearLogo(): Promise<void> {
    const removed: { fileName: string | null } = { fileName: null }
    await this.#mutate((file) => {
      removed.fileName = file.brand.logo?.fileName ?? null
      return file.brand.logo === null ? file : { ...file, brand: { ...file.brand, logo: null } }
    })
    if (removed.fileName !== null) await this.#removeLogoFile(removed.fileName)
  }

  async change(input: UserMemoryChange): Promise<void> {
    const change = userMemoryChangeSchema.parse(input)
    const now = new Date().toISOString()
    await this.#mutate((file) => {
      switch (change.action) {
        case 'add':
          return { ...file, memories: withMemory(file.memories, { id: randomUUID(), kind: change.kind, content: change.content, source: 'user', enabled: true, createdAt: now, updatedAt: now }) }
        case 'edit':
          return { ...file, memories: file.memories.map((entry) => entry.id === change.id ? { ...entry, kind: change.kind, content: change.content, updatedAt: now } : entry) }
        case 'enable':
          return { ...file, memories: file.memories.map((entry) => entry.id === change.id ? { ...entry, enabled: change.enabled, updatedAt: now } : entry) }
        case 'remove':
          return { ...file, memories: file.memories.filter((entry) => entry.id !== change.id) }
        case 'confirm': {
          const candidate = file.candidates.find((entry) => entry.id === change.id && entry.status === 'pending')
          if (candidate === undefined) return file
          return {
            ...file,
            memories: withMemory(file.memories, { id: randomUUID(), kind: candidate.kind, content: candidate.content, source: candidate.source, enabled: true, createdAt: now, updatedAt: now }),
            candidates: file.candidates.map((entry) => entry.id === change.id ? { ...entry, status: 'confirmed' } : entry)
          }
        }
        case 'ignore':
          return { ...file, candidates: file.candidates.map((entry) => entry.id === change.id && entry.status === 'pending' ? { ...entry, status: 'ignored' } : entry) }
        case 'learning':
          return { ...file, learning: { ...file.learning, enabled: change.enabled } }
        case 'clear-signals':
          return { ...file, signals: [], learning: { ...file.learning, newSignals: 0 } }
        case 'project-brand': {
          const others = file.projectsWithoutBrand.filter((id) => id !== change.projectId)
          return { ...file, projectsWithoutBrand: change.enabled ? others : [...others, change.projectId].slice(-MAX_PROJECTS_WITHOUT_BRAND) }
        }
      }
    })
  }

  /**
   * A candidate for the person to confirm: proposed by the Agent, or learned.
   * One already kept, pending or ignored with the same words is not offered
   * again. Returns the candidate, or null when it was not added.
   */
  async propose(kind: UserMemoryKind, content: string, source: UserMemoryCandidate['source']): Promise<UserMemoryCandidate | null> {
    const text = content.trim()
    if (text === '') return null
    const result: { added: UserMemoryCandidate | null } = { added: null }
    await this.#mutate((file) => {
      const same = (value: string): boolean => value.trim() === text
      if (file.memories.some((entry) => same(entry.content)) || file.candidates.some((entry) => same(entry.content))) return file
      const added: UserMemoryCandidate = { id: randomUUID(), kind, content: text.slice(0, 1_000), source, status: 'pending', createdAt: new Date().toISOString() }
      result.added = added
      // Settled candidates make room first: the newest are kept.
      const candidates = [...file.candidates, added]
      while (candidates.length > MAX_USER_MEMORIES) {
        const settled = candidates.findIndex((entry) => entry.status !== 'pending')
        candidates.splice(settled < 0 ? 0 : settled, 1)
      }
      return { ...file, candidates }
    })
    return result.added
  }

  /** Records what the person did; true when enough has gathered since the last summary to make one. */
  async recordSignal(kind: PreferenceSignalKind, text: string, projectId?: string): Promise<boolean> {
    const line = text.trim().slice(0, 300)
    if (line === '') return false
    const result = { due: false }
    await this.#mutate((file) => {
      if (!file.learning.enabled) return file
      const signal: PreferenceSignal = { kind, text: line, at: new Date().toISOString(), ...(projectId === undefined ? {} : { projectId }) }
      const newSignals = file.learning.newSignals + 1
      result.due = newSignals >= SIGNALS_PER_SUMMARY
      return { ...file, signals: [...file.signals, signal].slice(-MAX_PREFERENCE_SIGNALS), learning: { ...file.learning, newSignals } }
    })
    return result.due
  }

  /** Forgets the signals a project recorded, as when it turns to 仅本地; they never leave this computer after that. */
  async dropProjectSignals(projectId: string): Promise<void> {
    await this.#mutate((file) => {
      const kept = file.signals.filter((signal) => signal.projectId !== projectId)
      if (kept.length === file.signals.length) return file
      const dropped = file.signals.length - kept.length
      return { ...file, signals: kept, learning: { ...file.learning, newSignals: Math.max(0, file.learning.newSignals - dropped) } }
    })
  }

  /** The signals a summary works from: the newest, and the preferences already kept, so it does not repeat them. */
  async summaryInput(): Promise<{ readonly signals: readonly PreferenceSignal[]; readonly kept: readonly string[]; readonly enabled: boolean }> {
    const file = await this.read()
    return { signals: file.signals.slice(-60), kept: [...file.memories.map((entry) => entry.content), ...file.candidates.map((entry) => entry.content)], enabled: file.learning.enabled }
  }

  /** Files a summary's candidates and starts counting new signals again. */
  async summarized(candidates: readonly { readonly kind: UserMemoryKind; readonly content: string }[]): Promise<readonly UserMemoryCandidate[]> {
    await this.#mutate((file) => ({ ...file, learning: { ...file.learning, newSignals: 0, lastSummaryAt: new Date().toISOString() } }))
    const added: UserMemoryCandidate[] = []
    for (const candidate of candidates.slice(0, CANDIDATES_PER_SUMMARY)) {
      const filed = await this.propose(candidate.kind, candidate.content, 'learned')
      if (filed !== null) added.push(filed)
    }
    return added
  }

  async recordBackgroundUsage(usage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostCny: number | null }): Promise<void> {
    await this.#mutate((file) => {
      const total: BackgroundModelUsage = {
        calls: file.backgroundUsage.calls + 1,
        inputTokens: file.backgroundUsage.inputTokens + Math.max(0, Math.round(usage.inputTokens)),
        outputTokens: file.backgroundUsage.outputTokens + Math.max(0, Math.round(usage.outputTokens)),
        estimatedCostCny: file.backgroundUsage.estimatedCostCny === null || usage.estimatedCostCny === null ? null : file.backgroundUsage.estimatedCostCny + usage.estimatedCostCny
      }
      return { ...file, backgroundUsage: total }
    })
  }

  async #load(): Promise<UserMemoryFile> {
    if (this.#cache !== null) return this.#cache
    try {
      this.#cache = userMemoryFileSchema.parse(JSON.parse(await readFile(this.#filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Kept for a person to look at, out of the way of a fresh start.
        await rename(this.#filePath, `${this.#filePath}.unreadable-${Date.now()}`).catch(() => undefined)
      }
      this.#cache = emptyUserMemoryFile()
    }
    return this.#cache
  }

  #mutate(change: (file: UserMemoryFile) => UserMemoryFile): Promise<void> {
    const next = this.#writeChain.catch(() => undefined).then(async () => {
      const current = await this.#load()
      const changed = change(current)
      if (changed === current) return
      const updated = userMemoryFileSchema.parse(changed)
      await mkdir(dirname(this.#filePath), { recursive: true })
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
      await rename(temporary, this.#filePath)
      this.#cache = updated
      for (const listener of this.#listeners) listener()
    })
    this.#writeChain = next
    return next
  }

  /**
   * A logo file's bytes. sharp is always given bytes, never the path: given a
   * path, libvips keeps the file open in its cache, and on Windows an open
   * file cannot be deleted, so replacing or removing the logo would fail.
   */
  readLogo(fileName: string): Promise<Buffer> {
    return readFile(join(this.#brandDirectory, fileName))
  }

  /** The record no longer names this file; one that cannot go now is left behind rather than failing the change. */
  async #removeLogoFile(fileName: string): Promise<void> {
    await rm(join(this.#brandDirectory, fileName), { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  }

  async #logoPreview(brand: BrandKit): Promise<string | null> {
    if (brand.logo === null) return null
    try {
      const bytes = await sharp(await this.readLogo(brand.logo.fileName)).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      return `data:image/png;base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }
}

function withMemory(memories: readonly UserMemoryEntry[], entry: UserMemoryEntry): UserMemoryEntry[] {
  // The oldest go first when the list is full.
  return [...memories, entry].slice(-MAX_USER_MEMORIES)
}
