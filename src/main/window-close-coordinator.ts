import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { DESKTOP_CHANNELS, DESKTOP_EVENTS } from '../shared/desktop-api'

const closeReceipt = z.object({ requestId: z.string().uuid(), saved: z.boolean() }).strict()

// Close is deferred before Chromium's unload path, so saving neither opens an
// unload prompt nor races a destroyed Renderer. Only this window can acknowledge
// its one pending close request. A failed save leaves its project available.
export function coordinateWindowClose(window: BrowserWindow): void {
  let ready = false
  let pending: string | null = null
  const owner = window.webContents.id
  const onReady = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender.id === owner && typeof value === 'boolean') ready = value
  }
  const onReceipt = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender.id !== owner) return
    const parsed = closeReceipt.safeParse(value)
    if (!parsed.success || parsed.data.requestId !== pending) return
    pending = null
    if (parsed.data.saved) window.destroy()
    else window.focus()
  }
  ipcMain.on(DESKTOP_CHANNELS.windowCloseReady, onReady)
  ipcMain.on(DESKTOP_CHANNELS.windowCloseReceipt, onReceipt)
  window.on('close', (event) => {
    if (!ready) return
    event.preventDefault()
    if (pending !== null) return
    pending = randomUUID()
    window.webContents.send(DESKTOP_EVENTS.windowClosing, pending)
  })
  window.once('closed', () => {
    ipcMain.removeListener(DESKTOP_CHANNELS.windowCloseReady, onReady)
    ipcMain.removeListener(DESKTOP_CHANNELS.windowCloseReceipt, onReceipt)
  })
}
