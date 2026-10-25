import type { Scene, SceneElement } from '../../../domain'

const ELEMENT_REF = /^E(\d{1,5})$/i
const RESULT_REF = /^R(\d{1,3})$/i

/**
 * Short names the model uses instead of UUIDs. Elements are numbered E1, E2…
 * in layer order when a turn starts; the numbers stay fixed for the whole
 * turn and new elements continue the sequence.
 */
export class ElementRefs {
  readonly #byId = new Map<string, string>()
  readonly #byRef = new Map<string, string>()
  #next = 1

  static fromScene(scene: Pick<Scene, 'elements'>, saved: Readonly<Record<string, string>> = {}): ElementRefs {
    const refs = new ElementRefs()
    const known = new Set(scene.elements.map((element) => element.id))
    for (const [ref, id] of Object.entries(saved).sort(([left], [right]) => refNumber(left) - refNumber(right))) {
      if (ELEMENT_REF.test(ref) && known.has(id)) refs.#assign(ref.toUpperCase(), id)
    }
    refs.#next = Math.max(1, ...Object.keys(saved).filter((ref) => ELEMENT_REF.test(ref)).map((ref) => refNumber(ref) + 1))
    refs.sync(scene)
    return refs
  }

  /** Gives every element without a reference the next free number, in layer order. */
  sync(scene: Pick<Scene, 'elements'>): void {
    for (const element of [...scene.elements].sort((left, right) => left.zIndex - right.zIndex)) {
      if (!this.#byId.has(element.id)) this.#assign(`E${this.#next}`, element.id)
    }
  }

  ref(id: string): string {
    const ref = this.#byId.get(id)
    if (ref === undefined) throw new Error(`Element ${id} has no short reference.`)
    return ref
  }

  /** Accepts a short reference or an element name that is unique in the scene. */
  resolve(token: string, scene: Pick<Scene, 'elements'>): SceneElement | string {
    const trimmed = token.trim()
    const direct = ELEMENT_REF.test(trimmed) ? this.#byRef.get(trimmed.toUpperCase()) : undefined
    if (direct !== undefined) {
      const element = scene.elements.find((candidate) => candidate.id === direct)
      return element ?? `${trimmed.toUpperCase()} 已被删除。`
    }
    if (ELEMENT_REF.test(trimmed)) return `没有对象 ${trimmed.toUpperCase()}。用 inspect 或画布摘要里的编号。`
    const named = scene.elements.filter((element) => element.name === trimmed)
    if (named.length === 1) return named[0]!
    return named.length > 1
      ? `有 ${named.length} 个对象都叫「${trimmed}」，请改用编号（${named.map((element) => this.#byId.get(element.id)).join('、')}）。`
      : `没有叫「${trimmed}」的对象。用编号（例如 E3）指代对象。`
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#byRef)
  }

  #assign(ref: string, id: string): void {
    this.#byId.set(id, ref)
    this.#byRef.set(ref, id)
    this.#next = Math.max(this.#next, refNumber(ref) + 1)
  }
}

function refNumber(ref: string): number {
  return Number(ELEMENT_REF.exec(ref)?.[1] ?? 0)
}

/** R1, R2… point at the generated results listed in the request, oldest first. */
export function resolveResultRef<T>(token: string, results: readonly T[]): T | string {
  const match = RESULT_REF.exec(token.trim())
  if (match === null) return `成图用 R1、R2 这样的编号指代。`
  const result = results[Number(match[1]) - 1]
  return result ?? `没有成图 ${token.trim().toUpperCase()}；现在共有 ${results.length} 张。`
}
