import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const ledgerSchema = z.object({
  version: z.literal(1),
  authorization: z.literal('volcengine-ark-g2-2026-08-10'),
  maxRequests: z.literal(5),
  maxImages: z.literal(4),
  maxCostCny: z.literal(5),
  usedRequests: z.number().int().min(0).max(5),
  reservedImages: z.number().int().min(0).max(4),
  reservedCostCny: z.number().min(0).max(5),
  updatedAt: z.string().datetime({ offset: true })
})

export type G2UsageSnapshot = z.infer<typeof ledgerSchema>

const EMPTY_LEDGER: G2UsageSnapshot = {
  version: 1,
  authorization: 'volcengine-ark-g2-2026-08-10',
  maxRequests: 5,
  maxImages: 4,
  maxCostCny: 5,
  usedRequests: 0,
  reservedImages: 0,
  reservedCostCny: 0,
  updatedAt: new Date(0).toISOString()
}

export class G2BudgetExceededError extends Error {
  readonly code = 'G2_BUDGET_EXCEEDED'

  constructor(message: string) {
    super(message)
    this.name = 'G2BudgetExceededError'
  }
}

/** Persistent, crash-safe request/image reservation for the user-approved G2. */
export class G2UsageLedger {
  readonly #filePath: string
  #tail: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async snapshot(): Promise<G2UsageSnapshot> {
    await this.#tail
    return this.#read()
  }

  reserve(input: { readonly requests: 1; readonly images: number; readonly costCeilingCny: number }): Promise<G2UsageSnapshot> {
    const operation = this.#tail.then(async () => {
      if (!Number.isInteger(input.images) || input.images < 0 || input.images > 4) {
        throw new G2BudgetExceededError('G2 image reservation must be an integer between 0 and 4.')
      }
      if (!Number.isFinite(input.costCeilingCny) || input.costCeilingCny <= 0 || input.costCeilingCny > 5) {
        throw new G2BudgetExceededError('G2 cost reservation must be greater than 0 and no more than CNY 5.')
      }
      const current = await this.#read()
      if (current.usedRequests + input.requests > current.maxRequests) {
        throw new G2BudgetExceededError(`G2 request limit reached (${current.usedRequests}/${current.maxRequests}).`)
      }
      if (current.reservedImages + input.images > current.maxImages) {
        throw new G2BudgetExceededError(`G2 image limit would be exceeded (${current.reservedImages}+${input.images}/${current.maxImages}).`)
      }
      const reservedCostCny = Math.round((current.reservedCostCny + input.costCeilingCny) * 100) / 100
      if (reservedCostCny > current.maxCostCny) {
        throw new G2BudgetExceededError(`G2 cost ceiling would be exceeded (CNY ${current.reservedCostCny}+${input.costCeilingCny}/${current.maxCostCny}).`)
      }
      await this.#write({
        ...current,
        usedRequests: current.usedRequests + input.requests,
        reservedImages: current.reservedImages + input.images,
        reservedCostCny,
        updatedAt: new Date().toISOString()
      })
    })
    this.#tail = operation.catch(() => undefined)
    return operation.then(() => this.#read())
  }

  async #read(): Promise<G2UsageSnapshot> {
    try {
      return ledgerSchema.parse(JSON.parse(await readFile(this.#filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_LEDGER)
      throw error
    }
  }

  async #write(value: G2UsageSnapshot): Promise<void> {
    const parsed = ledgerSchema.parse(value)
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
  }
}
