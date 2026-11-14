import { Sparkles } from 'lucide-react'
import { useBrandStore } from '../store/brand-store'

/** 有 N 条偏好等你确认: learned or proposed preferences, opened in 品牌与记忆. */
export function PendingPreferencesNotice(): React.JSX.Element | null {
  const pending = useBrandStore((state) => state.pendingPreferences)
  if (pending === 0) return null
  return (
    <button type="button" className="pending-preferences" data-testid="pending-preferences"
      onClick={() => window.dispatchEvent(new CustomEvent('ai-canvas:open-provider-settings', { detail: { section: 'brand' } }))}>
      <Sparkles size={12} aria-hidden="true" />有 {pending} 条偏好等你确认
    </button>
  )
}
