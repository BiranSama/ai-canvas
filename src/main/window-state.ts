import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserWindow, Rectangle } from 'electron'
import { screen } from 'electron'
import { z } from 'zod'

const windowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(1024).max(16_384),
    height: z.number().int().min(700).max(16_384)
  }),
  maximized: z.boolean()
})

export type WindowState = z.infer<typeof windowStateSchema>

function visibleOnCurrentDisplays(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x))
    const overlapHeight = Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y))
    return overlapWidth >= 160 && overlapHeight >= 100
  })
}

export function readWindowState(filePath: string): WindowState | null {
  try {
    const parsed = windowStateSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
    return visibleOnCurrentDisplays(parsed.bounds) ? parsed : null
  } catch {
    return null
  }
}

export function writeWindowState(filePath: string, value: WindowState): void {
  const parsed = windowStateSchema.parse(value)
  const temporaryPath = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

export function trackWindowState(window: BrowserWindow, filePath: string): void {
  let timer: NodeJS.Timeout | null = null
  const snapshot = (): WindowState => ({
    version: 1,
    bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized()
  })
  const persist = (): void => {
    if (window.isDestroyed() || window.isMinimized()) return
    try {
      writeWindowState(filePath, snapshot())
    } catch {
      // Window state is convenience data; a failed write must never block closing the project.
    }
  }
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      persist()
    }, 250)
  }
  window.on('move', schedule)
  window.on('resize', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    persist()
  })
}
