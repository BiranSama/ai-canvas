import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  llmProtocolSchema,
  llmProviderConfigSchema,
  llmReasoningEffortSchema,
  llmTransportModeSchema,
  imageProviderConfigSchema
} from '../../../shared/provider-settings'
import type { EvalLlmProviderConfig } from './engine'

/**
 * Configuration of the text model under evaluation. Non-secret fields may
 * come from a local JSON file; environment variables override it. The API key
 * is accepted from the environment only and is never echoed.
 */

export const EVAL_ENV = {
  configFile: 'AI_CANVAS_EVAL_CONFIG',
  baseUrl: 'AI_CANVAS_EVAL_LLM_BASE_URL',
  model: 'AI_CANVAS_EVAL_LLM_MODEL',
  protocol: 'AI_CANVAS_EVAL_LLM_PROTOCOL',
  apiKey: 'AI_CANVAS_EVAL_LLM_API_KEY',
  reasoningEffort: 'AI_CANVAS_EVAL_LLM_REASONING_EFFORT',
  transport: 'AI_CANVAS_EVAL_LLM_TRANSPORT',
  timeoutMs: 'AI_CANVAS_EVAL_LLM_TIMEOUT_MS',
  maxOutputTokens: 'AI_CANVAS_EVAL_LLM_MAX_OUTPUT_TOKENS',
  vision: 'AI_CANVAS_EVAL_LLM_VISION',
  inputPrice: 'AI_CANVAS_EVAL_LLM_INPUT_CNY_PER_MTOK',
  outputPrice: 'AI_CANVAS_EVAL_LLM_OUTPUT_CNY_PER_MTOK',
  runs: 'AI_CANVAS_EVAL_RUNS',
  cases: 'AI_CANVAS_EVAL_CASES',
  outputDir: 'AI_CANVAS_EVAL_OUTPUT_DIR',
  record: 'AI_CANVAS_EVAL_RECORD',
  turnTimeoutMs: 'AI_CANVAS_EVAL_TURN_TIMEOUT_MS'
} as const

export const DEFAULT_EVAL_CONFIG_FILE = '.ai-canvas/agent-eval.json'

const fileSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  protocol: z.string().optional(),
  reasoningEffort: z.string().optional(),
  transport: z.string().optional(),
  timeoutMs: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  vision: z.boolean().optional(),
  inputCnyPerMillionTokens: z.number().nonnegative().optional(),
  outputCnyPerMillionTokens: z.number().nonnegative().optional()
}).strict()

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalConfigError'
  }
}

export interface EvalModelConfig {
  readonly provider: EvalLlmProviderConfig
  readonly apiKey: string
  readonly pricing: {
    readonly inputCnyPerMillionTokens: number | null
    readonly outputCnyPerMillionTokens: number | null
  }
}

export interface EvalRunSettings {
  readonly runs: number
  readonly caseFilter: readonly string[]
  readonly outputDirectory: string
  readonly record: boolean
  readonly turnTimeoutMs: number
}

type Environment = Readonly<Record<string, string | undefined>>

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function numberFrom(env: Environment, name: string, fallback: number | undefined): number | undefined {
  const raw = present(env[name])
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new EvalConfigError(`${name} must be a number.`)
  return value
}

function booleanFrom(env: Environment, name: string, fallback: boolean): boolean {
  const raw = present(env[name])
  if (raw === undefined) return fallback
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true
  if (/^(?:0|false|no|off)$/i.test(raw)) return false
  throw new EvalConfigError(`${name} must be 1/0, true/false, yes/no or on/off.`)
}

async function readConfigFile(env: Environment, cwd: string): Promise<z.infer<typeof fileSchema>> {
  const explicit = present(env[EVAL_ENV.configFile])
  const path = resolve(cwd, explicit ?? DEFAULT_EVAL_CONFIG_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && explicit === undefined) return {}
    throw new EvalConfigError(`Cannot read the eval config file ${path}.`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new EvalConfigError(`The eval config file ${path} is not valid JSON.`)
  }
  if (typeof value === 'object' && value !== null && Object.keys(value).some((key) => /api[-_]?key|secret|password|authorization|bearer|^(?:key|token)$/i.test(key))) {
    throw new EvalConfigError(`Do not store credentials in ${path}; set ${EVAL_ENV.apiKey} in the environment instead.`)
  }
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) throw new EvalConfigError(`The eval config file ${path} has unsupported fields: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}.`)
  return parsed.data
}

/** Reads and validates the text-model configuration; refuses to proceed when anything required is missing. */
export async function loadEvalModelConfig(env: Environment, cwd = process.cwd()): Promise<EvalModelConfig> {
  const file = await readConfigFile(env, cwd)
  const baseUrl = present(env[EVAL_ENV.baseUrl]) ?? file.baseUrl
  const model = present(env[EVAL_ENV.model]) ?? file.model
  const protocol = present(env[EVAL_ENV.protocol]) ?? file.protocol
  const apiKey = present(env[EVAL_ENV.apiKey])
  const missing = [
    baseUrl === undefined ? EVAL_ENV.baseUrl : null,
    model === undefined ? EVAL_ENV.model : null,
    protocol === undefined ? EVAL_ENV.protocol : null,
    apiKey === undefined ? EVAL_ENV.apiKey : null
  ].filter((name) => name !== null)
  if (missing.length > 0) {
    throw new EvalConfigError(
      `The real-model agent eval needs a text model. Missing: ${missing.join(', ')}. `
      + `Set them in the environment (non-secret fields may also live in ${DEFAULT_EVAL_CONFIG_FILE} or the file named by ${EVAL_ENV.configFile}).`
    )
  }
  const protocolValue = llmProtocolSchema.safeParse(protocol)
  if (!protocolValue.success) throw new EvalConfigError(`${EVAL_ENV.protocol} must be one of ${llmProtocolSchema.options.join(', ')}.`)
  const effort = llmReasoningEffortSchema.safeParse(present(env[EVAL_ENV.reasoningEffort]) ?? file.reasoningEffort ?? 'auto')
  if (!effort.success) throw new EvalConfigError(`${EVAL_ENV.reasoningEffort} must be one of ${llmReasoningEffortSchema.options.join(', ')}.`)
  const transport = llmTransportModeSchema.safeParse(present(env[EVAL_ENV.transport]) ?? file.transport ?? 'auto')
  if (!transport.success) throw new EvalConfigError(`${EVAL_ENV.transport} must be one of ${llmTransportModeSchema.options.join(', ')}.`)
  const timeoutMs = numberFrom(env, EVAL_ENV.timeoutMs, file.timeoutMs) ?? 120_000
  const provider = llmProviderConfigSchema.safeParse({
    id: 'openai-compatible-llm',
    kind: 'llm',
    label: '评测文字模型',
    baseUrl,
    defaultModel: model,
    protocol: protocolValue.data,
    reasoningEffort: effort.data,
    imageDetail: 'auto',
    maxOutputTokens: numberFrom(env, EVAL_ENV.maxOutputTokens, file.maxOutputTokens) ?? 4_096,
    timeoutMs,
    concurrency: 1,
    transport: {
      mode: transport.data,
      connectTimeoutMs: Math.min(20_000, timeoutMs),
      firstEventTimeoutMs: Math.min(60_000, timeoutMs),
      idleTimeoutMs: Math.min(60_000, timeoutMs)
    },
    capabilities: {
      streaming: transport.data !== 'buffered',
      toolCalling: true,
      vision: booleanFrom(env, EVAL_ENV.vision, file.vision ?? true)
    }
  })
  if (!provider.success) {
    throw new EvalConfigError(`The text-model configuration is invalid: ${provider.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return {
    provider: provider.data,
    apiKey: apiKey!,
    pricing: {
      inputCnyPerMillionTokens: numberFrom(env, EVAL_ENV.inputPrice, file.inputCnyPerMillionTokens) ?? null,
      outputCnyPerMillionTokens: numberFrom(env, EVAL_ENV.outputPrice, file.outputCnyPerMillionTokens) ?? null
    }
  }
}

export function loadEvalRunSettings(env: Environment, cwd = process.cwd(), now = new Date()): EvalRunSettings {
  const runs = numberFrom(env, EVAL_ENV.runs, 3)!
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new EvalConfigError(`${EVAL_ENV.runs} must be an integer from 1 to 20.`)
  const turnTimeoutMs = numberFrom(env, EVAL_ENV.turnTimeoutMs, 6 * 60_000)!
  return {
    runs,
    caseFilter: (present(env[EVAL_ENV.cases]) ?? '').split(',').map((value) => value.trim()).filter((value) => value !== ''),
    outputDirectory: resolve(cwd, present(env[EVAL_ENV.outputDir]) ?? `test-results/agent-eval/${now.toISOString().replace(/[:.]/g, '-')}`),
    record: booleanFrom(env, EVAL_ENV.record, true),
    turnTimeoutMs
  }
}

/** Image generation in every eval run is answered by an in-process mock; these addresses never resolve. */
export const EVAL_MOCK_IMAGE_BASE_URL = 'https://agent-eval-mock-images.invalid/v1'
export const EVAL_MOCK_IMAGE_SECRET = 'agent-eval-local-mock-image-credential'

export const evalMockImageProviderConfig = imageProviderConfigSchema.parse({
  id: 'image-provider',
  kind: 'image',
  label: '评测本地模拟图片服务',
  baseUrl: EVAL_MOCK_IMAGE_BASE_URL,
  defaultModel: 'agent-eval-mock-image',
  protocol: 'openai-images',
  timeoutMs: 60_000,
  concurrency: 1,
  capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false }
})

/** Text-model settings used when replaying a recording; the address is never contacted. */
export function replayLlmProviderConfig(protocol: EvalLlmProviderConfig['protocol'], transport: 'stream' | 'buffered'): EvalLlmProviderConfig {
  return llmProviderConfigSchema.parse({
    id: 'openai-compatible-llm',
    kind: 'llm',
    label: '评测回放文字模型',
    baseUrl: 'https://agent-eval-replay.invalid/v1',
    defaultModel: 'agent-eval-replay',
    protocol,
    reasoningEffort: 'auto',
    imageDetail: 'auto',
    maxOutputTokens: 4_096,
    timeoutMs: 60_000,
    concurrency: 1,
    transport: { mode: transport, connectTimeoutMs: 20_000, firstEventTimeoutMs: 30_000, idleTimeoutMs: 30_000 },
    capabilities: { streaming: transport === 'stream', toolCalling: true, vision: true }
  })
}
