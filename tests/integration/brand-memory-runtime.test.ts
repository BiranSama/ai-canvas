import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { InMemorySecretVault } from '../../src/main/agent/eval/in-memory-secret-vault'
import { llmProviderConfigSchema } from '../../src/shared/provider-settings'
import { fixtureAgentRequest } from '../helpers/semantic-fixtures'

type Item = Record<string, unknown>

const runtimes: GenerationRuntime[] = []
const roots: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const LLM = llmProviderConfigSchema.parse({
  id: 'openai-compatible-llm', kind: 'llm', label: '测试文字模型', baseUrl: 'https://llm.brand-fixture.test/v1', defaultModel: 'fixture-model',
  protocol: 'openai-responses', reasoningEffort: 'none', imageDetail: 'auto', maxOutputTokens: 4_096, timeoutMs: 60_000, concurrency: 1,
  transport: { mode: 'buffered', connectTimeoutMs: 20_000, firstEventTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
  capabilities: { streaming: false, toolCalling: true, vision: false }
})

function reply(text: string, id: string): Response {
  return new Response(JSON.stringify({ id, status: 'completed', output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 500, output_tokens: 20 } }), {
    headers: { 'content-type': 'application/json' }
  })
}

/** The Agent's turns get a short reply; a request with no tools is a background job and gets a name. */
function model(requests: Item[]) {
  return vi.fn(async (_input: URL | string | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Item
    requests.push(body)
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    return tools === 0 ? reply('晨雾新品海报', `bg-${requests.length}`) : reply('做好了。下一步：看看要不要换个标题。', `turn-${requests.length}`)
  })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'brand-memory-'))
  roots.push(root)
  const runtime = await GenerationRuntime.create(join(root, 'data'), {
    projectLibraryDirectory: join(root, 'library'),
    secretVault: new InMemorySecretVault({ 'openai-compatible-llm': 'sk-brand-fixture-0123456789' }),
    agentEngine: 'multi-step'
  })
  runtimes.push(runtime)
  await runtime.setProviderConfig(LLM)
  return { root, runtime }
}

function briefOf(request: Item): string {
  return JSON.stringify(request.input)
}

async function runTurn(runtime: GenerationRuntime, text: string): Promise<void> {
  const scene = runtime.getWorkspaceBootstrap().scene
  const run = await runtime.startAgentRun(fixtureAgentRequest(scene, text), 'collaboration')
  await expect.poll(async () => {
    const turn = (await runtime.getAgentHarnessSnapshot()).turns.find((candidate) => candidate.inputMessageId === run.id)
    if (turn?.status === 'failed') throw new Error(`${turn.errorCode}: ${turn.errorMessage}`)
    return turn?.status
  }, { timeout: 10_000 }).toMatch(/^completed/)
}

it('copies the logo into a project only when it is used, and every project reads the same memory', async () => {
  const { root, runtime } = await setup()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('OFFLINE') }))
  await runtime.createProject(join(root, 'a.aicanvas'), '春季菜单')
  const projectA = runtime.getWorkspaceBootstrap().scene.projectId
  await expect(runtime.importBrandLogo(projectA)).resolves.toBeNull()
  const bytes = new Uint8Array(await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 20, g: 60, b: 120, alpha: 1 } } }).webp().toBuffer())
  await runtime.setBrandLogo({ mimeType: 'image/webp', bytes })
  await runtime.changeUserMemory({ action: 'add', kind: 'preference', content: '版面留白多一些' })
  const logo = await runtime.importBrandLogo(projectA)
  expect(logo).toMatchObject({ width: 300, height: 100 })
  await expect(runtime.readAssetDataUrl(logo!.assetId, false, projectA)).resolves.toMatch(/^data:image\/png/)

  await runtime.createProject(join(root, 'b.aicanvas'), '秋季菜单')
  const projectB = runtime.getWorkspaceBootstrap().scene.projectId
  await runtime.changeUserMemory({ action: 'project-brand', projectId: projectB, enabled: false })
  const memory = await runtime.getUserMemory()
  expect(memory.memories.map((entry) => entry.content)).toEqual(['版面留白多一些'])
  expect(memory.projectUsesBrand).toBe(false)
  expect(memory.brand.logo).toMatchObject({ width: 300, height: 100 })
  await expect(runtime.importBrandLogo(projectA)).rejects.toThrow('PROJECT_CHANGED')
}, 30_000)

it('briefs turns with the brand and confirmed preferences, and names a new project after its first turn', async () => {
  const { root, runtime } = await setup()
  const requests: Item[] = []
  vi.stubGlobal('fetch', model(requests))
  await runtime.saveBrandKit({ name: '晨雾咖啡', colors: ['#3B6FB6'], titleFont: '', bodyFont: '', copy: [], bannedWords: ['最'] })
  const candidate = (await runtime.getUserMemory()).candidates[0]
  expect(candidate).toBeUndefined()
  await runtime.changeUserMemory({ action: 'add', kind: 'preference', content: '标题喜欢用衬线体' })
  await runtime.createProject(join(root, 'new.aicanvas'), 'Untitled')
  const projectId = runtime.getWorkspaceBootstrap().scene.projectId
  const renamed = vi.fn()
  runtime.subscribeProjectRenamed(renamed)

  await runTurn(runtime, '做一张晨雾香水海报')
  const turnRequest = requests.find((request) => Array.isArray(request.tools) && request.tools.length > 0)!
  expect(briefOf(turnRequest)).toContain('品牌（参考')
  expect(briefOf(turnRequest)).toContain('品牌名：晨雾咖啡')
  expect(briefOf(turnRequest)).toContain('用户偏好（参考')
  expect(briefOf(turnRequest)).toContain('标题喜欢用衬线体')

  await expect.poll(() => runtime.getWorkspaceBootstrap().projectName, { timeout: 10_000 }).toBe('晨雾新品海报')
  expect(renamed).toHaveBeenCalledWith({ projectId, name: '晨雾新品海报' })
  expect((await runtime.listRecentProjects()).find((project) => project.id === projectId)?.name).toBe('晨雾新品海报')
  const naming = requests.filter((request) => !Array.isArray(request.tools) || request.tools.length === 0)
  expect(naming).toHaveLength(1)
  expect(briefOf(naming[0]!)).toContain('做一张晨雾香水海报')

  // Named once: the next turn leaves the name alone, and a project without the brand is briefed without it.
  await runtime.changeUserMemory({ action: 'project-brand', projectId, enabled: false })
  await runTurn(runtime, '标题再大一点')
  const latest = requests.filter((request) => Array.isArray(request.tools) && request.tools.length > 0).at(-1)!
  expect(briefOf(latest)).not.toContain('品牌（参考')
  expect(briefOf(latest)).toContain('标题喜欢用衬线体')
  expect(requests.filter((request) => !Array.isArray(request.tools) || request.tools.length === 0)).toHaveLength(1)
}, 40_000)

it('gives the multi-step engine the project rules and the earlier conversation', async () => {
  const { root, runtime } = await setup()
  const requests: Item[] = []
  vi.stubGlobal('fetch', model(requests))
  await runtime.createProject(join(root, 'rules.aicanvas'), '规则测试')
  await runtime.createProjectDirective({ text: '标题一律使用衬线体', category: 'creative', priority: 100, sourceMessageId: null })
  await runTurn(runtime, '先做一版海报')
  await runTurn(runtime, '标题再大一点')
  const turns = requests.filter((request) => Array.isArray(request.tools) && request.tools.length > 0)
  const second = briefOf(turns.at(-1)!)
  expect(briefOf(turns[0]!)).toContain('项目规则（必须遵守）')
  expect(second).toContain('标题一律使用衬线体')
  expect(second).toContain('之前的对话')
  expect(second).toContain('先做一版海报')
}, 40_000)

it('learns from a manual edit on the layer the Agent made first, and forgets the project when it goes 仅本地', async () => {
  const { root, runtime } = await setup()
  vi.stubGlobal('fetch', vi.fn(async (_input: URL | string | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Item
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    if (tools === 0) return reply('标题海报', 'bg')
    const answered = (body.input as Item[]).some((item) => item.type === 'function_call_output')
    if (answered) return reply('加好了。下一步：看看字体。', 'done')
    return new Response(JSON.stringify({ id: 'call', status: 'completed', output: [
      { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'add_text', arguments: JSON.stringify({ content: '晨雾', role: 'title' }), status: 'completed' }
    ], usage: { input_tokens: 500, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } })
  }))
  await runtime.createProject(join(root, 'learn.aicanvas'), '学习测试')
  await runTurn(runtime, '加一个标题')
  const scene = runtime.getWorkspaceBootstrap().scene
  const title = scene.elements.find((element) => element.type === 'text')!
  expect(title).toBeDefined()
  const edited = await runtime.executeSceneCommands({ expectedSceneRevision: scene.revision, batch: {
    id: crypto.randomUUID(), origin: 'user', summary: '换字体', commands: [{ kind: 'element.update', elementId: title.id, changes: { fontFamily: 'Songti SC' } }]
  } })
  expect(edited.ok).toBe(true)
  await expect.poll(async () => (await runtime.getUserMemory()).learning.signals).toBe(1)

  const knowledge = await runtime.getProjectKnowledge()
  await runtime.setOutboundPolicy({ policy: 'local_only', expectedVersion: knowledge.outboundPolicyVersion })
  expect((await runtime.getUserMemory()).learning).toMatchObject({ signals: 0, newSignals: 0 })
}, 40_000)
