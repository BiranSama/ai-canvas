import type { Canvas, CreativeContext, Scene, SceneElement, SceneRelation } from '../../../domain'
import type { ProviderPublicConfig } from '../../../shared/provider-settings'
import type { TurnModelUsage } from '../../../shared/model-usage'
import type { AgentEvalCase } from './case-schema'
import type { EvalNetwork, EvalRequestLogEntry } from './network'

/**
 * The seam between the eval set and an agent engine. An engine receives a
 * case and an installed network, and returns only engine-neutral evidence:
 * project state, persisted turn records and the provider request log.
 */

export interface EvalEngineDescriptor {
  readonly id: string
  /** Bump when the engine's behaviour changes in a way that invalidates recordings. */
  readonly version: number
  readonly label: string
}

export interface EvalSceneContext {
  importImage(input: { readonly name: string; readonly bytes: Buffer }): Promise<{ readonly id: string; readonly width: number; readonly height: number }>
}

export interface EvalSceneFixture {
  readonly canvas?: Canvas
  readonly creativeContext?: CreativeContext | null
  readonly elements: readonly SceneElement[]
  readonly relations?: readonly SceneRelation[]
}

/** Builds the starting project for a case; null keeps the new, empty project. */
export type EvalSceneBuilder = (context: EvalSceneContext) => Promise<EvalSceneFixture | null>
export type EvalSceneRegistry = Readonly<Record<string, EvalSceneBuilder>>

export type EvalLlmProviderConfig = Extract<ProviderPublicConfig, { kind: 'llm' }>

export interface EvalCaseContext {
  readonly evalCase: AgentEvalCase
  readonly run: number
  readonly scenes: EvalSceneRegistry
  readonly llm: EvalLlmProviderConfig
  /** Held in memory by the engine's secret store only. */
  readonly apiKey: string
  readonly network: EvalNetwork
  readonly workDirectory: string
  readonly turnTimeoutMs: number
}

export interface EvalDecisionObservation {
  readonly kind: string
  readonly title: string
  readonly optionId: string
  readonly approvesGeneration: boolean
  /** Position on the network clock when the simulated user answered. */
  readonly seq: number
}

export interface EvalTurnObservation {
  readonly index: number
  readonly role: 'setup' | 'evaluated'
  readonly text: string
  /** Terminal turn status, or `timeout` / `not_started`. */
  readonly status: string
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly toolSteps: number
  readonly modelCalls: number
  readonly decisions: readonly EvalDecisionObservation[]
  /** The assistant's replies and receipts for this turn. */
  readonly replyText: string
  /** Text-model usage the turn's receipt reports, when the engine records it. */
  readonly modelUsage: TurnModelUsage | null
  /** Copy of the decisions the user was asked to make in this turn. */
  readonly decisionText: string
  readonly startedSeq: number
  readonly endedSeq: number
  readonly durationMs: number
}

export interface EvalJobObservation {
  readonly id: string
  readonly providerId: string
  readonly status: string
  readonly imageCount: number
  readonly resultCount: number
  readonly setup: boolean
}

export interface EvalObservation {
  readonly caseId: string
  readonly run: number
  readonly engine: EvalEngineDescriptor
  readonly setupError: string | null
  readonly scenes: {
    readonly caseStart: Scene
    readonly afterSetupTurns: readonly Scene[]
    readonly beforeTurn: Scene
    readonly final: Scene
  }
  readonly turns: readonly EvalTurnObservation[]
  readonly network: readonly EvalRequestLogEntry[]
  readonly jobs: readonly EvalJobObservation[]
  readonly directives: readonly { readonly text: string; readonly enabled: boolean }[]
  /** Pre-request cost ceilings the transport security layer reserved for text-model calls. */
  readonly reservedLlmCostCny: number
  readonly undo: { readonly restored: boolean; readonly steps: number; readonly detail: string | null }
  readonly durationMs: number
}

export interface EvalAgentEngine {
  readonly descriptor: EvalEngineDescriptor
  runCase(context: EvalCaseContext): Promise<EvalObservation>
}
