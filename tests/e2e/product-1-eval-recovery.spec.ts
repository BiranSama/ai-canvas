import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentRequest } from '../../src/shared/agent'
import type { DesktopApi } from '../../src/shared/desktop-api'

async function launch(userData: string, externalRequests: string[]): Promise<{ readonly app: ElectronApplication; readonly window: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve('.'),
    env: { ...process.env, AI_CANVAS_E2E: '1' }
  })
  const window = await app.firstWindow()
  window.on('request', (request) => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

test('Product 1.0 EVAL-10 restores one complete project through the Renderer IPC bridge after app restart', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-eval-10-e2e-'))
  const userData = join(root, 'user-data')
  const projectDirectory = join(root, 'EVAL-10 IPC 恢复作品.aicanvas')
  const externalRequests: string[] = []
  let running: ElectronApplication | null = null
  try {
    const first = await launch(userData, externalRequests)
    running = first.app
    await first.app.evaluate(({ dialog }, target) => {
      const mutable = dialog as unknown as { showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }> }
      mutable.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target })
    }, projectDirectory)

    // Creating only through IPC can leave the hydrated Renderer on the old
    // project, whose close-time context must correctly be rejected by Main.
    // Use the product action so both sides adopt the new project before work.
    await first.window.getByRole('button', { name: /^项目菜单：/ }).click()
    await first.window.getByRole('menuitem', { name: '新建空白项目', exact: true }).click()
    await expect(first.window.getByRole('button', { name: '项目菜单：EVAL-10 IPC 恢复作品', exact: true })).toBeVisible()

    const setup = await first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const initial = await api.getWorkspaceBootstrap()
      const titleId = globalThis.crypto.randomUUID()
      const title = {
        version: 1 as const,
        id: titleId,
        type: 'text' as const,
        name: '可恢复标题',
        description: '',
        opacity: 1,
        visible: true,
        locked: false,
        groupId: null,
        semanticRole: 'title',
        referencePolicy: 'include' as const,
        transform: { x: 0.12, y: 0.08, width: 0.76, height: 0.12, rotation: 0 },
        zIndex: 0,
        content: 'MORNING RITUAL',
        orientation: 'horizontal' as const,
        align: 'center' as const,
        wrapping: 'none' as const,
        fontFamily: 'Segoe UI Variable',
        fontSize: 84,
        fontWeight: 300,
        fill: '#172033',
        stroke: null,
        strokeWidth: 0,
        shadowColor: null,
        shadowBlur: 0,
        letterSpacing: 18,
        lineHeight: 1.2,
        accuracy: 'strict' as const,
        styleDescription: '轻盈、疏朗、带克制字效参考',
        renderStrategy: 'standard' as const,
        resultAssetId: null
      }
      const mutation = await api.executeSceneCommands({
        expectedSceneRevision: initial.scene.revision,
        batch: {
          id: globalThis.crypto.randomUUID(),
          origin: 'user',
          summary: 'EVAL-10 IPC 建立可恢复场景',
          commands: [
            {
              kind: 'scene.set-canvas',
              canvas: {
                ...initial.scene.canvas,
                aspectWidth: 4,
                aspectHeight: 5,
                outputWidth: 1024,
                outputHeight: 1280,
                globalStyle: '珍珠白、克制蓝色背光、疏朗编辑感'
              }
            },
            { kind: 'element.add', element: title }
          ]
        }
      })
      if (!mutation.ok) throw new Error(mutation.error.message)
      const job = await api.enqueueGeneration({
        prompt: 'Local IPC recovery proof with restrained blue light',
        negativePrompt: '',
        aspectWidth: 4,
        aspectHeight: 5,
        outputWidth: 320,
        outputHeight: 400,
        count: 1,
        providerId: 'mock',
        model: 'mock-balanced',
        references: [],
        parameters: { eval: 'EVAL-10-IPC' },
        sourceMessageId: null,
        parentResultId: null,
        referenceMode: 'hybrid',
        variationInstruction: '',
        preserveConstraints: '保留 4:5、轻盈标题和蓝色背光意图'
      })
      return { projectId: initial.projectId, titleId, jobId: job.id }
    })

    await expect.poll(async () => first.window.evaluate(async (jobId) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      return (await api.listGenerationJobs()).find((job) => job.id === jobId)?.status ?? null
    }, setup.jobId), { timeout: 10_000 }).toBe('completed')

    const linked = await first.window.evaluate(async ({ jobId, titleId }) => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const job = (await api.listGenerationJobs()).find((candidate) => candidate.id === jobId)
      const result = job?.results[0]
      if (job === undefined || result === undefined) throw new Error('EVAL-10 Mock result is unavailable.')
      const placementId = globalThis.crypto.randomUUID()
      await api.placeGenerationResult({ resultId: result.id, placementId, origin: 'user' })
      await api.setGenerationResultFavorite({ resultId: result.id, favorite: true })
      await api.createProjectDirective({
        text: '文字保持轻盈疏朗，蓝色背光作为保留项。',
        category: 'creative',
        priority: 160,
        sourceMessageId: null
      })
      await api.createProjectMemory({
        kind: 'constraint',
        content: '用户确认保留 4:5 与蓝色背光。',
        sourceType: 'user',
        sourceId: 'eval-10-ipc-user-confirmation',
        confidence: 1,
        supersedesId: null
      })
      const bootstrap = await api.getWorkspaceBootstrap()
      const selected = bootstrap.scene.elements.find((element) => element.id === titleId)
      if (selected === undefined) throw new Error('EVAL-10 title selection is unavailable.')
      const sceneSummary: AgentRequest['sceneSummary'] = {
        revision: bootstrap.scene.revision,
        canvas: bootstrap.scene.canvas,
        elementCount: bootstrap.scene.elements.length,
        elements: bootstrap.scene.elements.map((element) => ({
          id: element.id,
          type: element.type,
          name: element.name,
          description: element.description,
          semanticRole: element.semanticRole,
          groupId: element.groupId,
          locked: element.locked,
          visible: element.visible,
          transform: element.transform
        }))
      }
      const run = await api.startAgentRun({
        text: '标题再疏一点并略微下移，保留 4:5 和蓝色背光。',
        sceneSummary,
        selectedIds: [selected.id],
        selectedElements: [selected],
        attachments: [{ kind: 'selection', id: selected.id, name: selected.name }],
        ephemeralAnnotation: null,
        autoGenerate: false,
        activeGenerationJobId: null
      }, 'review')
      return { resultId: result.id, assetId: result.assetId, placementId, runId: run.id }
    }, { jobId: setup.jobId, titleId: setup.titleId })

    await expect.poll(async () => first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const snapshot = await api.getAgentHarnessSnapshot()
      const turn = snapshot.turns.find((candidate) => candidate.status === 'waiting_decision')
      const decision = turn === undefined
        ? undefined
        : snapshot.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
      return turn === undefined || decision === undefined ? null : { turnId: turn.id, decisionId: decision.id }
    }), { timeout: 10_000 }).not.toBeNull()

    const beforeRestart = await first.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const harness = await api.getAgentHarnessSnapshot()
      const turn = harness.turns.find((candidate) => candidate.status === 'waiting_decision')
      const decision = turn === undefined
        ? undefined
        : harness.items.find((item) => item.turnId === turn.id && item.type === 'decision' && item.status === 'waiting')
      if (turn === undefined || decision === undefined) throw new Error('EVAL-10 persistent decision is unavailable.')
      return { turnId: turn.id, decisionId: decision.id }
    })

    await first.app.close()
    running = null

    const second = await launch(userData, externalRequests)
    running = second.app
    const restored = await second.window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { readonly desktop: DesktopApi }).desktop
      const [bootstrap, jobs, families, harness, knowledge, conversation] = await Promise.all([
        api.getWorkspaceBootstrap(),
        api.listGenerationJobs(),
        api.listGenerationResultFamilies(),
        api.getAgentHarnessSnapshot(),
        api.getProjectKnowledge(),
        api.getConversationSnapshot()
      ])
      return { bootstrap, jobs, families, harness, knowledge, conversation }
    })

    expect(restored.bootstrap).toMatchObject({
      projectId: setup.projectId,
      projectName: 'EVAL-10 IPC 恢复作品',
      canUndo: true,
      scene: {
        canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280 },
        elements: expect.arrayContaining([
          expect.objectContaining({ id: setup.titleId, type: 'text', content: 'MORNING RITUAL' }),
          expect.objectContaining({ id: linked.placementId, type: 'image', assetId: linked.assetId })
        ])
      }
    })
    expect(restored.jobs).toHaveLength(1)
    expect(restored.jobs[0]).toMatchObject({
      id: setup.jobId,
      status: 'completed',
      providerId: 'mock',
      model: 'mock-balanced',
      results: [expect.objectContaining({ id: linked.resultId, assetId: linked.assetId, favorite: true })]
    })
    expect(restored.families).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootResultId: linked.resultId, favoriteResultIds: [linked.resultId] })
    ]))
    expect(restored.harness.thread.activeTurnId).toBe(beforeRestart.turnId)
    expect(restored.harness.turns.find((turn) => turn.id === beforeRestart.turnId)).toMatchObject({ status: 'waiting_decision' })
    expect(restored.harness.items.find((item) => item.id === beforeRestart.decisionId)).toMatchObject({ status: 'waiting', type: 'decision' })
    expect(restored.harness.activeGoal).toMatchObject({ mode: 'review', budget: { maxCostCny: 0 } })
    expect(restored.knowledge.directives).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '文字保持轻盈疏朗，蓝色背光作为保留项。', enabled: true })
    ]))
    expect(restored.knowledge.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: '用户确认保留 4:5 与蓝色背光。', status: 'active' })
    ]))
    expect(restored.knowledge.outboundRecords).toEqual([])
    expect(restored.conversation.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: setup.jobId, state: 'completed' }),
      expect.objectContaining({ runId: linked.runId, state: 'waiting' })
    ]))
    expect(externalRequests).toEqual([])
  } finally {
    await running?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
