/*
 * Free-form shape outlines. A path is written in SVG path syntax in the
 * shape's own box, 0–100 on each axis, and stored normalized: absolute
 * M, L, C, Q and Z only (H and V become lines, S and T explicit curves, arcs
 * cubic curves), numbers rounded to two decimals. Every renderer then maps
 * the same few commands onto its box, so a non-uniform resize stays exact.
 */

export const MAX_PATH_SEGMENTS = 4_000
const MIN_COORDINATE = -100
const MAX_COORDINATE = 200
const PARAMETERS: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

export type PathSegment =
  | readonly ['M' | 'L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Q', number, number, number, number]
  | readonly ['Z']

class Reader {
  index = 0
  constructor(readonly text: string) {}

  skip(): void {
    while (this.index < this.text.length && /[\s,]/.test(this.text[this.index]!)) this.index += 1
  }

  done(): boolean {
    this.skip()
    return this.index >= this.text.length
  }

  command(): string | null {
    this.skip()
    const character = this.text[this.index]
    if (character !== undefined && /[MmLlHhVvCcSsQqTtAaZz]/.test(character)) {
      this.index += 1
      return character
    }
    return null
  }

  number(): number | null {
    this.skip()
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.index, this.index + 64))
    if (match === null) return null
    this.index += match[0].length
    return Number(match[0])
  }

  /** Arc flags may be written without separators, as in "a1 1 0 011 1". */
  flag(): number | null {
    this.skip()
    const character = this.text[this.index]
    if (character !== '0' && character !== '1') return null
    this.index += 1
    return Number(character)
  }
}

/** One elliptical arc as cubic curves, following the SVG implementation notes (endpoint to centre form). */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, rotation: number, large: number, sweep: number, x2: number, y2: number): PathSegment[] {
  if (x1 === x2 && y1 === y2) return []
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return [['L', x2, y2]]
  const phi = rotation * Math.PI / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const numerator = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
  const denominator = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = factor * rx * y1p / ry
  const cyp = -factor * ry * x1p / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  const step = delta / parts
  const kappa = 4 / 3 * Math.tan(step / 4)
  const point = (theta: number) => ({
    x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos
  })
  const derivative = (theta: number) => ({
    x: -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    y: -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos
  })
  const segments: PathSegment[] = []
  for (let part = 0; part < parts; part += 1) {
    const from = start + part * step
    const to = from + step
    const p0 = point(from)
    const p3 = part === parts - 1 ? { x: x2, y: y2 } : point(to)
    const d0 = derivative(from)
    const d3 = derivative(to)
    segments.push(['C', p0.x + kappa * d0.x, p0.y + kappa * d0.y, p3.x - kappa * d3.x, p3.y - kappa * d3.y, p3.x, p3.y])
  }
  return segments
}

/** Parses SVG path syntax into absolute M, L, C, Q and Z segments, or explains what is wrong. */
export function parseSvgPath(text: string): { readonly segments: readonly PathSegment[] } | { readonly error: string } {
  const reader = new Reader(text)
  const segments: PathSegment[] = []
  let command: string | null = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastCubic: { x: number; y: number } | null = null
  let lastQuadratic: { x: number; y: number } | null = null
  while (!reader.done()) {
    const explicit = reader.command()
    if (explicit !== null) command = explicit
    else if (command === null) return { error: '路径要以 M 开头。' }
    else if (command === 'Z' || command === 'z') return { error: `Z 后面多了数字（位置 ${reader.index}）。` }
    const upper: string = command.toUpperCase()
    const relative: boolean = command !== upper
    if (segments.length === 0 && upper !== 'M') return { error: '路径要以 M 开头。' }
    const values: number[] = []
    for (let index = 0; index < PARAMETERS[upper]!; index += 1) {
      const value = upper === 'A' && (index === 3 || index === 4) ? reader.flag() : reader.number()
      if (value === null || !Number.isFinite(value)) return { error: `${command} 缺少数字（位置 ${reader.index}）。` }
      values.push(value)
    }
    const ax = (value: number) => relative ? x + value : value
    const ay = (value: number) => relative ? y + value : value
    let nextCubic: { x: number; y: number } | null = null
    let nextQuadratic: { x: number; y: number } | null = null
    switch (upper) {
      case 'M':
        x = ax(values[0]!)
        y = ay(values[1]!)
        startX = x
        startY = y
        segments.push(['M', x, y])
        // Further pairs after a move are lines.
        command = relative ? 'l' : 'L'
        break
      case 'L':
        x = ax(values[0]!)
        y = ay(values[1]!)
        segments.push(['L', x, y])
        break
      case 'H':
        x = relative ? x + values[0]! : values[0]!
        segments.push(['L', x, y])
        break
      case 'V':
        y = relative ? y + values[0]! : values[0]!
        segments.push(['L', x, y])
        break
      case 'C': {
        const c1 = { x: ax(values[0]!), y: ay(values[1]!) }
        const c2 = { x: ax(values[2]!), y: ay(values[3]!) }
        x = ax(values[4]!)
        y = ay(values[5]!)
        segments.push(['C', c1.x, c1.y, c2.x, c2.y, x, y])
        nextCubic = c2
        break
      }
      case 'S': {
        const c1 = lastCubic === null ? { x, y } : { x: 2 * x - lastCubic.x, y: 2 * y - lastCubic.y }
        const c2 = { x: ax(values[0]!), y: ay(values[1]!) }
        x = ax(values[2]!)
        y = ay(values[3]!)
        segments.push(['C', c1.x, c1.y, c2.x, c2.y, x, y])
        nextCubic = c2
        break
      }
      case 'Q': {
        const c = { x: ax(values[0]!), y: ay(values[1]!) }
        x = ax(values[2]!)
        y = ay(values[3]!)
        segments.push(['Q', c.x, c.y, x, y])
        nextQuadratic = c
        break
      }
      case 'T': {
        const c: { x: number; y: number } = lastQuadratic === null ? { x, y } : { x: 2 * x - lastQuadratic.x, y: 2 * y - lastQuadratic.y }
        x = ax(values[0]!)
        y = ay(values[1]!)
        segments.push(['Q', c.x, c.y, x, y])
        nextQuadratic = c
        break
      }
      case 'A': {
        const endX = ax(values[5]!)
        const endY = ay(values[6]!)
        segments.push(...arcToCubics(x, y, values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, endX, endY))
        x = endX
        y = endY
        break
      }
      case 'Z':
        segments.push(['Z'])
        x = startX
        y = startY
        break
    }
    lastCubic = nextCubic
    lastQuadratic = nextQuadratic
    if (segments.length > MAX_PATH_SEGMENTS) return { error: `路径太长，最多 ${MAX_PATH_SEGMENTS} 段。` }
  }
  if (segments.length < 2) return { error: '路径至少要有一段线或曲线。' }
  for (const segment of segments) {
    for (const value of segment.slice(1) as number[]) {
      if (!Number.isFinite(value) || value < MIN_COORDINATE || value > MAX_COORDINATE) {
        return { error: `坐标 ${Number.isFinite(value) ? Math.round(value) : value} 超出范围；坐标是框内的 0–100，可以略超出，但要在 ${MIN_COORDINATE}–${MAX_COORDINATE} 之间。` }
      }
    }
  }
  return { segments }
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** Writes segments back as path data, each point mapped through `map`. */
export function formatPathSegments(segments: readonly PathSegment[], map: (x: number, y: number) => readonly [number, number] = (x, y) => [x, y]): string {
  return segments.map((segment) => {
    if (segment[0] === 'Z') return 'Z'
    const values = segment.slice(1) as number[]
    const points: string[] = []
    for (let index = 0; index < values.length; index += 2) {
      const [px, py] = map(values[index]!, values[index + 1]!)
      points.push(`${round(px)} ${round(py)}`)
    }
    return `${segment[0]}${points.join(' ')}`
  }).join('')
}

/** The stored form of a path written by a person or a model, or why it cannot be used. */
export function normalizeSvgPath(text: string): { readonly path: string } | { readonly error: string } {
  const parsed = parseSvgPath(text)
  return 'error' in parsed ? parsed : { path: formatPathSegments(parsed.segments) }
}

/** Path data for a stored path drawn into a box of this size at this position. */
export function pathInBox(path: string, width: number, height: number, left = 0, top = 0): string {
  const parsed = parseSvgPath(path)
  if ('error' in parsed) return ''
  return formatPathSegments(parsed.segments, (x, y) => [left + x / 100 * width, top + y / 100 * height])
}

/** Whether every subpath ends with Z, so the outline encloses an area to fill. */
export function isClosedPath(path: string): boolean {
  const parsed = parseSvgPath(path)
  if ('error' in parsed) return false
  let open = false
  for (const segment of parsed.segments) {
    if (segment[0] === 'M') {
      if (open) return false
      open = true
    } else if (segment[0] === 'Z') open = false
  }
  return !open
}
