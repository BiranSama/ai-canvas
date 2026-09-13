import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DesktopApi } from '../../src/shared/desktop-api'
import type { LlmProtocol } from '../../src/shared/provider-settings'

type Scenario = 'normal' | 'repair' | 'exhausted' | 'incomplete' | 'cancel'
interface FakeFacts { posts: number; cancelled: number; emittedAt: number; firstEventAt: number; requests: Array<{ stream: boolean }> }

for (const fixture of [
  { name: 'Responses SSE', protocol: 'openai-responses', stream: true, scenario: 'normal' },
  { name: 'Ark SSE', protocol: 'ark-responses', stream: true, scenario: 'normal' },
  { name: 'Chat SSE', protocol: 'openai-chat-completions', stream: true, scenario: 'normal' },
  { name: 'buffered JSON', protocol: 'openai-responses', stream: false, scenario: 'normal' },
  { name: 'one bounded repair', protocol: 'openai-responses', stream: true, scenario: 'repair' },
  { name: 'repair exhaustion', protocol: 'openai-responses', stream: true, scenario: 'exhausted' },
  { name: 'missing terminal without repost', protocol: 'openai-responses', stream: true, scenario: 'incomplete' },
  { name: 'user cancellation without repost', protocol: 'openai-responses', stream: true, scenario: 'cancel' }
] satisfies Array<{ name: string; protocol: LlmProtocol; stream: boolean; scenario: Scenario }>) {
  test(`LT1 desktop uses Main Fake Fetch: ${fixture.name}`, async () => {
    const testInfo = test.info()
    test.setTimeout(25_000)
    const userData = await mkdtemp(join(tmpdir(), 'ai-canvas-lt1-desktop-'))
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: resolve('.'), env: { ...process.env, AI_CANVAS_E2E: '1' } })
    try {
      // The real runtime constructs its LLM client per attempt. Replace Fetch
      // in this disposable Main process before configuration; never delegate
      // to real Fetch, store request bodies, or read the owner's settings/key.
      await app.evaluate((_electron, scenario) => {
        const scope = globalThis as typeof globalThis & { __lt1Facts: FakeFacts }
        scope.__lt1Facts = { posts: 0, cancelled: 0, emittedAt: 0, firstEventAt: 0, requests: [] }
        scope.fetch = async (input, init) => {
          if (!String(input).startsWith('https://lt1.example.test/v1/') || init?.method !== 'POST') throw new Error('OFFLINE_FAKE_FETCH_BLOCKED')
          const body = JSON.parse(String(init.body)) as { stream?: boolean }
          const facts = scope.__lt1Facts
          facts.posts += 1
          facts.requests.push({ stream: body.stream === true })
          const invalid = scenario === 'exhausted' || scenario === 'repair' && facts.posts === 1
          const args = JSON.stringify({ summary: '建立方形构图', response: '已建立方形构图。', nextAction: null,
            tools: invalid ? [{ kind: 'not_a_registered_tool' }] : [{ kind: 'scene.set_canvas', summary: '建立方形画布', expectedSceneRevision: 0, canvas: {
              aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024,
              backgroundColor: '#172033', transparent: false, globalStyle: ''
            } }]
          })
          const id = `resp-fake-${facts.posts}`
          const output = [{ type: 'function_call', call_id: 'call-fake', name: 'submitAgentPlan', arguments: args }]
          if (!body.stream) return new Response(JSON.stringify({ id, status: 'completed', output }), { headers: { 'content-type': 'application/json' } })
          const chat = String(input).endsWith('/chat/completions')
          const timers: Array<ReturnType<typeof setTimeout>> = []
          let closed = false
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (value: unknown) => {
                if (closed) return
                facts.emittedAt = Date.now()
                if (facts.firstEventAt === 0) facts.firstEventAt = facts.emittedAt
                controller.enqueue(new TextEncoder().encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`))
              }
              timers.push(setTimeout(() => send(chat
                ? { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-fake', function: { name: 'submitAgentPlan', arguments: '' } }] } }] }
                : { type: 'response.created', response: { id } }), 30))
              if (scenario === 'cancel') return
              timers.push(setTimeout(() => send(chat
                ? { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: 'tool_calls' }] }
                : { type: 'response.output_item.done', output_index: 0, item: output[0] }), 250))
              timers.push(setTimeout(() => {
                if (closed) return
                if (scenario !== 'incomplete') send(chat ? '[DONE]' : { type: 'response.completed', response: { id, status: 'completed', output } })
                if (!closed) { controller.close(); closed = true }
              }, 600))
            },
            cancel() { closed = true; facts.cancelled += 1; for (const timer of timers) clearTimeout(timer) }
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
        }
      }, fixture.scenario)
      const window = await app.firstWindow()
      await window.setViewportSize({ width: 1280, height: 800 })
      await window.evaluate(async (settings) => {
        const api = (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop
        const current = (await api.getProviderSettings()).providers.find((provider) => provider.kind === 'llm')!
        if (current.kind !== 'llm') throw new Error('Fixture requires LLM config')
        await api.setProviderConfig({ ...current, label: 'Offline Fixture', baseUrl: 'https://lt1.example.test/v1',
          defaultModel: 'fixture-model', protocol: settings.protocol, timeoutMs: 10_000,
          capabilities: { streaming: settings.stream, vision: false, toolCalling: true },
          transport: { mode: 'auto', connectTimeoutMs: 5_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 5_000 }
        })
        await api.setProviderSecret({ providerId: 'openai-compatible-llm', apiKey: 'lt1-fixture-not-a-real-key' })
      }, { protocol: fixture.protocol, stream: fixture.stream })
      await window.getByRole('button', { name: '对话', exact: true }).click({ force: true })
      await window.getByRole('textbox', { name: '对话输入' }).fill('建立一个 1:1 的方形画布，不生成图片。')
      await window.evaluate(() => {
        const browser = globalThis as typeof globalThis & { __lt1ReceivingAt: number; document: {
          body: unknown; querySelector(selector: string): { textContent: string | null } | null
        }; MutationObserver: new (callback: () => void) => { observe(target: unknown, options: unknown): void; disconnect(): void } }
        browser.__lt1ReceivingAt = 0
        const observer = new browser.MutationObserver(() => {
          if (browser.document.querySelector('.execution-status')?.textContent !== '接收中') return
          browser.__lt1ReceivingAt = Date.now()
          observer.disconnect()
        })
        observer.observe(browser.document.body, { subtree: true, childList: true, characterData: true })
      })
      await window.getByRole('button', { name: '发送要求' }).click({ force: true })
      const flow = window.getByTestId('agent-live-plan')
      if (fixture.scenario === 'cancel') {
        await expect(flow.locator('.execution-status')).toHaveText('接收中')
        await window.screenshot({ path: testInfo.outputPath('lt1-agent-receiving-1280x800.png'), animations: 'disabled' })
        await flow.getByRole('button', { name: '停止当前操作' }).click()
        await expect(flow.locator('.execution-status')).toHaveText('已停止')
      } else if (fixture.scenario === 'exhausted' || fixture.scenario === 'incomplete') {
        await expect(flow.getByRole('button', { name: '恢复要求' })).toBeVisible({ timeout: 10_000 })
        if (fixture.scenario === 'exhausted') await window.screenshot({ path: testInfo.outputPath('lt1-agent-repair-exhausted-1280x800.png'), animations: 'disabled' })
      } else {
        await window.getByRole('button', { name: '本轮执行记录', exact: true }).click()
      await expect(flow.locator('.execution-status')).toHaveText('已完成', { timeout: 10_000 })
      }
      const facts = await app.evaluate(() => (globalThis as typeof globalThis & { __lt1Facts: FakeFacts }).__lt1Facts)
      expect(facts.posts).toBe(fixture.scenario === 'repair' ? 2 : fixture.scenario === 'exhausted' ? 3 : 1)
      expect(facts.requests.every((request) => request.stream === fixture.stream)).toBe(true)
      if (fixture.stream) {
        const receivedAt = await window.evaluate(() => (globalThis as typeof globalThis & { __lt1ReceivingAt: number }).__lt1ReceivingAt)
        expect(receivedAt).toBeGreaterThanOrEqual(facts.firstEventAt)
        expect(receivedAt - facts.firstEventAt).toBeLessThan(250)
        console.log(`LT1 ${fixture.name} Main SSE -> UI=${receivedAt - facts.firstEventAt}ms`)
      }
      const state = await window.evaluate(async () => {
        const api = (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop
        const snapshot = await api.getAgentHarnessSnapshot()
        return { status: snapshot.turns[0]?.status, modelTurns: snapshot.turns[0]?.modelTurnsUsed,
          tools: snapshot.items.filter((item) => item.type === 'tool_call').length }
      })
      expect(state.tools).toBe(['exhausted', 'incomplete', 'cancel'].includes(fixture.scenario) ? 0 : 1)
      expect(state.modelTurns).toBe(facts.posts)
      await expect(window.locator('body')).not.toContainText('submitAgentPlan')
      await expect(window.locator('body')).not.toContainText('lt1-fixture-not-a-real-key')
    } finally {
      await app.close()
      await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  })
}
