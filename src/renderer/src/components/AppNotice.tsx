import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useAppNotice } from './app-notice'

const INFO_SECONDS = 20

export function AppNotice(): React.JSX.Element | null {
  const notice = useAppNotice((state) => state.notice)
  const dismiss = useAppNotice((state) => state.dismiss)
  // Information fades on its own; a problem stays until it is closed.
  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = window.setTimeout(dismiss, INFO_SECONDS * 1000)
    return () => window.clearTimeout(timer)
  }, [notice, dismiss])
  if (notice === null) return null
  return (
    <div key={notice.id} className={`app-notice is-${notice.tone}`} role={notice.tone === 'problem' ? 'alert' : 'status'}>
      <p>{notice.text}</p>
      <button type="button" aria-label="关闭提示" onClick={dismiss}><X size={14} aria-hidden="true" /></button>
    </div>
  )
}
