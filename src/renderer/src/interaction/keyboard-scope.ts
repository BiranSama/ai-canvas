const modalStack: HTMLElement[] = []
const previousInert = new Map<HTMLElement, boolean>()

export const MODAL_SCOPE_CHANGED = 'ai-canvas:modal-scope-changed'

export function activeModal(): HTMLElement | null {
  return [...modalStack].reverse().find((element) => element.isConnected) ?? null
}

function updateInert(): void {
  for (const [element, wasInert] of previousInert) element.inert = wasInert
  previousInert.clear()
  let branch: HTMLElement | null = activeModal()
  while (branch !== null && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement
    for (const sibling of parent?.children ?? []) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue
      previousInert.set(sibling, sibling.inert)
      sibling.inert = true
    }
    branch = parent
  }
  window.dispatchEvent(new Event(MODAL_SCOPE_CHANGED))
}

export function registerModal(element: HTMLElement): () => void {
  modalStack.push(element)
  updateInert()
  return () => {
    const index = modalStack.lastIndexOf(element)
    if (index !== -1) modalStack.splice(index, 1)
    updateInert()
  }
}

function targetElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : document.activeElement
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  return targetElement(target)?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]') != null
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = targetElement(target)
  const customControl = element?.closest('[tabindex]')
  return (customControl != null && !customControl.matches('.canvas-stage'))
    || element?.closest('button, summary, a[href], input, textarea, select, [contenteditable], [role="button"], [role="slider"], [role="separator"], [role="toolbar"][tabindex], [role="option"], [role="menuitem"], [role="tab"], [role="dialog"], [role="alertdialog"]') != null
}

export function canvasKeyboardBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || activeModal() !== null || isTextInputTarget(event.target)) return true
  if (targetElement(event.target)?.closest('[role="separator"], [role="slider"], [role="toolbar"][tabindex]')) return true
  return !(event.ctrlKey || event.metaKey) && isInteractiveTarget(event.target)
}

export function canvasPasteBlocked(event: ClipboardEvent): boolean {
  return event.defaultPrevented || activeModal() !== null || isTextInputTarget(event.target)
}
