import { z } from 'zod'

const jsonObjectSchema = z.record(z.string(), z.unknown())

export type ToolArgumentsParseFailure = 'empty' | 'incomplete' | 'invalid'

export class ToolArgumentsParseError extends Error {
  readonly failure: ToolArgumentsParseFailure
  readonly schemaIssues: readonly { readonly issueCode: string; readonly path: string; readonly expected: string }[]

  constructor(failure: ToolArgumentsParseFailure, offset: number | null = null) {
    super(failure)
    this.name = 'ToolArgumentsParseError'
    this.failure = failure
    this.schemaIssues = [{
      issueCode: `JSON_${failure.toUpperCase()}`,
      path: 'arguments',
      expected: `必须返回一个完整、合法的 JSON 对象${offset === null ? '' : `；语法错误位于从 0 开始的字符偏移 ${offset}`}。字符串使用双引号，字符串内换行和引号必须转义；禁止注释、尾逗号和计算表达式。`
    }]
  }
}

function unwrapCodeFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  return match?.[1]?.trim() ?? value
}

function structurallyIncomplete(value: string): boolean {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      if (stack.pop() !== (character === '}' ? '{' : '[')) return false
      // Anything after a closed root is invalid, not a truncated first object.
      if (stack.length === 0) return false
    }
  }
  return stack.length > 0 || inString
}

/**
 * R0 only strips a code fence and surrounding whitespace. Prose extraction,
 * double decoding and structural repair are not local normalization authority.
 */
export function parseModelToolArguments(value: string): Readonly<Record<string, unknown>> {
  const trimmed = unwrapCodeFence(value.trim())
  if (trimmed === '') throw new ToolArgumentsParseError('empty')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    // SyntaxError messages can quote private model content. Keep only the
    // numeric position; never propagate the message or an argument excerpt.
    const match = error instanceof SyntaxError ? /position (\d+)/u.exec(error.message) : null
    const offset = match === null ? null : Number(match[1])
    const endedEarly = offset !== null && offset >= trimmed.length
      || error instanceof SyntaxError && /^(?:Unexpected end|Unterminated string)/iu.test(error.message)
    const incomplete = endedEarly && trimmed.startsWith('{') && structurallyIncomplete(trimmed)
    throw new ToolArgumentsParseError(incomplete ? 'incomplete' : 'invalid', offset)
  }
  const object = jsonObjectSchema.safeParse(parsed)
  if (!object.success) throw new ToolArgumentsParseError('invalid')
  return object.data
}
