import { X } from 'lucide-react'
import { useRef } from 'react'
import { SHORTCUT_SHEET } from '../interaction/photoshop-shortcuts'
import { useModalScope } from '../interaction/use-modal-scope'

/** Every key the canvas answers to, grouped as Photoshop's shortcut list is. On a Mac, Ctrl is ⌘. */
export function ShortcutSheet({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const modalRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModalScope(modalRef, onClose, { initialFocus: closeRef })
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={modalRef} tabIndex={-1} className="shortcut-sheet" role="dialog" aria-label="快捷键" aria-modal="true">
        <header>
          <div>
            <h2>快捷键</h2>
            <p>与 Photoshop 一致。Mac 上 Ctrl 换成 ⌘，Alt 换成 Option。</p>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="关闭快捷键" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="shortcut-groups">
          {SHORTCUT_SHEET.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <div key={entry.keys}>
                    <dt><kbd>{entry.keys}</kbd></dt>
                    <dd>{entry.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  )
}
