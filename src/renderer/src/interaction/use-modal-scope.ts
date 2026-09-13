import { useLayoutEffect, useRef, type RefObject } from 'react'
import { activeModal, registerModal } from './keyboard-scope'

const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]'

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.tabIndex >= 0
    && !element.matches(':disabled, [hidden]') && !element.closest('[inert]') && element.getClientRects().length > 0)
}

/** A modal owns focus, Escape and background interaction for its whole lifetime. */
export function useModalScope(rootRef: RefObject<HTMLElement | null>, onClose: () => void,
  { active: enabled = true, initialFocus: initialRef, returnFocus: returnRef }: {
    active?: boolean; initialFocus?: RefObject<HTMLElement | null>; returnFocus?: RefObject<HTMLElement | null>
  } = {}): void {
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose }, [onClose])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!enabled || root === null) return
    const previous = returnRef?.current ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null)
    const unregister = registerModal(root)
    const focusFirst = (): void => (initialRef?.current ?? focusable(root)[0] ?? root).focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (activeModal() !== root || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
      } else if (event.key === 'Tab') {
        const choices = focusable(root)
        const current = document.activeElement
        const first = choices[0] ?? root
        const last = choices.at(-1) ?? root
        if (!root.contains(current) || choices.length === 0 || (event.shiftKey ? current === first : current === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus({ preventScroll: true })
        }
      }
    }
    const onFocus = (event: FocusEvent): void => {
      if (activeModal() === root && event.target instanceof Node && !root.contains(event.target)) focusFirst()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    focusFirst()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      unregister()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
      else {
        const parent = activeModal()
        if (parent !== null) (focusable(parent)[0] ?? parent).focus({ preventScroll: true })
      }
    }
  }, [enabled, initialRef, returnRef, rootRef])
}
