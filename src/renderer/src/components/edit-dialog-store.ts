import { create } from 'zustand'

/** Which of Photoshop's small edit dialogs is open: Shift+F6 feather, Shift+F5 fill. */
export type EditDialog = 'feather' | 'fill'

export const useEditDialog = create<{ readonly open: EditDialog | null; show(dialog: EditDialog): void; close(): void }>()((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null })
}))
