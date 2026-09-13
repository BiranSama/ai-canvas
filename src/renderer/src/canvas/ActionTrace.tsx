import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentActivity, ConversationSnapshot } from '../../../shared/agent'
import type { DesktopApi } from '../../../shared/desktop-api'
import type { SceneElement } from '../../../domain'
import { subscribeAgentUpdates } from '../agent/agent-event-stream'
import { useWorkspaceStore } from '../store/workspace-store'
import { useCanvasViewportStore } from './canvas-viewport-store'

const TRACE_HOLD_MS = 2_400
const TRACE_MAX_TARGETS = 3

interface TraceTarget {
  readonly id: string
  readonly x: number
  readonly y: number
}

// The Prismatic Action Trace is the single allowed signature flourish: a thin,
// low-saturation spectral path from the Agent composer to the real canvas
// objects an Agent operation just touched. It never renders without a real
// activity with real affected element ids, and it always dissolves on its own.
function latestTraceableActivity(snapshot: ConversationSnapshot | null): AgentActivity | null {
  if (snapshot === null) return null
  const now = Date.now()
  for (const activity of [...snapshot.activities].reverse()) {
    if (activity.affectedIds.length === 0) continue
    if (activity.state === 'running') return activity
    if (activity.state !== 'completed' || activity.endedAt === null) return null
    return now - new Date(activity.endedAt).getTime() < TRACE_HOLD_MS ? activity : null
  }
  return null
}

export function ActionTrace(): React.JSX.Element | null {
  const scene = useWorkspaceStore((state) => state.scene)
  const viewport = useCanvasViewportStore((state) => state.artboard)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
  const [expiredId, setExpiredId] = useState<string | null>(null)
  const [origin, setOrigin] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const overlayRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let mounted = true
    const refresh = (): void => {
      const desktop = window.desktop as Partial<Pick<DesktopApi, 'getConversationSnapshot'>> | undefined
      if (desktop?.getConversationSnapshot === undefined) return
      void desktop.getConversationSnapshot()
        .then((value) => { if (mounted) setSnapshot(value) })
        .catch(() => undefined)
    }
    const initial = window.setTimeout(refresh, 0)
    const unsubscribe = subscribeAgentUpdates(refresh)
    return () => {
      mounted = false
      window.clearTimeout(initial)
      unsubscribe()
    }
  }, [])

  const activity = latestTraceableActivity(snapshot)
  const visibleActivity = activity !== null && activity.id !== expiredId ? activity : null

  useEffect(() => {
    if (activity === null || activity.state === 'running' || activity.endedAt === null) return
    const remaining = new Date(activity.endedAt).getTime() + TRACE_HOLD_MS - Date.now()
    const timer = window.setTimeout(() => setExpiredId(activity.id), Math.max(40, remaining))
    return () => window.clearTimeout(timer)
  }, [activity])

  const targets: readonly TraceTarget[] = visibleActivity === null || viewport === null
    ? []
    : visibleActivity.affectedIds
      .map((id) => scene.elements.find((element) => element.id === id))
      .filter((element): element is SceneElement => element !== undefined && element.visible)
      .slice(0, TRACE_MAX_TARGETS)
      .map((element) => ({
        id: element.id,
        x: viewport.x + (element.transform.x + element.transform.width / 2) * viewport.width * viewport.zoom,
        y: viewport.y + (element.transform.y + element.transform.height / 2) * viewport.height * viewport.zoom
      }))

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (visibleActivity === null || targets.length === 0) {
        setOrigin(null)
        return
      }
      const overlay = overlayRef.current
      const composer = document.querySelector('[data-island-id="composer"]')
      if (overlay === null || composer === null) {
        setOrigin(null)
        return
      }
      const overlayRect = overlay.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      setOrigin({
        x: composerRect.left + composerRect.width / 2 - overlayRect.left,
        y: composerRect.top - overlayRect.top
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [visibleActivity, targets.length, viewport])

  if (visibleActivity === null || targets.length === 0) return null

  return (
    <svg ref={overlayRef} className="action-trace-overlay" aria-hidden="true" data-testid="action-trace">
      <defs>
        <linearGradient id="action-trace-spectrum" x1="0" y1="1" x2="0.35" y2="0">
          <stop offset="0" stopColor="#376BFF" />
          <stop offset="0.55" stopColor="#9276FF" />
          <stop offset="1" stopColor="#EAD9B8" />
        </linearGradient>
      </defs>
      {origin !== null && targets.map((target, index) => {
        const dy = target.y - origin.y
        const path = `M ${origin.x} ${origin.y} C ${origin.x} ${origin.y + dy * 0.42}, ${target.x} ${target.y - dy * 0.32}, ${target.x} ${target.y}`
        return (
          <g key={target.id}>
            <path className="action-trace-path" d={path} pathLength={1} style={{ animationDelay: `${index * 70}ms, ${1700 + index * 70}ms` }} />
            <circle className="action-trace-endpoint" cx={target.x} cy={target.y} r={3} style={{ animationDelay: `${380 + index * 70}ms, ${1700 + index * 70}ms` }} />
          </g>
        )
      })}
    </svg>
  )
}
