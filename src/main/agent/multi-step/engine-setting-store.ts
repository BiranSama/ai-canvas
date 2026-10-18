import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { agentEngineSchema, type AgentEngine } from '../../../shared/agent-engine'

const fileSchema = z.object({ version: z.literal(1), engine: agentEngineSchema }).strict()

/** The owner's agent-engine choice, kept with the other per-user state files. */
export class AgentEngineSettingStore {
  readonly #filePath: string

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async get(): Promise<AgentEngine> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.#filePath, 'utf8'))).engine
    } catch {
      return 'plan-once'
    }
  }

  async set(engine: AgentEngine): Promise<AgentEngine> {
    const value = fileSchema.parse({ version: 1, engine })
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
    return value.engine
  }
}
