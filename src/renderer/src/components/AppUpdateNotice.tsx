import { Download } from 'lucide-react'
import { useState } from 'react'
import type { DesktopApi } from '../../../shared/desktop-api'
import { useAppUpdate } from '../store/use-app-update'
import { flushProjectWorkContext } from '../store/project-context-sync'

/** Versions put off with 「稍后」 in this run; they install when the app quits. */
const postponed = new Set<string>()

/**
 * 「新版本 x.y.z 已准备好」 once a new version has downloaded, with 重启更新
 * and 稍后. The work in progress is saved before the restart.
 */
export function AppUpdateNotice(): React.JSX.Element | null {
  const update = useAppUpdate()
  const [, setPostponedCount] = useState(postponed.size)
  const [restarting, setRestarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const status = update?.status
  if (status?.kind !== 'ready' || postponed.has(status.version)) return null

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setProblem(null)
    try {
      await flushProjectWorkContext()
      if (await (window.desktop as Partial<DesktopApi> | undefined)?.installAppUpdate?.() !== true) throw new Error('没有找到下载好的新版本。')
    } catch (error) {
      setRestarting(false)
      setProblem(error instanceof Error ? error.message : '没能重启，请稍后再试。')
    }
  }

  const later = (): void => {
    postponed.add(status.version)
    setPostponedCount(postponed.size)
  }

  return (
    <div className="app-update-notice" role="status" aria-label="新版本">
      <Download size={13} aria-hidden="true" />
      <span title="不重启的话，退出时会自动装好。">新版本 {status.version} 已准备好</span>
      <button type="button" className="is-primary" disabled={restarting} onClick={() => void restart()}>{restarting ? '正在重启…' : '重启更新'}</button>
      <button type="button" disabled={restarting} onClick={later}>稍后</button>
      {problem !== null && <small role="alert">{problem}</small>}
    </div>
  )
}
