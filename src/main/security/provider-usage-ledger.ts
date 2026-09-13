import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ProviderConfigFile, ProviderExecutionPolicy } from '../../shared/provider-settings'

const scopeSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  requests: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  reservedCostCny: z.number().nonnegative(),
  updatedAt: z.string().datetime({ offset: true })
})

const ledgerSchema = z.object({
  version: z.literal(1),
  scopes: z.record(z.string().trim().min(1).max(240), scopeSchema)
})

export interface ProviderUsageReservation {
  readonly scopeId: string
  readonly providerId: string
  readonly requests: number
  readonly images: number
  readonly costCeilingCny: number
}

export type ProviderUsageSnapshot = z.infer<typeof scopeSchema>
export type ProviderUsageScopeSnapshot = ProviderUsageSnapshot & { readonly scopeId: string }

interface ProviderExecutionPolicySource {
  read(): Promise<ProviderConfigFile>
}

export class ProviderBudgetExceededError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProviderBudgetExceededError'
    this.code = code
  }
}

export class ProviderUsageLedger {
  readonly #filePath: string
  readonly #policySource: ProviderExecutionPolicySource
  #chain = Promise.resolve()

  constructor(filePath: string, policySource: ProviderExecutionPolicySource) {
    this.#filePath = filePath
    this.#policySource = policySource
  }

  reserve(input: ProviderUsageReservation, frozenPolicy?: ProviderExecutionPolicy): Promise<ProviderUsageSnapshot> {
    const task = this.#chain.then(async () => {
      const scopeId = z.string().trim().min(1).max(240).parse(input.scopeId)
      const providerId = z.string().trim().min(1).max(200).parse(input.providerId)
      const requests = z.number().int().min(0).max(100).parse(input.requests)
      const images = z.number().int().min(0).max(16).parse(input.images)
      const costCeilingCny = z.number().min(0).max(100_000).parse(input.costCeilingCny)
      const policy = frozenPolicy ?? (await this.#policySource.read()).executionPolicy
      const ledger = await this.#read()
      const previous = ledger.scopes[scopeId] ?? {
        providerId, requests: 0, images: 0, reservedCostCny: 0, updatedAt: new Date(0).toISOString()
      }
      if (previous.providerId !== providerId) {
        throw new ProviderBudgetExceededError('PROVIDER_SCOPE_CONFLICT', 'A provider budget scope cannot be reused by a different provider.')
      }
      if (previous.requests + requests > policy.maxRequestsPerJob) {
        throw new ProviderBudgetExceededError(
          'PROVIDER_REQUEST_BUDGET_EXCEEDED',
          `This task exceeds its ${policy.maxRequestsPerJob}-request limit.`
        )
      }
      if (previous.images + images > policy.maxImagesPerJob) {
        throw new ProviderBudgetExceededError(
          'PROVIDER_IMAGE_BUDGET_EXCEEDED',
          `This task exceeds its ${policy.maxImagesPerJob}-image limit.`
        )
      }
      if (previous.reservedCostCny + costCeilingCny > policy.maxCostCnyPerJob) {
        throw new ProviderBudgetExceededError(
          'PROVIDER_COST_BUDGET_EXCEEDED',
          `This task exceeds its CNY ${policy.maxCostCnyPerJob.toFixed(2)} estimated-cost limit.`
        )
      }
      const next = scopeSchema.parse({
        providerId,
        requests: previous.requests + requests,
        images: previous.images + images,
        reservedCostCny: Number((previous.reservedCostCny + costCeilingCny).toFixed(4)),
        updatedAt: new Date().toISOString()
      })
      await this.#write({ version: 1, scopes: { ...ledger.scopes, [scopeId]: next } })
      return next
    })
    this.#chain = task.then(() => undefined, () => undefined)
    return task
  }

  async snapshot(scopeId: string): Promise<ProviderUsageSnapshot | null> {
    await this.#chain
    return (await this.#read()).scopes[scopeId] ?? null
  }

  async listSnapshots(limit = 500): Promise<readonly ProviderUsageScopeSnapshot[]> {
    await this.#chain
    const ledger = await this.#read()
    return Object.entries(ledger.scopes)
      .map(([scopeId, snapshot]) => ({ scopeId, ...snapshot }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.scopeId.localeCompare(right.scopeId))
      .slice(0, Math.max(1, Math.min(500, Math.floor(limit))))
  }

  async #read(): Promise<z.infer<typeof ledgerSchema>> {
    try {
      return ledgerSchema.parse(JSON.parse(await readFile(this.#filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, scopes: {} }
      throw error
    }
  }

  async #write(value: z.infer<typeof ledgerSchema>): Promise<void> {
    const parsed = ledgerSchema.parse(value)
    await mkdir(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
  }
}
