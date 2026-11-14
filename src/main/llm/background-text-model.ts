import { randomUUID } from 'node:crypto'
import { estimateModelCostCny } from '../../shared/model-usage'
import { textHelperReady, type MainTextModelConfig, type ProviderConfigFile, type TextHelperConfig } from '../../shared/provider-settings'
import { createConfiguredTurnProtocol } from '../agent/llm-protocol-factory'
import { turnText, type LlmUsage } from '../agent/llm/transcript'
import { ArkHttpClient } from '../security/ark-http-client'
import type { ProviderUsageReservation } from '../security/provider-usage-ledger'

/*
 * Small jobs done outside any turn — naming a new project, summing up what
 * the person seems to prefer — go to the fast model when one is set, to the
 * main model when it is not or the fast one fails, and are skipped when
 * neither can answer. They never stop the person's work.
 */

type TextModelConfig = MainTextModelConfig | TextHelperConfig

/** The most a single background call may cost, in CNY. */
const BACKGROUND_COST_CEILING_CNY = 0.2

export interface BackgroundTextRequest {
  readonly system: string
  readonly prompt: string
  /** A small reply needs little; thinking models get at least 1,024. */
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
}

export interface BackgroundTextReply {
  readonly text: string
  /** Which model answered. */
  readonly served: 'fast' | 'main'
  readonly inputTokens: number
  readonly outputTokens: number
  /** Null without a price for the model that answered. */
  readonly estimatedCostCny: number | null
}

export interface BackgroundTextModelOptions {
  readonly config: { read(): Promise<ProviderConfigFile> }
  readonly secrets: { has(id: string): Promise<boolean>; get(id: string): Promise<string | null> }
  readonly authorization: { reserve(input: ProviderUsageReservation): Promise<unknown> }
  readonly fetcher?: typeof fetch
  /** Told about every answered call, for the usage page. */
  readonly recordUsage?: (reply: BackgroundTextReply) => Promise<void>
}

/** One text reply from this model, with no tools. Throws on any failure. */
export async function completeTextOnce(
  llm: TextModelConfig,
  request: BackgroundTextRequest,
  options: {
    readonly secrets: { get(id: string): Promise<string | null> }
    readonly authorization: BackgroundTextModelOptions['authorization']
    readonly fetcher?: typeof fetch
    readonly costCeilingCny?: number
  }
): Promise<{ readonly text: string; readonly usage: LlmUsage | null }> {
  const protocol = createConfiguredTurnProtocol(llm)
  const built = protocol.buildTurnRequest({
    system: request.system,
    messages: [{ role: 'user', parts: [{ type: 'text', text: request.prompt }] }],
    tools: [],
    maxOutputTokens: Math.max(1_024, Math.min(llm.maxOutputTokens, request.maxOutputTokens ?? 2_048))
  }, false)
  const http = new ArkHttpClient({
    secrets: options.secrets,
    authorization: options.authorization,
    allowedBaseUrls: [llm.baseUrl],
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher })
  })
  const turn = protocol.parseTurnResponse(await http.postLlmJson({
    ...built,
    secretId: llm.id,
    providerId: llm.id,
    providerLabel: llm.label,
    authorizationScopeId: `background-text:${randomUUID()}`,
    expectedImages: 0,
    costCeilingCny: options.costCeilingCny ?? BACKGROUND_COST_CEILING_CNY,
    signal: request.signal ?? new AbortController().signal,
    timeoutMs: llm.timeoutMs,
    connectTimeoutMs: llm.transport.connectTimeoutMs,
    firstEventTimeoutMs: llm.transport.firstEventTimeoutMs,
    idleTimeoutMs: llm.transport.idleTimeoutMs
  }))
  return { text: turnText(turn).trim(), usage: turn.usage ?? null }
}

export class BackgroundTextModel {
  readonly #options: BackgroundTextModelOptions

  constructor(options: BackgroundTextModelOptions) {
    this.#options = options
  }

  /** The models a call would try, in order: the fast one first. */
  async #candidates(): Promise<readonly { readonly served: 'fast' | 'main'; readonly llm: TextModelConfig }[]> {
    const file = await this.#options.config.read()
    const fast = file.textHelpers.fast
    const main = file.providers[0]
    return [
      ...(textHelperReady(fast, fast === null ? false : await this.#options.secrets.has(fast.id)) ? [{ served: 'fast' as const, llm: fast }] : []),
      ...(main !== undefined && main.baseUrl !== '' && main.defaultModel !== '' && await this.#options.secrets.has(main.id) ? [{ served: 'main' as const, llm: main }] : [])
    ]
  }

  /** Whether any model could answer now. */
  async available(): Promise<boolean> {
    return (await this.#candidates()).length > 0
  }

  /** The reply, or null when no model is set or every one failed. */
  async complete(request: BackgroundTextRequest): Promise<BackgroundTextReply | null> {
    for (const { served, llm } of await this.#candidates()) {
      if (request.signal?.aborted === true) return null
      try {
        const { text, usage } = await completeTextOnce(llm, request, this.#options)
        const reply: BackgroundTextReply = {
          text,
          served,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          estimatedCostCny: usage === null || llm.pricing === null ? null : estimateModelCostCny(usage, llm.pricing)
        }
        // A reply with no words was still billed (thinking can use the whole budget): count it before trying the next model.
        if (usage !== null || text !== '') await this.#options.recordUsage?.(reply).catch(() => undefined)
        if (text === '') continue
        return reply
      } catch {
        // The next model, if any, takes it.
      }
    }
    return null
  }
}
