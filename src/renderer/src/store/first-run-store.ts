import { create } from 'zustand'

const GUIDE_KEY = 'ai-canvas.first-run-guide.dismissed'
const SERVICE_CARD_KEY = 'ai-canvas.service-connect.dismissed'

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, 'true')
    else globalThis.localStorage?.removeItem(key)
  } catch {
    // Without storage the choice only lasts until the app closes.
  }
}

interface FirstRunState {
  /** The three-step guide in an empty conversation was put away with 「知道了」. */
  readonly guideDismissed: boolean
  /** The service card in the project library was put away. */
  readonly serviceCardDismissed: boolean
  dismissGuide(): void
  dismissServiceCard(): void
  /** 「重新显示新手指引」 in the settings: both come back. */
  showAgain(): void
}

/** What a new install shows once, and remembers having been put away. */
export const useFirstRunStore = create<FirstRunState>((set) => ({
  guideDismissed: readFlag(GUIDE_KEY),
  serviceCardDismissed: readFlag(SERVICE_CARD_KEY),
  dismissGuide: () => {
    writeFlag(GUIDE_KEY, true)
    set({ guideDismissed: true })
  },
  dismissServiceCard: () => {
    writeFlag(SERVICE_CARD_KEY, true)
    set({ serviceCardDismissed: true })
  },
  showAgain: () => {
    writeFlag(GUIDE_KEY, false)
    writeFlag(SERVICE_CARD_KEY, false)
    set({ guideDismissed: false, serviceCardDismissed: false })
  }
}))
