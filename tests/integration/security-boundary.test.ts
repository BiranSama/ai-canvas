import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron security boundary', () => {
  it('keeps Node disabled and the renderer sandboxed', () => {
    const source = readFileSync(resolve('src/main/window.ts'), 'utf8')

    expect(source).toContain('contextIsolation: true')
    expect(source).toContain('nodeIntegration: false')
    expect(source).toContain('sandbox: true')
    expect(source).toContain("action: 'deny'")
  })

  it('exposes a single narrow preload method', () => {
    const source = readFileSync(resolve('src/preload/index.ts'), 'utf8')

    expect(source).toContain("exposeInMainWorld('desktop'")
    expect(source).toContain('getRuntimeInfo')
    expect(source).not.toMatch(/\b(readFile|writeFile|exec|spawn|shell)\b/)
  })
})

