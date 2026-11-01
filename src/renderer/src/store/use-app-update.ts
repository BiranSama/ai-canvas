import { useEffect, useState } from 'react'
import type { AppUpdateSnapshot } from '../../../shared/app-update'
import type { DesktopApi } from '../../../shared/desktop-api'

function desktop(): Partial<DesktopApi> | undefined {
  return window.desktop as Partial<DesktopApi> | undefined
}

/** This copy's version and where updating it stands, kept current; null until Main has answered. */
export function useAppUpdate(): AppUpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null)
  useEffect(() => {
    let current = true
    const api = desktop()
    api?.getAppUpdate?.().then((value) => { if (current) setSnapshot(value) }).catch(() => undefined)
    const unsubscribe = api?.onAppUpdate?.((value) => { if (current) setSnapshot(value) })
    return () => {
      current = false
      unsubscribe?.()
    }
  }, [])
  return snapshot
}
