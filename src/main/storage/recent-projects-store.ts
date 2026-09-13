import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const recentProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  lastOpenedAt: z.string().datetime({ offset: true }),
  aspectLabel: z.string().min(1).max(32).default('自由画布'),
  favorite: z.boolean().default(false),
  coverSource: z.enum(['generated', 'scene', 'fallback', 'none']).default('none')
})

const recentProjectsSchema = z.object({
  version: z.literal(1),
  projects: z.array(recentProjectSchema).max(20)
})

export type RecentProject = z.infer<typeof recentProjectsSchema>['projects'][number]
type RecentProjectInput = z.input<typeof recentProjectSchema>

export class RecentProjectsStore {
  readonly #filePath: string
  #writeChain = Promise.resolve()

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async list(): Promise<readonly RecentProject[]> {
    await this.#writeChain
    return this.#read()
  }

  async #read(): Promise<readonly RecentProject[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#filePath, 'utf8'))
      return recentProjectsSchema.parse(value).projects
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      // A corrupt convenience index must not prevent opening project data directly.
      return []
    }
  }

  async record(input: RecentProjectInput): Promise<void> {
    await this.#mutate(async (current) => {
      const existing = current.find((entry) => entry.id === input.id || entry.path === input.path)
      const project = recentProjectSchema.parse({
        ...input,
        aspectLabel: input.aspectLabel ?? existing?.aspectLabel,
        favorite: input.favorite ?? existing?.favorite,
        coverSource: input.coverSource ?? existing?.coverSource
      })
      return [project, ...current.filter((entry) => entry.id !== project.id && entry.path !== project.path)].slice(0, 20)
    })
  }

  async update(projectId: string, update: Partial<Pick<RecentProject, 'path' | 'name' | 'lastOpenedAt' | 'aspectLabel' | 'favorite' | 'coverSource'>>): Promise<RecentProject> {
    let result: RecentProject | null = null
    await this.#mutate(async (current) => {
      const index = current.findIndex((entry) => entry.id === projectId)
      if (index < 0) throw new Error('The selected recent project is no longer indexed.')
      const existing = current[index]
      if (existing === undefined) throw new Error('The selected recent project is no longer indexed.')
      const next = recentProjectSchema.parse({ ...existing, ...update })
      result = next
      const projects = [...current]
      projects[index] = next
      return projects
    })
    if (result === null) throw new Error('The selected recent project could not be updated.')
    return result
  }

  async setFavorite(projectId: string, favorite: boolean): Promise<RecentProject> {
    return this.update(projectId, { favorite })
  }

  async remove(projectId: string): Promise<RecentProject> {
    let removed: RecentProject | null = null
    await this.#mutate(async (current) => {
      const project = current.find((entry) => entry.id === projectId)
      if (project === undefined) throw new Error('The selected recent project is no longer indexed.')
      removed = project
      return current.filter((entry) => entry.id !== projectId)
    })
    if (removed === null) throw new Error('The selected recent project could not be removed.')
    return removed
  }

  async relocatePaths(relocations: ReadonlyMap<string, string>): Promise<void> {
    await this.#mutate(async (current) => current.map((project) => {
      const path = relocations.get(project.path)
      return path === undefined ? project : recentProjectSchema.parse({ ...project, path })
    }))
  }

  async #mutate(update: (current: readonly RecentProject[]) => Promise<readonly RecentProject[]>): Promise<void> {
    const operation = this.#writeChain.then(async () => this.#write(await update(await this.#read())))
    this.#writeChain = operation.catch(() => undefined)
    return operation
  }

  async #write(projects: readonly RecentProject[]): Promise<void> {
    const value = recentProjectsSchema.parse({ version: 1, projects })
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
  }
}
