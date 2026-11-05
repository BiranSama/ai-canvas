import { create } from 'zustand'

/** Whether the 导出 panel is open; the header, the conversation and Ctrl+Alt+Shift+W open it. */
export const useExportSheet = create<{ readonly open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false })
}))
