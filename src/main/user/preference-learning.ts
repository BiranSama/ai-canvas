import type { Scene, SceneElement } from '../../domain'
import { sanitizeProjectName } from '../storage/project-library'
import { CANDIDATES_PER_SUMMARY, type PreferenceSignal, type PreferenceSignalKind, type UserMemoryCandidate } from '../../shared/user-memory'
import type { BackgroundTextModel } from '../llm/background-text-model'
import type { UserMemoryStore } from './user-memory-store'

/*
 * Learning what the person prefers from how they work: light signals in
 * words (no pictures), summed up now and then by the fast model into a few
 * candidates the person confirms or ignores. Nothing learned is used until
 * it is confirmed. Naming a new project after its first turn lives here too:
 * both are small background jobs for the fast model.
 */

/** The names a new project gets before anyone names it. */
export function isAutoProjectName(name: string): boolean {
  return /^(?:Untitled|未命名创作|未命名)(?: \d+)?$/u.test(name.trim())
}

/** Words that make a message a remark about the work rather than a plain request. */
const FEEDBACK = /太|不够|有点|喜欢|不喜欢|讨厌|简洁|简单点|高级|好看|难看|丑|乱|花哨|太花|素一点|清爽|大气|俗|土|别用|不要用|偏好|风格|感觉/u

/** Whether a message reads as a remark about the work, worth learning from. */
export function looksLikeFeedback(text: string): boolean {
  const line = text.trim()
  return line.length > 0 && line.length <= 120 && FEEDBACK.test(line)
}

function label(element: SceneElement): string {
  const name = element.type === 'text' ? element.content.replace(/\s+/g, ' ').slice(0, 16) : element.name.slice(0, 16)
  return `「${name}」`
}

/**
 * What the person changed by hand on what the Agent made, in a few words
 * each: fonts, colours, sizes, weight, opacity, and layers they removed.
 * Moves and resizes are left out; they say little about taste.
 */
export function describeManualEdits(before: Scene, after: Scene, agentMade: ReadonlySet<string>, limit = 3): string[] {
  const lines: string[] = []
  for (const previous of before.elements) {
    if (!agentMade.has(previous.id)) continue
    const next = after.elements.find((element) => element.id === previous.id)
    if (next === undefined) {
      lines.push(`删掉了 Agent 加的${label(previous)}`)
      continue
    }
    if (next === previous || next.type !== previous.type) continue
    if (next.type === 'text' && previous.type === 'text') {
      if (next.fontFamily !== previous.fontFamily) lines.push(`把 Agent 写的文字${label(next)}的字体从 ${previous.fontFamily} 换成 ${next.fontFamily}`)
      if (next.fill.toLowerCase() !== previous.fill.toLowerCase()) lines.push(`把 Agent 写的文字${label(next)}的颜色从 ${previous.fill} 换成 ${next.fill}`)
      if (Math.abs(next.fontSize - previous.fontSize) >= previous.fontSize * 0.1) lines.push(`把 Agent 写的文字${label(next)}的字号从 ${previous.fontSize} 调到 ${next.fontSize}`)
      if (next.fontWeight !== previous.fontWeight) lines.push(`把 Agent 写的文字${label(next)}的字重从 ${previous.fontWeight} 调到 ${next.fontWeight}`)
    }
    if (next.type === 'shape' && previous.type === 'shape' && next.fill.toLowerCase() !== previous.fill.toLowerCase()) {
      lines.push(`把 Agent 画的形状${label(next)}的颜色从 ${previous.fill} 换成 ${next.fill}`)
    }
    if (Math.abs(next.opacity - previous.opacity) >= 0.1) lines.push(`把 Agent 做的${label(next)}的不透明度从 ${Math.round(previous.opacity * 100)}% 调到 ${Math.round(next.opacity * 100)}%`)
  }
  return lines.slice(0, limit)
}

const SIGNAL_LABELS: Record<PreferenceSignalKind, string> = {
  accepted: '采用',
  undone: '撤销',
  redone: '要求重做',
  edited: '手动修改',
  said: '说过'
}

export const SUMMARY_SYSTEM = [
  '你在帮一个设计软件记住用户的长期设计偏好。下面是用户最近的使用记录，只有文字。',
  `根据这些记录，给出最多 ${CANDIDATES_PER_SUMMARY} 条以后做别的作品时也大概适用的偏好，每条一句中文，写具体（例如「标题喜欢用衬线体」「版面留白多一些」）。`,
  '只写有两条以上记录支持、或用户明确说过的；只针对某一张图的要求不算。已经记下的不要重复。没有把握就少写，可以一条都不写。',
  '只输出 JSON：{"preferences":["…"]}'
].join('\n')

/** What the summary is asked about: the signals and what is already kept. */
export function summaryPrompt(signals: readonly PreferenceSignal[], kept: readonly string[]): string {
  return [
    '使用记录（从旧到新）：',
    ...signals.map((signal) => `- ${SIGNAL_LABELS[signal.kind]}：${signal.text}`),
    ...(kept.length === 0 ? [] : ['', '已经记下或提过的：', ...kept.slice(-40).map((line) => `- ${line}`)])
  ].join('\n')
}

/** The preferences a summary reply offers; none when it cannot be read. */
export function parseSummary(reply: string): string[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { readonly preferences?: unknown }
    if (!Array.isArray(parsed.preferences)) return []
    return parsed.preferences
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim().slice(0, 200))
      .filter((line) => line.length >= 2)
      .slice(0, CANDIDATES_PER_SUMMARY)
  } catch {
    return []
  }
}

export const PROJECT_NAME_SYSTEM = '给一件设计作品起名。根据用户的第一句要求，起一个 2 到 12 个字的中文名字，像作品文件名（例如「晨雾新品海报」）。只输出名字本身，不要引号、标点或解释。'

/** A usable project name from the reply, or null. */
export function parseProjectName(reply: string): string | null {
  const line = reply.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  const cleaned = line.replace(/^(?:名字|作品名|名称)[:：]\s*/u, '').replace(/^[「『"'“‘《]+|[」』"'”’》。.!！]+$/gu, '').trim()
  const name = sanitizeProjectName(cleaned)
  const length = [...name].length
  if (length < 2 || length > 12 || isAutoProjectName(name) || name === '未命名创作') return null
  return name
}

export interface PreferenceLearnerOptions {
  readonly store: Pick<UserMemoryStore, 'recordSignal' | 'summaryInput' | 'summarized'>
  readonly model: Pick<BackgroundTextModel, 'complete'>
  /** How long after a summary falls due it runs, so it does not compete with the work at hand. */
  readonly delayMs?: number
}

export class PreferenceLearner {
  readonly #options: PreferenceLearnerOptions
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<readonly UserMemoryCandidate[]> | null = null
  #closed = false

  constructor(options: PreferenceLearnerOptions) {
    this.#options = options
  }

  /** Records a signal; a summary that falls due runs a little later. */
  async record(kind: PreferenceSignalKind, text: string): Promise<void> {
    if (this.#closed) return
    const due = await this.#options.store.recordSignal(kind, text).catch(() => false)
    if (due) this.#schedule()
  }

  #schedule(): void {
    if (this.#timer !== null || this.#running !== null || this.#closed) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.summarize()
    }, this.#options.delayMs ?? 5_000)
  }

  /** Sums up the signals into candidates now; one summary at a time. */
  summarize(): Promise<readonly UserMemoryCandidate[]> {
    if (this.#running !== null) return this.#running
    const run = (async (): Promise<readonly UserMemoryCandidate[]> => {
      const input = await this.#options.store.summaryInput()
      if (!input.enabled || input.signals.length === 0) return []
      const reply = await this.#options.model.complete({ system: SUMMARY_SYSTEM, prompt: summaryPrompt(input.signals, input.kept), maxOutputTokens: 1_024 })
      // With no model to ask, the signals wait; the next one tries again.
      if (reply === null) return []
      return this.#options.store.summarized(parseSummary(reply.text).map((content) => ({ kind: 'preference' as const, content })))
    })().catch(() => [] as readonly UserMemoryCandidate[])
    this.#running = run
    return run.finally(() => { if (this.#running === run) this.#running = null })
  }

  close(): void {
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }
}
