import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { imageProviderConfigSchema, providerExecutionPolicySchema } from '../../shared/provider-settings'
import type { ImageTaskRequest } from '../../shared/generation'

// Main-only: the project keeps an opaque identity, never the credential reference.
const bindingSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), projectId: z.string().min(1),
  image: imageProviderConfigSchema, policy: providerExecutionPolicySchema,
  credentialReference: z.string().min(1), model: z.string().min(1),
  invocationKey: z.string().min(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(['generate', 'edit']), createdAt: z.string().datetime()
})
export type ImageExecutionBinding = z.infer<typeof bindingSchema>

export function executionInputHash(input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)])) : value
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

export function executionRequestHash(request: ImageTaskRequest): string {
  const parameters = Object.fromEntries(Object.entries(request.parameters)
    .filter(([key]) => !['workflowIntentId', 'workflowIdempotencyKey', 'workflowWarnings'].includes(key)))
  return executionInputHash({ ...request, parameters })
}

export class ImageExecutionBindings {
  constructor(readonly directory: string) {}

  async create(input: Omit<ImageExecutionBinding, 'version' | 'id' | 'createdAt'>): Promise<ImageExecutionBinding> {
    const binding = bindingSchema.parse({ ...input, version: 1, id: randomUUID(), createdAt: new Date().toISOString() })
    await mkdir(this.directory, { recursive: true })
    await writeFile(join(this.directory, `${binding.id}.json`), JSON.stringify(binding), { encoding: 'utf8', flag: 'wx' })
    return binding
  }

  async read(id: string): Promise<ImageExecutionBinding> {
    const parsedId = z.string().uuid().parse(id)
    const binding = bindingSchema.parse(JSON.parse(await readFile(join(this.directory, `${parsedId}.json`), 'utf8')))
    if (binding.id !== parsedId) throw new Error('Image execution identity mismatch.')
    return binding
  }
}
