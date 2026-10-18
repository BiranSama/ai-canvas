import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { AgentModelEvalReport, AgentModelEvalRunResult } from '../../../shared/agent-eval'
import type { AgentEvalCase } from './case-schema'
import { EVAL_MOCK_IMAGE_BASE_URL, replayLlmProviderConfig, type EvalModelConfig } from './config'
import type { EvalAgentEngine, EvalLlmProviderConfig, EvalObservation, EvalSceneRegistry } from './engine'
import { evaluateRun, failedRun, type EvalPricing, type EvalRunProblem } from './evaluate'
import { EvalNetwork, LiveLlmUpstream, type LlmUpstream } from './network'
import {
  RecordingCollector,
  ReplayLlmUpstream,
  llmRequestShape,
  promptFingerprint,
  writeRecording,
  type AgentEvalRecording
} from './recording'
import { buildModelEvalReport, renderModelEvalMarkdown } from './report'

export type AgentEvalRunMode =
  | { readonly kind: 'live'; readonly config: EvalModelConfig; readonly record: boolean }
  | {
      readonly kind: 'replay'
      readonly recording: (caseId: string, run: number) => Promise<AgentEvalRecording | null>
      /** Serve the recorded responses without shape checks and hand back the re-stamped recording. */
      readonly refresh?: (recording: AgentEvalRecording) => Promise<void>
    }

export interface AgentEvalRunOptions {
  readonly cases: readonly AgentEvalCase[]
  readonly engine: EvalAgentEngine
  readonly scenes: EvalSceneRegistry
  readonly mode: AgentEvalRunMode
  readonly runs: number
  /** Case ids or categories; empty runs everything. */
  readonly caseFilter?: readonly string[]
  /** Where report, per-run evidence and recordings go; null writes nothing. */
  readonly outputDirectory: string | null
  readonly turnTimeoutMs?: number
  readonly onProgress?: (message: string) => void
}

export interface AgentEvalRunOutput {
  readonly report: AgentModelEvalReport
  readonly observations: readonly EvalObservation[]
  readonly files: { readonly json: string; readonly markdown: string } | null
}

const REPLAY_CREDENTIAL = 'agent-eval-replay-credential'

export function selectEvalCases(cases: readonly AgentEvalCase[], filter: readonly string[]): readonly AgentEvalCase[] {
  if (filter.length === 0) return cases
  const selected = cases.filter((entry) => filter.includes(entry.id) || filter.includes(entry.category))
  const unknown = filter.filter((value) => !cases.some((entry) => entry.id === value || entry.category === value))
  if (unknown.length > 0) throw new Error(`Unknown eval case or category: ${unknown.join(', ')}.`)
  return selected
}

function replayProblems(upstream: ReplayLlmUpstream | null): readonly EvalRunProblem[] {
  if (upstream === null) return []
  return upstream.finish().map((problem) => ({
    code: problem.code === 'STALE_PROMPT' || problem.code === 'STALE_ENGINE' ? 'STALE_RECORDING' as const : 'REPLAY_MISMATCH' as const,
    message: problem.message
  }))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Runs every selected case `runs` times, one at a time, and builds the report. */
export async function runAgentEval(options: AgentEvalRunOptions): Promise<AgentEvalRunOutput> {
  const cases = selectEvalCases(options.cases, options.caseFilter ?? [])
  const engine = options.engine
  const realFetch = globalThis.fetch
  const pricing: EvalPricing = options.mode.kind === 'live'
    ? options.mode.config.pricing
    : { inputCnyPerMillionTokens: null, outputCnyPerMillionTokens: null }
  const results: { evalCase: AgentEvalCase; runs: AgentModelEvalRunResult[] }[] = []
  const observations: EvalObservation[] = []
  let reportLlm: EvalLlmProviderConfig | null = options.mode.kind === 'live' ? options.mode.config.provider : null

  for (const evalCase of cases) {
    const runs: AgentModelEvalRunResult[] = []
    for (let run = 1; run <= options.runs; run += 1) {
      const startedAt = Date.now()
      let llm: EvalLlmProviderConfig
      let apiKey: string
      let upstream: LlmUpstream
      let replay: ReplayLlmUpstream | null = null
      if (options.mode.kind === 'live') {
        llm = options.mode.config.provider
        apiKey = options.mode.config.apiKey
        upstream = new LiveLlmUpstream(realFetch)
      } else {
        const recording = await options.mode.recording(evalCase.id, run)
        const stale = recording === null
          ? `No recording exists for ${evalCase.id}#${run}.`
          : recording.caseId !== evalCase.id
            ? `Recording for ${recording.caseId} was supplied for ${evalCase.id}.`
            : recording.engine.id !== engine.descriptor.id || (recording.engine.version !== engine.descriptor.version && options.mode.refresh === undefined)
              ? `Recording ${evalCase.id}#${run} is stale: it was made with engine ${recording.engine.id} v${recording.engine.version}, the current engine is ${engine.descriptor.id} v${engine.descriptor.version}. Re-record it with pnpm eval:agent.`
              : null
        if (recording === null || stale !== null) {
          runs.push(failedRun(run, { code: recording === null ? 'RUN_ERROR' : 'STALE_RECORDING', message: stale ?? 'Missing recording.' }, Date.now() - startedAt))
          options.onProgress?.(`${evalCase.id} #${run}: ${stale}`)
          continue
        }
        llm = replayLlmProviderConfig(recording.llm.protocol, recording.llm.transport)
        apiKey = REPLAY_CREDENTIAL
        replay = new ReplayLlmUpstream(recording, options.mode.refresh === undefined ? 'strict' : 'refresh')
        upstream = replay
      }
      reportLlm ??= llm
      const collector = options.mode.kind === 'live' && options.mode.record
        ? new RecordingCollector({ caseId: evalCase.id, run, engine: engine.descriptor, protocol: llm.protocol })
        : null
      let fingerprint: string | null = null
      const network = new EvalNetwork({
        llmBaseUrl: llm.baseUrl,
        imageBaseUrl: EVAL_MOCK_IMAGE_BASE_URL,
        upstream,
        onLlmExchange: (exchange) => {
          fingerprint ??= promptFingerprint(llmRequestShape(exchange.endpoint, exchange.method, exchange.requestBodyText))
          collector?.add(exchange)
        }
      })
      const workDirectory = await mkdtemp(join(tmpdir(), 'agent-eval-'))
      const restore = network.install()
      let observation: EvalObservation | null = null
      let runError: string | null = null
      try {
        observation = await engine.runCase({
          evalCase,
          run,
          scenes: options.scenes,
          llm,
          apiKey,
          network,
          workDirectory,
          turnTimeoutMs: options.turnTimeoutMs ?? 6 * 60_000
        })
      } catch (error) {
        runError = error instanceof Error ? error.message : 'The engine failed to run the case.'
      } finally {
        restore()
        await network.settle()
        await rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
      }
      const problems = replayProblems(replay)
      let recordingPath: string | null = null
      if (collector !== null && options.outputDirectory !== null) {
        const path = join(options.outputDirectory, 'recordings', engine.descriptor.id, evalCase.id, `run-${run}.json`)
        await writeRecording(path, collector.build())
        recordingPath = relative(options.outputDirectory, path)
      }
      if (replay !== null && options.mode.kind === 'replay' && options.mode.refresh !== undefined && observation !== null) {
        await options.mode.refresh({ ...replay.refreshed(), engine: { id: engine.descriptor.id, version: engine.descriptor.version } })
      }
      const result = observation === null
        ? failedRun(run, { code: 'RUN_ERROR', message: runError ?? 'No observation.' }, Date.now() - startedAt)
        : evaluateRun(evalCase, observation, { pricing, problems, recording: recordingPath, promptFingerprint: fingerprint })
      runs.push(result)
      if (observation !== null) {
        observations.push(observation)
        if (options.outputDirectory !== null) {
          await writeJson(join(options.outputDirectory, 'runs', evalCase.id, `run-${run}.json`), { result, observation })
        }
      }
      options.onProgress?.(`${evalCase.id} #${run}: ${result.passed ? 'PASS' : `FAIL ${result.failureCodes.join(',')}`}`)
    }
    results.push({ evalCase, runs })
  }

  const llm = reportLlm ?? replayLlmProviderConfig('openai-responses', 'buffered')
  const report = buildModelEvalReport({
    profile: options.mode.kind === 'live' ? 'agent-real-model' : 'agent-replay',
    engine: engine.descriptor,
    llm: {
      protocol: llm.protocol,
      model: llm.defaultModel,
      endpointHost: new URL(llm.baseUrl).host,
      transport: llm.transport.mode,
      reasoningEffort: llm.reasoningEffort
    },
    runsPerCase: options.runs,
    caseFilter: options.caseFilter ?? [],
    pricing,
    cases: results
  })
  let files: AgentEvalRunOutput['files'] = null
  if (options.outputDirectory !== null) {
    files = { json: join(options.outputDirectory, 'report.json'), markdown: join(options.outputDirectory, 'report.md') }
    await writeJson(files.json, report)
    await writeFile(files.markdown, renderModelEvalMarkdown(report), 'utf8')
  }
  return { report, observations, files }
}
