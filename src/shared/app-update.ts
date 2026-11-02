/** Why this copy of the app does not update itself. */
export type AppUpdateUnsupportedReason = 'development' | 'portable' | 'platform'

export type AppUpdateStatus =
  | { readonly kind: 'unsupported'; readonly reason: AppUpdateUnsupportedReason }
  /** Up to date as of the last check; checkedAt is null before the first one. */
  | { readonly kind: 'idle'; readonly checkedAt: string | null }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  /** Downloaded; installs on restart, or when the app quits. */
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'failed'; readonly checkedAt: string }

export interface AppUpdateSnapshot {
  readonly currentVersion: string
  readonly status: AppUpdateStatus
}

function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** One line for the settings, in the person's words. */
export function describeAppUpdate(status: AppUpdateStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return status.reason === 'portable'
        ? '便携版不会自动更新，新版本请到发布页下载。'
        : status.reason === 'development' ? '开发版不会自动更新。' : '这个系统上不会自动更新。'
    case 'idle':
      return status.checkedAt === null ? '启动后会自动检查更新。' : `已是最新版本（${clock(status.checkedAt)} 检查）。`
    case 'checking':
      return '正在检查更新…'
    case 'downloading':
      return `正在后台下载新版本 ${status.version}（${Math.round(status.percent)}%）。`
    case 'ready':
      return `新版本 ${status.version} 已准备好，重启后更新；不重启的话，退出时会自动装好。`
    case 'failed':
      return `检查更新没有成功（${clock(status.checkedAt)}），可能是连不上 GitHub，过一会儿会再试。`
  }
}
