import { create } from 'zustand'

export type NoticeTone = 'info' | 'problem'

interface NoticeState {
  readonly notice: { readonly id: number; readonly text: string; readonly tone: NoticeTone } | null
  show(text: string, tone: NoticeTone): void
  dismiss(): void
}

export const useAppNotice = create<NoticeState>((set) => ({
  notice: null,
  show: (text, tone) => set((state) => ({ notice: { id: (state.notice?.id ?? 0) + 1, text, tone } })),
  dismiss: () => set({ notice: null })
}))

/** One line at the top of the window, for what happened outside any panel: a file that opened with changes, or did not open. */
export function showAppNotice(text: string, tone: NoticeTone = 'info'): void {
  useAppNotice.getState().show(text, tone)
}
