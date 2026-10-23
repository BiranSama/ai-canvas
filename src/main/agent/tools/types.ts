import type { ToneMeasurement } from '../../edit/tone-match'
import type { LocalFontFamily } from '../../../shared/local-fonts'
import type { z } from 'zod'
import type { Scene, SceneElement } from '../../../domain'
import type { AgentToolOutcome, AgentToolPlan } from '../../../shared/agent'
import type { LlmImage } from '../llm/transcript'
import type { ElementRefs } from './refs'

export interface GenerationResultEntry {
  readonly resultId: string
  readonly jobId: string
  readonly assetId: string
  readonly width: number
  readonly height: number
}

export interface LookRequest {
  /** Percent box [x, y, w, h] of the canvas, or null for the whole canvas. */
  readonly region: readonly [number, number, number, number] | null
  readonly mode: 'canvas' | 'reference'
  /** Checker when the scene holds one layer on a transparent canvas, so its own edges stay visible. */
  readonly background?: 'white' | 'checker'
}

/** Renders what the agent "sees"; provided by the main process (work package 5). */
export interface CanvasLooker {
  look(scene: Scene, request: LookRequest): Promise<LlmImage>
}

/** Topic manuals the model can load on demand (work package 6). */
export interface ManualLibrary {
  /** Recorded with each step, so results can be tied to the manuals the model read. */
  readonly version?: string
  list(): readonly { readonly id: string; readonly title: string; readonly purpose: string }[]
  load(id: string): string | null
}

export interface AgentToolContext {
  readonly scene: Scene
  readonly refs: ElementRefs
  readonly newId: () => string
  readonly results: readonly GenerationResultEntry[]
  /** The image service generation goes to, or null when none is configured. */
  readonly generation: {
    readonly providerId: string
    readonly model: string
    readonly maxImages: number
    /** What the model can do, in one line for the turn brief. */
    readonly summary?: string
    /** Whether the service can repaint part of an image (a mask or a marked region). */
    readonly localEdits?: boolean
    /** Whether the service takes reference images. */
    readonly references?: boolean
  } | null
  readonly activeJobId: string | null
  readonly sourceMessageId: string | null
  readonly userText: string
  readonly looker?: CanvasLooker | null
  /** False when the text model cannot see images; look then describes the layout in words. */
  readonly vision?: boolean
  /**
   * Whether screenshots may go to the model in this turn: always, only after
   * asking the person once (per-image review policy), or not at all.
   */
  readonly screenshots?: 'allowed' | 'ask' | 'declined'
  readonly manuals?: ManualLibrary | null
  readonly readAsset?: ((assetId: string) => Promise<LlmImage>) | null
  /** Measures how far an image's colour sits from the picture around it; null when Main cannot render here. */
  readonly measureTone?: ((elementId: string, strength: number) => Promise<ToneMeasurement | null>) | null
  /** Font families installed on this computer; empty when unknown, and then any name is accepted. */
  readonly fonts?: readonly LocalFontFamily[]
}

export interface AgentToolResult {
  readonly ok: boolean
  /** One sentence for the model and the activity card. */
  readonly summary: string
  /** Before → after values and new references, one line each. */
  readonly details?: readonly string[]
  readonly images?: readonly LlmImage[]
  /** What to do instead, when the call failed. */
  readonly hint?: string
  /** Raises the length cap for results that are long by nature, such as a manual. */
  readonly maxChars?: number
}

export interface ExecutedTool {
  readonly outcome: AgentToolOutcome
  readonly sceneBefore: Scene
  readonly sceneAfter: Scene
}

export type AgentToolStep =
  /** Answered here: read-only tools and calls rejected before execution. */
  | { readonly kind: 'answer'; readonly result: AgentToolResult }
  /** Runs through the existing executor (permissions, ledger, undo), then reports. */
  | { readonly kind: 'execute'; readonly plan: AgentToolPlan; readonly report: (executed: ExecutedTool) => AgentToolResult }
  /** Stops the turn for the person's answer. */
  | { readonly kind: 'ask'; readonly question: string; readonly options: readonly string[]; readonly recommended: number }

export interface AgentToolSpec<Args = unknown> {
  /** Model-facing name, snake_case. */
  readonly name: string
  /** Activity card label. */
  readonly title: string
  /** Model-facing description, short and in Chinese. */
  readonly description: string
  readonly parameters: z.ZodType<Args>
  /** Registry entry whose risk and permissions apply to this tool. */
  readonly registryName: string
  available?(context: AgentToolContext): boolean
  /** Activity card line for one call. */
  describe(args: Args, context: AgentToolContext): string
  prepare(args: Args, context: AgentToolContext): AgentToolStep | Promise<AgentToolStep>
}

export function defineTool<Args>(spec: AgentToolSpec<Args>): AgentToolSpec<Args> {
  return spec
}

export function answer(result: AgentToolResult): AgentToolStep {
  return { kind: 'answer', result }
}

export function rejected(summary: string, hint?: string): AgentToolStep {
  return answer({ ok: false, summary, ...(hint === undefined ? {} : { hint }) })
}

const MAX_RESULT_CHARS = 2_000

/** The text the model reads back; images travel separately. */
export function formatToolResult(result: AgentToolResult): string {
  const lines = [
    `${result.ok ? '成功' : '未执行'}：${result.summary}`,
    ...(result.details ?? []).map((line) => `- ${line}`),
    ...(result.hint === undefined ? [] : [`建议：${result.hint}`])
  ]
  const text = lines.join('\n')
  const limit = result.maxChars ?? MAX_RESULT_CHARS
  return text.length <= limit ? text : `${text.slice(0, limit - 12)}\n…（已截断）`
}

/** Resolves every target or explains the first one that cannot be used. */
export function resolveTargets(
  tokens: readonly string[],
  context: AgentToolContext,
  options: { readonly allowLocked?: boolean } = {}
): readonly SceneElement[] | string {
  const elements: SceneElement[] = []
  for (const token of tokens) {
    const resolved = context.refs.resolve(token, context.scene)
    if (typeof resolved === 'string') return resolved
    if (resolved.locked && options.allowLocked !== true) {
      return `${context.refs.ref(resolved.id)}「${resolved.name}」已锁定，不能修改。`
    }
    if (!elements.includes(resolved)) elements.push(resolved)
  }
  return elements
}
