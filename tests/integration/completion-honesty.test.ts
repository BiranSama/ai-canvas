import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { DeterministicMockPlanner } from '../../src/main/agent'
import { ConfiguredAgentPlanner } from '../../src/main/agent/ark-agent-planner'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { isTerminalAgentTurnStatus } from '../../src/shared/agent-harness'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'
import type { AgentPlan, AgentRequest } from '../../src/shared/agent'
import { projectAgentExecutionFlow } from '../../src/renderer/src/agent/agent-execution-flow'
import { MockImageProvider } from '../../src/main/generation/mock-image-provider'
import { makeText } from '../fixtures/scene-fixtures'

const runtimes: GenerationRuntime[] = []
const roots: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const root of roots.splice(0)) await writeFile(join(root, 'fixture-evidence.json'), JSON.stringify({ scope: 'C08 synthetic project and Fake planner', realProviderRequests: 0 }))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'honest-')); roots.push(root)
  const network = vi.fn(() => { throw new Error('OFFLINE_COMPLETION_BOUNDARY') }); vi.stubGlobal('fetch', network)
  const userData = join(root, 'userData')
  const runtime = await GenerationRuntime.create(userData); runtimes.push(runtime)
  const path = join(root, 'work.aicanvas')
  await runtime.createProject(path, 'Completion fixture')
  return { root, path, runtime, userData, network }
}
function request(runtime: GenerationRuntime, text = '创建一张 4:5 人物海报，主体是侧身人物，不生成图片。'): AgentRequest {
  return { ...fixtureAgentRequest(runtime.getWorkspaceBootstrap().scene, text), projectId: runtime.getWorkspaceBootstrap().projectId }
}
function withCriterion(plan: AgentPlan, criterion: string | readonly string[]): AgentPlan {
  if (plan.designContract?.version !== 2 || plan.designContract.brief.version !== 3) throw new Error('Expected the current Creative Brief')
  const brief = { ...plan.designContract.brief, acceptanceCriteria: (typeof criterion === 'string' ? [criterion] : criterion).map(value => ({ id: randomUUID(), priority: 'must' as const, criterion: value })) }
  return { ...plan, designContract: { ...plan.designContract, brief }, tools: plan.tools.map((tool) => tool.kind !== 'scene_batch' ? tool : {
    ...tool, commands: tool.commands.map((command) => command.kind !== 'scene.set-creative-context' || command.creativeContext === null
      ? command : { ...command, creativeContext: { ...command.creativeContext, brief } })
  }) }
}
async function wait(runtime: GenerationRuntime) {
  await expect.poll(async () => {
    const state = await runtime.getAgentHarnessSnapshot()
    const latest = state.turns[0]
    if (latest === undefined || !isTerminalAgentTurnStatus(latest.status)) return false
    return (await runtime.getConversation()).runs.find((run) => run.id === latest.inputMessageId)?.status === 'completed'
  }, { timeout: 8000 }).toBe(true)
  return runtime.getAgentHarnessSnapshot()
}
async function createReviewed(h: Awaited<ReturnType<typeof fixture>>, criterion: string, text?: string) {
  const input = request(h.runtime, text)
  const plan = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), criterion)
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(plan)
  await h.runtime.startAgentRun(input, 'auto')
  const harness = await wait(h.runtime)
  const message = (await h.runtime.getConversation()).messages.findLast((entry) => entry.kind === 'receipt')!
  expect(message).toBeDefined()
  return { harness, message }
}

it.each([false, true, 'overflow'] as const)('retains every result and unknown must when recovery replans remaining work (new contract: %s)', async (newContract) => {
  const h = await fixture()
  const input = request(h.runtime, '创建一张 4:5 人物海报并生成两张本地候选，保留品牌调性。')
  const original = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), newContract === 'overflow'
    ? ['人物面部自然且符合品牌调性', ...Array.from({ length: 59 }, (_, index) => `原视觉标准${index}`)] : '人物面部自然且符合品牌调性')
  const scene = h.runtime.getWorkspaceBootstrap().scene
  const generate = (prompt: string): AgentPlan['tools'][number] => ({ kind: 'generation', request: {
    prompt, negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 128, outputHeight: 128, count: 1,
    providerId: 'mock', model: 'mock-balanced', references: [], parameters: { mockSubmitDelayMs: 1, mockGenerationDelayMs: 1 },
    sourceMessageId: null, parentResultId: null, referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
  } })
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValueOnce({ ...original, tools: [generate('G1'), {
    kind: 'scene_batch', summary: '旧版本调整', commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: 'stale' } }]
  }] }).mockResolvedValue({ ...(newContract ? withCriterion(original, newContract === 'overflow' ? Array.from({ length: 60 }, (_, index) => `新增视觉标准${index}`) : '画布比例保持4:5') : {}), summary: '恢复剩余生成', response: '保留已完成结果，继续第二张', nextAction: null, tools: [generate('G2')] })
  const actualGenerate = MockImageProvider.prototype.generate
  vi.spyOn(MockImageProvider.prototype, 'generate').mockImplementation(async function (this: MockImageProvider, job, context) {
    if (job.prompt === 'G1') {
      const edited = await h.runtime.executeSceneCommands({ projectId: scene.projectId, expectedSceneRevision: scene.revision,
        batch: { id: randomUUID(), origin: 'user', summary: '生成期间人工修改', commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: 'human-kept' } }] } })
      expect(edited.ok).toBe(true)
    }
    return actualGenerate.call(this, job, context)
  })
  await h.runtime.startAgentRun(input, 'auto')
  await wait(h.runtime)
  expect(planner).toHaveBeenCalledTimes(2)
  const jobs = await h.runtime.listJobs()
  expect(jobs.map(job => job.request.prompt).sort()).toEqual(['G1', 'G2'])
  expect(jobs.every(job => job.status === 'completed')).toBe(true)
  const message = (await h.runtime.getConversation()).messages.findLast(entry => entry.kind === 'receipt')!
  expect.soft(message.receipt?.completion?.scope?.resultIds.slice().sort()).toEqual(jobs.flatMap(job => job.results.map(result => result.id)).sort())
  expect.soft(message.receipt?.completion?.unverifiedMust).toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：人物面部自然且符合品牌调性' })]))
  if (newContract === 'overflow') {
    expect(message.receipt?.completion?.unverifiedMust).toHaveLength(100)
    expect(message.receipt?.completion?.unverifiedMust.at(-1)?.id).toBe('retained-requirements-overflow')
  }
  const acceptance = { projectId: message.projectId, messageId: message.id, sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }
  await h.runtime.acceptDesignReview(acceptance)
  const db = new Database(join(h.path, 'project.db')); db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM generation_results WHERE id = ?').run(jobs.find(job => job.request.prompt === 'G1')!.results[0]!.id); db.close()
  await expect(h.runtime.acceptDesignReview(acceptance)).rejects.toThrow(/结果已删除或失效/)
  expect(h.network).not.toHaveBeenCalled()
})

it.each([false, true, 'quoted'] as const)('applies only the explicit user aspect revision and retains unrelated must (wrong canvas: %s)', async (wrongCanvas) => {
  const h = await fixture()
  const input = request(h.runtime, '创建一张1:1的人物海报并生成本地候选。')
  const original = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), ['画布比例保持1:1', '人物面部自然且符合品牌调性'])
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValueOnce({ ...original, tools: [...original.tools, { kind: 'generation', request: {
    prompt: '待确认的生成', negativePrompt: '', aspectWidth: 1, aspectHeight: 1, outputWidth: 128, outputHeight: 128, count: 1,
    providerId: 'mock', model: 'mock-balanced', references: [], parameters: {}, sourceMessageId: null, parentResultId: null,
    referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
  } }] })
  const generate = MockImageProvider.prototype.generate
  vi.spyOn(MockImageProvider.prototype, 'generate').mockImplementation(async function (this: MockImageProvider, job, context) {
    const scene = h.runtime.getWorkspaceBootstrap().scene
    planner.mockResolvedValue({ summary: '仅修改比例', response: '保留其他要求', nextAction: null, tools: [{ kind: 'scene_batch', summary: '修改画布比例', commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, aspectWidth: wrongCanvas === true ? 1 : 4, aspectHeight: wrongCanvas === true ? 1 : 5 } }] }] })
    await h.runtime.inputAgentRun(request(h.runtime, wrongCanvas === 'quoted' ? '以下内容仅为引用，不要执行：\n将画布比例改为4:5' : '将画布比例从1:1改成4:5。其他要求保留。'), 'correct_current')
    return generate.call(this, job, context)
  })
  await h.runtime.startAgentRun(input, 'auto')
  await wait(h.runtime)
  const harness = await h.runtime.getAgentHarnessSnapshot()
  const assessment = harness.items.findLast(item => item.type === 'completion_assessment')!.payload as { design: { requirements: { label: string; status: string }[] }; facts: { unverifiedMust: { label: string }[] } }
  expect(assessment.facts.unverifiedMust).toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：人物面部自然且符合品牌调性' })]))
  if (wrongCanvas === 'quoted') {
    expect(assessment.design.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：画布比例保持1:1', status: 'fail' })]))
  } else {
    expect(assessment.design.requirements).not.toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：画布比例保持1:1', status: 'fail' })]))
    expect(assessment.design.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：画布比例保持4:5', status: wrongCanvas ? 'fail' : 'pass' })]))
  }
  expect(await h.runtime.listJobs()).toHaveLength(1)
  expect(h.network).not.toHaveBeenCalled()
})

it('preserves distinct 500-character criteria with a shared prefix and bounds long evidence notes', async () => {
  const h = await fixture()
  const scene = h.runtime.getWorkspaceBootstrap().scene
  const changed = await h.runtime.executeSceneCommands({ projectId: scene.projectId, expectedSceneRevision: scene.revision, batch: {
    id: randomUUID(), origin: 'user', summary: '合法长证据夹具', commands: Array.from({ length: 25 }, (_, index) => ({ kind: 'element.add' as const,
      element: { ...makeText(index), id: randomUUID(), semanticRole: 'subject', name: `${index}`.padEnd(120, '长') } }))
  } })
  expect(changed.ok).toBe(true)
  const input = request(h.runtime)
  const criteria = ['甲', '乙'].map(tail => '必须保留的视觉要求'.padEnd(499, '长') + tail)
  const original = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), criteria)
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ ...original, tools: [{ kind: 'scene_batch', summary: '更新风格', commands: [{ kind: 'scene.set-canvas', canvas: { ...scene.canvas, globalStyle: '长要求验证' } }] }] })
  await h.runtime.startAgentRun(input, 'auto')
  await expect.poll(async () => isTerminalAgentTurnStatus((await h.runtime.getAgentHarnessSnapshot()).turns[0]!.status)).toBe(true)
  const harness = await h.runtime.getAgentHarnessSnapshot()
  expect(harness.turns[0], harness.turns[0]?.errorMessage ?? '').toMatchObject({ status: 'needs_user_review', errorCode: null })
  await wait(h.runtime)
  const assessment = harness.items.findLast(item => item.type === 'completion_assessment')!.payload as { notes: string[]; facts: { unverifiedMust: { label: string; reason: string }[] } }
  expect(assessment.facts.unverifiedMust).toHaveLength(2)
  for (const criterion of criteria) expect(assessment.facts.unverifiedMust.some(item => item.reason.includes(criterion))).toBe(true)
  expect(assessment.facts.unverifiedMust.every(item => item.label.length <= 240)).toBe(true)
  expect(assessment.notes.every(note => note.length <= 1000)).toBe(true)
  expect(h.network).not.toHaveBeenCalled()
})

it('finishes a legal contract with 100 must criteria without losing any unknown requirement', async () => {
  const h = await fixture()
  const input = request(h.runtime)
  const plan = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), Array.from({ length: 100 }, (_, index) => `视觉标准${index + 1}符合要求`))
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue(plan)
  await h.runtime.startAgentRun(input, 'auto')
  await expect.poll(async () => isTerminalAgentTurnStatus((await h.runtime.getAgentHarnessSnapshot()).turns[0]!.status)).toBe(true)
  const harness = await h.runtime.getAgentHarnessSnapshot()
  expect(harness.turns[0], harness.turns[0]?.errorMessage ?? '').toMatchObject({ status: 'needs_user_review', errorCode: null })
  await wait(h.runtime)
  const message = (await h.runtime.getConversation()).messages.findLast(entry => entry.kind === 'receipt')!
  expect(message.receipt?.completion?.unverifiedMust).toHaveLength(100)
  expect(message.receipt?.completion?.unverifiedMust.at(-1)?.label).toBe('必须：视觉标准100符合要求')
  expect(h.network).not.toHaveBeenCalled()
})

it('retains visual must criteria when the user keeps the canvas instead of generating', async () => {
  const h = await fixture()
  const input = request(h.runtime)
  const original = withCriterion(await new DeterministicMockPlanner({ delayMs: 0 }).plan(input, new AbortController().signal), '人物面部自然且符合品牌调性')
  vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ ...original, tools: [...original.tools, { kind: 'generation', request: {
    prompt: '受控候选', negativePrompt: '', aspectWidth: 4, aspectHeight: 5, outputWidth: 128, outputHeight: 160, count: 1,
    providerId: 'mock', model: 'mock-balanced', references: [], parameters: {}, sourceMessageId: null, parentResultId: null,
    referenceMode: 'hybrid', variationInstruction: '', preserveConstraints: ''
  } }] })
  const run = await h.runtime.startAgentRun(input, 'collaboration')
  await expect.poll(async () => (await h.runtime.getConversation()).runs.find(candidate => candidate.id === run.id)?.status).toBe('awaiting_confirmation')
  await h.runtime.confirmAgentRun(run.id, 'keep_canvas')
  await wait(h.runtime)
  const message = (await h.runtime.getConversation()).messages.findLast(entry => entry.kind === 'receipt')!
  expect(message.receipt?.completion?.unverifiedMust).toEqual(expect.arrayContaining([expect.objectContaining({ label: '必须：人物面部自然且符合品牌调性' })]))
  expect(await h.runtime.listJobs()).toHaveLength(0)
  expect(h.network).not.toHaveBeenCalled()
})

it.each(['人物面部自然且符合品牌调性', '主体面部自然且符合品牌调性', '面部自然且比例 4:5'])('keeps the complete must criterion "%s" unverified through real Main and persistence', async (criterion) => {
  const h = await fixture()
  const { harness, message } = await createReviewed(h, criterion)
  expect(h.runtime.getWorkspaceBootstrap().scene.elements.length).toBeGreaterThan(0)
  expect(harness.turns[0]?.status).toBe('needs_user_review')
  const assessment = harness.items.find((item) => item.type === 'completion_assessment')
  expect(assessment?.payload).toMatchObject({ status: 'needs_user_review', facts: { operationStatus: 'completed', structureStatus: 'passed', visualStatus: 'needs_user_review', userAcceptance: null } })
  expect(message.content).toContain(criterion)
  expect(message.receipt?.completion?.unverifiedMust).toEqual([expect.objectContaining({ label: `必须：${criterion}` })])
  expect(message.receipt?.designReview?.recommendation).toBe('needs_user_review')
  expect(await h.runtime.listJobs()).toHaveLength(0)
  expect(projectAgentExecutionFlow(harness, harness.turns[0]!.id)?.statusLabel).toBe('待检查')
  await h.runtime.close()
  const reopened = await GenerationRuntime.create(h.userData); runtimes.push(reopened)
  expect((await reopened.getConversation()).messages.find((entry) => entry.id === message.id)?.receipt?.completion).toEqual(message.receipt?.completion)
  expect(h.network).not.toHaveBeenCalled()
})

it('records explicit acceptance once for the exact Scene, keeps unknown evidence, and invalidates its current scope after edits', async () => {
  const h = await fixture()
  const { message } = await createReviewed(h, '人物面部自然且符合品牌调性')
  const before = h.runtime.getWorkspaceBootstrap()
  const input = { projectId: before.projectId, messageId: message.id, sceneRevision: before.scene.revision }
  const accepted = await h.runtime.acceptDesignReview(input)
  const facts = accepted.messages.find((entry) => entry.id === message.id)?.receipt?.completion
  expect(facts?.userAcceptance).toMatchObject({ sceneRevision: before.scene.revision, resultIds: [] })
  expect(facts?.unverifiedMust).toEqual(message.receipt?.completion?.unverifiedMust)
  expect((await h.runtime.acceptDesignReview(input)).messages.find((entry) => entry.id === message.id)?.receipt?.completion).toEqual(facts)
  expect(h.runtime.getWorkspaceBootstrap().scene).toEqual(before.scene)
  await h.runtime.close()
  const reopened = await GenerationRuntime.create(h.userData); runtimes.push(reopened)
  expect((await reopened.getConversation()).messages.find((entry) => entry.id === message.id)?.receipt?.completion).toEqual(facts)
  await reopened.executeSceneCommands({ projectId: before.projectId, expectedSceneRevision: before.scene.revision,
    batch: { id: randomUUID(), origin: 'user', summary: '接受后修改', commands: [{ kind: 'scene.set-canvas', canvas: { ...before.scene.canvas, globalStyle: 'new revision' } }] } })
  const current = reopened.getWorkspaceBootstrap().scene
  await expect(reopened.acceptDesignReview(input)).rejects.toThrow(/作品已修改/)
  await expect(reopened.acceptDesignReview({ ...input, sceneRevision: current.revision })).rejects.toThrow(/重新检查/)
  expect((await reopened.getConversation()).messages.find((entry) => entry.id === message.id)?.receipt?.completion?.userAcceptance?.sceneRevision).toBe(before.scene.revision)
  await reopened.createProject(join(h.root, 'B.aicanvas'), 'B')
  await expect(reopened.acceptDesignReview(input)).rejects.toThrow(/PROJECT_CHANGED/)
  expect(() => reopened.startAgentRun({ ...fixtureAgentRequest(before.scene, '解释比例'), projectId: before.projectId })).toThrow(/PROJECT_CHANGED/)
  expect(h.network).not.toHaveBeenCalled()
})

it('requires actual execution evidence for an edit/generation claim while ordinary explanation completes as text', async () => {
  const h = await fixture()
  const planner = vi.spyOn(ConfiguredAgentPlanner.prototype, 'plan').mockResolvedValue({ summary: '解释比例', response: '4:5 表示画布宽与高的比例。', tools: [], nextAction: null })
  const before = h.runtime.getWorkspaceBootstrap().scene
  await h.runtime.startAgentRun(request(h.runtime, '解释一下 4:5 表示什么'), 'collaboration')
  const explained = await wait(h.runtime)
  expect(explained.turns[0]?.status).toBe('completed')
  expect((await h.runtime.getConversation()).messages.at(-1)).toMatchObject({ kind: 'text', receipt: null, content: '4:5 表示画布宽与高的比例。' })
  expect((await h.runtime.getConversation()).activities.filter((activity) => activity.kind === 'receipt')).toHaveLength(0)
  expect(projectAgentExecutionFlow(explained, explained.turns[0]!.id)).toBeNull()
  planner.mockResolvedValue({ summary: '没有工具的生成声明', response: '已为你生成图片并修改画布。', tools: [], nextAction: null })
  const run = await h.runtime.startAgentRun(request(h.runtime, '请生成一张 4:5 图片'), 'auto', 'new_task')
  await expect(h.runtime.completeAgentRun({ runId: run.id, outcomes: [] })).rejects.toThrow(/主进程管理/)
  const missing = await wait(h.runtime)
  expect(missing.turns[0]?.status).toBe('needs_user_review')
  expect((await h.runtime.getConversation()).messages.at(-1)).toMatchObject({ kind: 'receipt', receipt: { completion: { operationStatus: 'missing', userAcceptance: null } } })
  expect((await h.runtime.getConversation()).messages.at(-1)?.content).toContain('请求尚未执行')
  expect(h.runtime.getWorkspaceBootstrap().scene).toEqual(before)
  expect(await h.runtime.listJobs()).toHaveLength(0); expect(h.network).not.toHaveBeenCalled()
})

it('pins the exact generated result in acceptance and marks the scope unavailable after that result is deleted', async () => {
  const h = await fixture()
  const { message } = await createReviewed(h, '人物面部自然且符合品牌调性', '创建一张 4:5 人物海报，主体是侧身人物，并生成一张本地图片。')
  const results = (await h.runtime.listJobs()).flatMap((job) => job.results)
  expect(results).toHaveLength(1)
  expect(message.receipt?.completion?.scope?.resultIds).toEqual(results.map((result) => result.id))
  const input = { projectId: message.projectId, messageId: message.id, sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision }
  await h.runtime.acceptDesignReview(input)
  const db = new Database(join(h.path, 'project.db')); db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM generation_results WHERE id = ?').run(results[0]!.id); db.close()
  const updated = (await h.runtime.getConversation()).messages.find((entry) => entry.id === message.id)!
  expect(updated.receipt?.completion?.userAcceptance?.resultIds).toEqual(results.map((result) => result.id))
  expect(updated.receipt?.completion?.scopeUnavailableReason).toContain('原接受范围不再完整')
  await expect(h.runtime.acceptDesignReview(input)).rejects.toThrow(/结果已删除或失效/)
  expect(h.network).not.toHaveBeenCalled()
})

it('keeps failed structure distinct from visual review and never infers acceptance from legacy high scores', async () => {
  const h = await fixture()
  const { message, harness } = await createReviewed(h, '画布比例保持 1:1')
  expect(harness.turns[0]?.status).toBe('needs_user_review')
  expect(message.receipt?.completion?.structureStatus).toBe('failed')
  const db = new Database(join(h.path, 'project.db'))
  const legacy = { ...message.receipt! }
  delete legacy.completion
  db.prepare('UPDATE conversation_messages SET receipt_json = ? WHERE id = ?').run(JSON.stringify(legacy), message.id)
  db.close()
  const historical = (await h.runtime.getConversation()).messages.find((entry) => entry.id === message.id)!
  expect(historical.receipt?.completion).toMatchObject({ structureStatus: 'not_checked', visualStatus: 'needs_user_review', scope: null, userAcceptance: null })
  expect(historical.receipt?.completion?.unverifiedMust[0]?.label).toContain('画布比例保持 1:1')
  await expect(h.runtime.acceptDesignReview({ projectId: historical.projectId, messageId: historical.id, sceneRevision: h.runtime.getWorkspaceBootstrap().scene.revision })).rejects.toThrow()
  const check = new Database(join(h.path, 'project.db'), { readonly: true })
  expect(check.prepare('SELECT receipt_json FROM conversation_messages WHERE id = ?').get(message.id)).toEqual({ receipt_json: JSON.stringify(legacy) }); check.close()
})
