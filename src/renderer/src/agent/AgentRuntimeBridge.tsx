import { useEffect } from 'react'
import type { AgentEvent } from '../../../shared/agent-harness'
import { notifyAgentUpdated, notifyAgentTransportUpdated, recordAgentEvent } from './agent-event-stream'

/**
 * Runs agent tools independently of the visible workspace. Conversation and
 * canvas surfaces are projections of the same persisted run, not executors.
 */
export function AgentRuntimeBridge(): null {
  useEffect(() => {
    if (typeof window.desktop.onAgentEvent !== 'function'
      || typeof window.desktop.getAgentHarnessSnapshot !== 'function'
      || typeof window.desktop.replayAgentEvents !== 'function') {
      // A stale preload or a deliberately narrow test double must not white-screen
      // the workspace. The visible surfaces can still perform an initial snapshot.
      return undefined
    }
    let disposed = false
    let cursor = 0
    let reconcile = Promise.resolve()
    const deliver = (event: AgentEvent): void => {
      if (disposed) return
      const providerEvent = event.type.startsWith('provider.attempt.')
      if (event.sequence <= cursor && !providerEvent) return
      cursor = Math.max(cursor, event.sequence)
      if (!recordAgentEvent(event)) return
      if (providerEvent) notifyAgentTransportUpdated()
      else notifyAgentUpdated()
    }
    const receive = (event: AgentEvent): void => {
      reconcile = reconcile.then(async () => {
        if (event.sequence > cursor + 1) {
          for (const missed of await window.desktop.replayAgentEvents(cursor)) deliver(missed)
        }
        deliver(event)
      }).catch(() => undefined)
    }
    const unsubscribe = window.desktop.onAgentEvent(receive)
    void window.desktop.getAgentHarnessSnapshot().then(async (snapshot) => {
      if (disposed) return
      for (const event of await window.desktop.replayAgentEvents(cursor)) deliver(event)
      cursor = Math.max(cursor, snapshot.lastSequence)
      notifyAgentUpdated()
    }).catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return null
}
