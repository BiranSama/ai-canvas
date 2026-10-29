import { useEffect, useRef, useState } from 'react'
import type { SubjectModelStatus } from '../../../shared/segmentation'
import { useModalScope } from '../interaction/use-modal-scope'
import { useSubjectModelDialog } from './subject-model-store'

const MB = 1024 * 1024

/**
 * Downloading Select Subject's model: what it is and how big, a mirror for
 * when GitHub is slow, a progress bar, and cancel. An interrupted download
 * resumes; the file is checked before it is used.
 */
export function SubjectModelDialog(): React.JSX.Element | null {
  const open = useSubjectModelDialog((state) => state.open)
  return open ? <SubjectModelSheet /> : null
}

function SubjectModelSheet(): React.JSX.Element {
  const finish = useSubjectModelDialog((state) => state.finish)
  const ref = useRef<HTMLFormElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const [status, setStatus] = useState<SubjectModelStatus | null>(null)
  const [mirror, setMirror] = useState('')
  const close = (): void => {
    if (status?.state === 'downloading' || status?.state === 'verifying') void window.desktop.cancelSubjectModelDownload()
    finish(false)
  }
  useModalScope(ref, close, { initialFocus: primary })

  useEffect(() => {
    let live = true
    void window.desktop.subjectModelStatus().then((next) => { if (live) setStatus(next) })
    const stop = window.desktop.onSubjectModelStatus((next) => setStatus(next))
    return () => { live = false; stop() }
  }, [])
  useEffect(() => {
    if (status?.state === 'ready') finish(true)
  }, [finish, status?.state])

  const busy = status?.state === 'downloading' || status?.state === 'verifying'
  const received = status?.receivedBytes ?? 0
  const total = status?.totalBytes ?? 1
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close() }}>
      <form
        ref={ref}
        className="edit-dialog subject-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="下载选择主体模型"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) { void window.desktop.cancelSubjectModelDownload(); return }
          void window.desktop.downloadSubjectModel({ mirrorUrl: mirror.trim() === '' ? null : mirror.trim() }).then(setStatus)
        }}
      >
        <h2>下载「选择主体」模型</h2>
        <p>选择主体在这台电脑上用开源模型 ISNet（Apache 2.0）完成，不上传图片。第一次使用需要下载约 {Math.round(total / MB)} MB，下载后会校验文件。</p>
        <label className="edit-dialog-field">
          <span>下载地址</span>
          <input type="url" placeholder="默认从 GitHub 下载；也可以填镜像地址" value={mirror} disabled={busy} onChange={(event) => setMirror(event.currentTarget.value)} />
        </label>
        {(busy || received > 0) && (
          <div className="subject-model-progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={received}>
            <span style={{ width: `${Math.min(100, received / total * 100)}%` }} />
            <small>{status?.state === 'verifying' ? '正在校验…' : `${(received / MB).toFixed(1)} / ${(total / MB).toFixed(0)} MB`}</small>
          </div>
        )}
        {status?.state === 'failed' && status.error !== null && <p className="subject-model-error" role="alert">{status.error}</p>}
        <footer>
          <button type="button" onClick={close}>{busy ? '取消并关闭' : '关闭'}</button>
          <button ref={primary} type="submit" className="is-primary">{busy ? '取消下载' : received > 0 ? '继续下载' : '下载'}</button>
        </footer>
      </form>
    </div>
  )
}
