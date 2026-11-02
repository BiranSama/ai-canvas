import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { describeAppUpdate } from '../../../shared/app-update'
import { useAppUpdate } from '../store/use-app-update'

/** 高级 → 版本与更新: which version this is, where updating stands, and 检查更新. */
export function AppUpdateSettings(): React.JSX.Element {
  const update = useAppUpdate()
  const [asking, setAsking] = useState(false)
  const status = update?.status
  const busy = asking || status?.kind === 'checking' || status?.kind === 'downloading'
  const canCheck = status !== undefined && status.kind !== 'unsupported' && status.kind !== 'ready'

  const check = async (): Promise<void> => {
    setAsking(true)
    try {
      await window.desktop.checkForAppUpdate()
    } catch {
      // Main reports how the check went through the update status.
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="settings-app-update" aria-label="版本与更新">
      <span>
        <strong>版本 {update?.currentVersion ?? '…'}</strong>
        <small role="status">{status === undefined ? '正在读取…' : describeAppUpdate(status)}</small>
      </span>
      {canCheck && (
        <button type="button" className="settings-save" disabled={busy} onClick={() => void check()}>
          <RefreshCw size={13} aria-hidden="true" />{status.kind === 'downloading' ? '正在下载…' : busy ? '正在检查…' : '检查更新'}
        </button>
      )}
    </div>
  )
}
