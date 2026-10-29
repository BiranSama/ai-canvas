import { create } from 'zustand'

/*
 * The dialog that fetches Select Subject's model the first time it is
 * needed. Whatever needed the model waits on show() and goes on once the
 * model is ready, or stops if the person closes the dialog.
 */

interface SubjectModelDialogState {
  readonly open: boolean
  show(): Promise<boolean>
  finish(ready: boolean): void
}

let waiting: Array<(ready: boolean) => void> = []

export const useSubjectModelDialog = create<SubjectModelDialogState>()((set) => ({
  open: false,
  show: () => new Promise<boolean>((resolve) => {
    waiting.push(resolve)
    set({ open: true })
  }),
  finish: (ready) => {
    const resolved = waiting
    waiting = []
    set({ open: false })
    for (const resolve of resolved) resolve(ready)
  }
}))

/** True once the model is on this computer, asking to download it first if it is not. */
export async function ensureSubjectModel(): Promise<boolean> {
  const status = await window.desktop.subjectModelStatus()
  return status.state === 'ready' ? true : useSubjectModelDialog.getState().show()
}
