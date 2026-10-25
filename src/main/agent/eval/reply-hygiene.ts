import { PLANNER_TOOL_KIND_TO_REGISTRY_NAME } from '../agent-tool-registry'

/**
 * User-visible copy must talk about objects by name. Identifiers, element
 * short refs, JSON fragments and protocol vocabulary are leaks.
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// e12, el_3, ref:4, #e7, [obj-2]: compact handles a step-by-step engine might expose.
const SHORT_REF_PATTERN = /(?<![A-Za-z0-9_])(?:el|elem|element|obj|node|ref|e)[-_#:]?\d{1,4}(?![A-Za-z0-9_])/i
// A bare 8-16 digit hex handle (a truncated id), but not a #RRGGBB(AA) colour.
const HEX_HANDLE_PATTERN = /(?<![#0-9A-Za-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,16}(?![0-9A-Za-z])/i
const JSON_FRAGMENT_PATTERN = /[{[]\s*"[^"\n]{1,80}"\s*:|"[A-Za-z_$][\w$]*"\s*:\s*[-"{[\dtfn]/

const STATIC_INTERNAL_TERMS = [
  'submitAgentPlan', 'scene_batch', 'elementId', 'elementIds', 'assetId', 'resultId', 'jobId', 'toolIndex',
  'sceneRevision', 'expectedSceneRevision', 'designContract', 'creativeContext', 'creativeBrief', 'semanticRole',
  'controlIntent', 'renderStrategy', 'referencePolicy', 'providerId', 'openai-compatible-llm', 'image-provider',
  'tool_call', 'tool_result', 'generated:', 'element.add', 'element.update', 'element.remove', 'element.reorder',
  'element.group', 'element.set-image', 'element.rasterize', 'scene.set-canvas', 'scene.set-creative-context', 'relation.add'
]

// Every planner tool name and runtime tool name that is not an ordinary word.
export const INTERNAL_REPLY_TERMS: readonly string[] = [...new Set([
  ...STATIC_INTERNAL_TERMS,
  ...Object.keys(PLANNER_TOOL_KIND_TO_REGISTRY_NAME),
  ...Object.values(PLANNER_TOOL_KIND_TO_REGISTRY_NAME)
].filter((term) => /[._:-]|[a-z][A-Z]/.test(term)))]

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const TERM_PATTERNS = INTERNAL_REPLY_TERMS.map((term) => ({
  term,
  pattern: new RegExp(`(?<![A-Za-z0-9_])${escape(term)}${term.endsWith(':') ? '' : '(?![A-Za-z0-9_])'}`)
}))

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12)
  return text.slice(start, Math.min(text.length, index + length + 12)).replace(/\s+/g, ' ')
}

/** Returns one readable issue per kind of leak found; empty when the copy is clean. */
export function replyHygieneIssues(text: string): readonly string[] {
  const issues: string[] = []
  const report = (label: string, pattern: RegExp): void => {
    const match = pattern.exec(text)
    if (match !== null) issues.push(`${label}：“…${excerpt(text, match.index, match[0].length)}…”`)
  }
  report('包含 UUID', UUID_PATTERN)
  report('包含元素短引用', SHORT_REF_PATTERN)
  report('包含疑似截断标识', HEX_HANDLE_PATTERN)
  report('包含 JSON 片段', JSON_FRAGMENT_PATTERN)
  for (const { term, pattern } of TERM_PATTERNS) {
    if (pattern.test(text)) issues.push(`包含内部术语 ${term}`)
  }
  return issues
}
