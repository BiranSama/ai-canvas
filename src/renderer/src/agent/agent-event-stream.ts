import type { AgentEvent } from '../../../shared/agent-harness'

export const AGENT_UPDATED_EVENT = 'ai-canvas:agent-updated'
const AGENT_TRANSPORT_UPDATED_EVENT = 'ai-canvas:agent-transport-updated'
const MAX_RETAINED_AGENT_EVENTS = 2_000
let retainedEvents: AgentEvent[] = []

export function recordAgentEvent(event: AgentEvent): boolean {
  const existing = retainedEvents.findIndex((candidate) => candidate.id === event.id
    || candidate.threadId === event.threadId && candidate.sequence === event.sequence)
  if (existing >= 0 && Date.parse(retainedEvents[existing]!.createdAt) >= Date.parse(event.createdAt)) return false
  if (existing >= 0) retainedEvents[existing] = event
  else retainedEvents.push(event)
  retainedEvents.sort((left, right) => left.sequence - right.sequence)
  if (retainedEvents.length > MAX_RETAINED_AGENT_EVENTS) retainedEvents = retainedEvents.slice(-MAX_RETAINED_AGENT_EVENTS)
  return true
}

export function agentEventsForTurn(turnId: string | null): readonly AgentEvent[] {
  return turnId === null ? [] : retainedEvents.filter((event) => event.turnId === turnId).slice(-500)
}

export function resetRetainedAgentEventsForTests(): void {
  retainedEvents = []
}

export function notifyAgentUpdated(): void {
  window.dispatchEvent(new Event(AGENT_UPDATED_EVENT))
}

export function subscribeAgentUpdates(listener: () => void): () => void {
  window.addEventListener(AGENT_UPDATED_EVENT, listener)
  return () => window.removeEventListener(AGENT_UPDATED_EVENT, listener)
}

/** Live transport facts do not require a second Main snapshot or polling. */
export function notifyAgentTransportUpdated(): void {
  window.dispatchEvent(new Event(AGENT_TRANSPORT_UPDATED_EVENT))
}

export function subscribeAgentTransportUpdates(listener: () => void): () => void {
  window.addEventListener(AGENT_TRANSPORT_UPDATED_EVENT, listener)
  return () => window.removeEventListener(AGENT_TRANSPORT_UPDATED_EVENT, listener)
}
