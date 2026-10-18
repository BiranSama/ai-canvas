import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Scene, SceneCommand, SceneElement } from '../../../domain'
import type { AgentRequest, ConversationMessage } from '../../../shared/agent'
import { isTerminalAgentTurnStatus, type AgentDecisionProposal, type AgentHarnessSnapshot, type TaskRelation } from '../../../shared/agent-harness'
import { generationRequestSchema, isTerminalGenerationJobStatus } from '../../../shared/generation'
import { GenerationRuntime, type GenerationRuntimeOptions } from '../../generation/generation-runtime'
import { ProviderUsageLedger } from '../../security/provider-usage-ledger'
import type { AgentEvalCase, AgentEvalTurn } from './case-schema'
import { EVAL_MOCK_IMAGE_SECRET, evalMockImageProviderConfig } from './config'
import type {
  EvalCaseContext,
  EvalDecisionObservation,
  EvalEngineDescriptor,
  EvalJobObservation,
  EvalObservation,
  EvalSceneFixture,
  EvalTurnObservation
} from './engine'
import { InMemorySecretVault } from './in-memory-secret-vault'
import { matchesSelector, sameSceneContent, summarizeScene } from './scene-facts'

/**
 * Drives one case run through the production Main composition: the persistent
 * agent loop, the tool executor, the Scene authority and the transport
 * security layer. Only the vault and the network differ from the app.
 */

const POLL_MS = 40
const MAX_DECISIONS_PER_TURN = 6
const MAX_UNDO_STEPS = 40

export interface RuntimeCaseOptions {
  readonly runtimeOptions?: Omit<GenerationRuntimeOptions, 'secretVault'>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Mirrors the Renderer composer: selected elements, plus pixel references for selected images. */
function buildRequest(scene: Scene, turn: AgentEvalTurn): AgentRequest {
  const selected: SceneElement[] = []
  for (const selector of turn.select) {
    for (const element of scene.elements) {
      if (matchesSelector(element, selector) && !selected.includes(element)) selected.push(element)
    }
  }
  return {
    text: turn.text,
    projectId: scene.projectId,
    sceneSummary: summarizeScene(scene),
    selectedIds: selected.map((element) => element.id),
    selectedElements: selected,
    attachments: selected.flatMap((element) => element.type === 'image'
      ? [{ kind: 'selection' as const, id: element.id, name: element.name }, { kind: 'asset' as const, id: element.assetId, name: `${element.name} · 图片参考` }]
      : [{ kind: 'selection' as const, id: element.id, name: element.name }]).slice(0, 20),
    ephemeralAnnotation: null,
    autoGenerate: turn.autoGenerate,
    activeGenerationJobId: null
  }
}

const APPROVE_PATTERN = /generate|apply|continue|开始|确认|执行|生成/i
const DECLINE_PATTERN = /keep|stop|cancel|decline|保留|先不|停|取消|不生成/i

function isGenerationQuestion(proposal: AgentDecisionProposal): boolean {
  return proposal.kind === 'generation_confirmation'
    || /生成|生图|出图|图片任务/.test(`${proposal.title}${proposal.consequence}`)
}

/** The simulated user's answer: generation follows the case policy, everything else takes the default. */
export function chooseDecisionOption(proposal: AgentDecisionProposal, generation: 'approve' | 'decline'): { readonly optionId: string; readonly approvesGeneration: boolean } {
  if (!isGenerationQuestion(proposal)) return { optionId: proposal.defaultOptionId, approvesGeneration: false }
  const fits = (value: string): boolean => generation === 'approve'
    ? APPROVE_PATTERN.test(value) && !DECLINE_PATTERN.test(value)
    : DECLINE_PATTERN.test(value)
  const option = proposal.options.find((candidate) => fits(candidate.id))
    ?? proposal.options.find((candidate) => fits(candidate.label))
  if (option !== undefined) return { optionId: option.id, approvesGeneration: generation === 'approve' }
  return generation === 'approve'
    ? { optionId: proposal.defaultOptionId, approvesGeneration: true }
    : { optionId: proposal.options.find((candidate) => candidate.id !== proposal.defaultOptionId)?.id ?? proposal.defaultOptionId, approvesGeneration: false }
}

function messageText(message: ConversationMessage): string {
  const receipt = message.receipt
  return [
    message.content,
    receipt?.summary,
    receipt?.nextAction,
    ...(receipt?.items ?? []).flatMap((item) => [item.object, item.action, item.impact])
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n')
}

function decisionText(proposal: AgentDecisionProposal): string {
  return [proposal.title, proposal.consequence, ...proposal.options.flatMap((option) => [option.label, option.consequence])].join('\n')
}

function decisionProposal(snapshot: AgentHarnessSnapshot, itemId: string): AgentDecisionProposal | null {
  const item = snapshot.items.find((candidate) => candidate.id === itemId)
  const proposal = (item?.payload as { readonly proposal?: AgentDecisionProposal } | undefined)?.proposal
  return proposal ?? null
}

async function commitFixture(runtime: GenerationRuntime, fixture: EvalSceneFixture): Promise<void> {
  const current = runtime.getWorkspaceBootstrap().scene
  const commands: SceneCommand[] = [
    ...(fixture.canvas === undefined ? [] : [{ kind: 'scene.set-canvas' as const, canvas: fixture.canvas }]),
    ...(fixture.creativeContext === undefined ? [] : [{ kind: 'scene.set-creative-context' as const, creativeContext: fixture.creativeContext }]),
    ...fixture.elements.map((element) => ({ kind: 'element.add' as const, element })),
    ...(fixture.relations ?? []).map((relation) => ({ kind: 'relation.add' as const, relation }))
  ]
  if (commands.length === 0) return
  const result = await runtime.executeSceneCommands({
    projectId: current.projectId,
    expectedSceneRevision: current.revision,
    batch: { id: randomUUID(), origin: 'user', summary: '载入评测场景', commands }
  })
  if (!result.ok) throw new Error(`The eval scene could not be committed: ${result.error.message}`)
}

async function waitForJobs(runtime: GenerationRuntime, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const jobs = await runtime.listJobs()
    if (jobs.every((job) => isTerminalGenerationJobStatus(job.status))) return
    await sleep(POLL_MS)
  }
}

async function createSetupResults(runtime: GenerationRuntime, evalCase: AgentEvalCase, deadline: number): Promise<Set<string>> {
  const ids = new Set<string>()
  const scene = runtime.getWorkspaceBootstrap().scene
  for (const result of evalCase.setup.generationResults) {
    const job = await runtime.enqueue(generationRequestSchema.parse({
      prompt: result.prompt,
      providerId: 'mock',
      model: 'mock-balanced',
      aspectWidth: scene.canvas.aspectWidth,
      aspectHeight: scene.canvas.aspectHeight,
      outputWidth: 512,
      outputHeight: Math.max(64, Math.round(512 * scene.canvas.aspectHeight / scene.canvas.aspectWidth)),
      count: 1
    }))
    ids.add(job.id)
  }
  await waitForJobs(runtime, deadline)
  for (const job of await runtime.listJobs()) {
    if (ids.has(job.id) && job.status !== 'completed') throw new Error(`The setup mock result did not complete (${job.status}).`)
  }
  return ids
}

async function runTurn(
  runtime: GenerationRuntime,
  context: EvalCaseContext,
  turn: AgentEvalTurn,
  index: number,
  role: EvalTurnObservation['role']
): Promise<EvalTurnObservation> {
  const network = context.network
  const startedAt = Date.now()
  const startedSeq = network.seq
  const deadline = startedAt + context.turnTimeoutMs
  const harness = await runtime.getAgentHarnessSnapshot()
  // The Renderer starts a new task until one exists, then continues it.
  const relation: TaskRelation = turn.taskRelation ?? (harness.turns.some((candidate) => candidate.taskId !== null) ? 'continue_current' : 'new_task')
  const run = await runtime.startAgentRun(buildRequest(runtime.getWorkspaceBootstrap().scene, turn), 'collaboration', relation)
  const decisions: EvalDecisionObservation[] = []
  const decisionCopy: string[] = []
  const answered = new Set<string>()
  let status = 'timeout'
  let turnId: string | null = null
  let errorCode: string | null = null
  let errorMessage: string | null = null
  while (Date.now() < deadline) {
    const snapshot = await runtime.getAgentHarnessSnapshot()
    const agentTurn = snapshot.turns.find((candidate) => candidate.inputMessageId === run.id)
    if (agentTurn !== undefined) {
      turnId = agentTurn.id
      if (isTerminalAgentTurnStatus(agentTurn.status)) {
        status = agentTurn.status
        errorCode = agentTurn.errorCode
        errorMessage = agentTurn.errorMessage
        break
      }
      const waiting = agentTurn.status === 'waiting_decision'
        ? snapshot.items.find((item) => item.turnId === agentTurn.id && item.type === 'decision' && item.status === 'waiting' && !answered.has(item.id))
        : undefined
      const proposal = waiting === undefined ? null : decisionProposal(snapshot, waiting.id)
      if (waiting !== undefined && proposal !== null) {
        if (decisions.length >= MAX_DECISIONS_PER_TURN) {
          status = 'decision_loop'
          await runtime.cancelAgentRun(run.id).catch(() => undefined)
          break
        }
        const choice = chooseDecisionOption(proposal, context.evalCase.decisions.generation)
        try {
          await runtime.confirmAgentRun(run.id, choice.optionId)
          answered.add(waiting.id)
          decisionCopy.push(decisionText(proposal))
          decisions.push({ kind: proposal.kind, title: proposal.title, optionId: choice.optionId, approvesGeneration: choice.approvesGeneration, seq: network.nextSeq() })
        } catch {
          // The legacy run projection can trail the persisted decision by a moment.
          await sleep(POLL_MS)
        }
        continue
      }
    }
    await sleep(POLL_MS)
  }
  if (status === 'timeout') await runtime.cancelAgentRun(run.id).catch(() => undefined)
  await waitForJobs(runtime, deadline)
  await network.settle()
  const [conversation, finalHarness] = await Promise.all([runtime.getConversation(), runtime.getAgentHarnessSnapshot()])
  const assistantMessages = conversation.messages.filter((message) => message.runId === run.id && message.role === 'assistant')
  const replies = assistantMessages.map(messageText)
  const endedSeq = network.seq
  return {
    index,
    role,
    text: turn.text,
    status,
    errorCode,
    errorMessage,
    toolSteps: turnId === null ? 0 : finalHarness.items.filter((item) => item.turnId === turnId && item.type === 'tool_call').length,
    modelCalls: network.entries().filter((entry) => entry.route === 'llm' && entry.seq > startedSeq && entry.seq <= endedSeq).length,
    decisions,
    replyText: replies.join('\n'),
    modelUsage: [...assistantMessages].reverse().find((message) => message.receipt?.modelUsage !== undefined)?.receipt?.modelUsage ?? null,
    decisionText: decisionCopy.join('\n'),
    startedSeq,
    endedSeq,
    durationMs: Date.now() - startedAt
  }
}

async function probeUndo(runtime: GenerationRuntime, target: Scene): Promise<EvalObservation['undo']> {
  let steps = 0
  while (steps <= MAX_UNDO_STEPS) {
    const state = runtime.getSceneAuthorityState()
    if (sameSceneContent(state.scene, target)) return { restored: true, steps, detail: null }
    if (!state.canUndo) return { restored: false, steps, detail: '撤销历史已用尽，仍未回到用例开始时的画布。' }
    const result = await runtime.undoScene({ projectId: state.scene.projectId, expectedSceneRevision: state.scene.revision, batchId: null })
    if (!result.ok) return { restored: false, steps, detail: `撤销失败：${result.error.message}` }
    steps += 1
  }
  return { restored: false, steps, detail: `超过 ${MAX_UNDO_STEPS} 次撤销仍未回到用例开始时的画布。` }
}

async function reservedLlmCost(userDataDirectory: string): Promise<number> {
  const ledger = new ProviderUsageLedger(join(userDataDirectory, 'security', 'provider-usage.json'), {
    read: async () => { throw new Error('The eval only reads the usage ledger.') }
  })
  const snapshots = await ledger.listSnapshots(500)
  return Number(snapshots.filter((entry) => entry.providerId === 'openai-compatible-llm')
    .reduce((sum, entry) => sum + entry.reservedCostCny, 0).toFixed(4))
}

export async function runRuntimeCase(
  context: EvalCaseContext,
  engine: EvalEngineDescriptor,
  options: RuntimeCaseOptions = {}
): Promise<EvalObservation> {
  const startedAt = Date.now()
  const userData = join(context.workDirectory, 'user-data')
  const vault = new InMemorySecretVault({
    'openai-compatible-llm': context.apiKey,
    'image-provider': EVAL_MOCK_IMAGE_SECRET
  })
  const runtime = await GenerationRuntime.create(userData, {
    projectLibraryDirectory: join(userData, 'library'),
    ...options.runtimeOptions,
    secretVault: vault
  })
  try {
    await runtime.setProviderConfig(context.llm)
    await runtime.setProviderConfig(evalMockImageProviderConfig)
    let setupError: string | null = null
    let setupJobs = new Set<string>()
    try {
      const builder = context.scenes[context.evalCase.scene]
      if (builder === undefined) throw new Error(`Unknown eval scene "${context.evalCase.scene}".`)
      const fixture = await builder({
        importImage: async ({ name, bytes }) => {
          const asset = await runtime.importAsset({ name, mimeType: 'image/png', bytes: new Uint8Array(bytes) })
          return { id: asset.id, width: asset.width, height: asset.height }
        }
      })
      if (fixture !== null) await commitFixture(runtime, fixture)
      setupJobs = await createSetupResults(runtime, context.evalCase, Date.now() + context.turnTimeoutMs)
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'The eval setup failed.'
    }
    const caseStart = runtime.getWorkspaceBootstrap().scene
    const afterSetupTurns: Scene[] = []
    const turns: EvalTurnObservation[] = []
    if (setupError === null) {
      for (const [index, turn] of context.evalCase.setup.turns.entries()) {
        turns.push(await runTurn(runtime, context, turn, index, 'setup'))
        afterSetupTurns.push(runtime.getWorkspaceBootstrap().scene)
      }
    }
    const beforeTurn = runtime.getWorkspaceBootstrap().scene
    if (setupError === null) {
      turns.push(await runTurn(runtime, context, context.evalCase.request, turns.length, 'evaluated'))
    }
    await context.network.settle()
    const final = runtime.getWorkspaceBootstrap().scene
    const [jobs, knowledge] = await Promise.all([runtime.listJobs(), runtime.getProjectKnowledge()])
    const jobObservations: EvalJobObservation[] = jobs.map((job) => ({
      id: job.id,
      providerId: job.providerId,
      status: job.status,
      imageCount: job.request.count,
      resultCount: job.results.length,
      setup: setupJobs.has(job.id)
    }))
    const undo = await probeUndo(runtime, caseStart)
    return {
      caseId: context.evalCase.id,
      run: context.run,
      engine,
      setupError,
      scenes: { caseStart, afterSetupTurns, beforeTurn, final },
      turns,
      network: context.network.entries(),
      jobs: jobObservations,
      directives: knowledge.directives.map((directive) => ({ text: directive.text, enabled: directive.enabled })),
      reservedLlmCostCny: await reservedLlmCost(userData),
      undo,
      durationMs: Date.now() - startedAt
    }
  } finally {
    await runtime.close()
  }
}
