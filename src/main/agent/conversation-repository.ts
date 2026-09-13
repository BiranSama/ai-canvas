import { executeSynchronous } from '../storage/database'
import { randomUUID } from 'node:crypto'
import { completionFactsSchema, type CompletionFacts } from '../../shared/design-capability'
import { agentCompletionAssessmentSchema } from '../../shared/agent-harness'
import {
  agentPlanSchema,
  agentToolPlanSchema,
  agentRequestSchema,
  type AgentPlan,
  type AgentRequest,
  type AgentRun,
  type AgentRunStatus,
  type ConversationAttachment,
  type ConversationMessage,
  type ConversationSnapshot,
  type OperationReceipt
} from '../../shared/agent'
import {
  openDatabase,
  type AgentRunRow,
  type ConversationMessageRow,
  type ConversationRow,
  type DatabaseConnection
} from '../storage/database'

export interface CreatedAgentRun {
  readonly conversationId: string
  readonly userMessage: ConversationMessage
  readonly run: AgentRun
}

export interface AgentRunTransition {
  readonly status: AgentRunStatus
  readonly stepCount?: number
  readonly confirmationRequired?: boolean
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly startedAt?: string | null
  readonly completedAt?: string | null
}

function mapMessage(row: ConversationMessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json) as OperationReceipt,
    attachments: JSON.parse(row.attachments_json) as ConversationAttachment[],
    runId: row.run_id,
    createdAt: row.created_at
  }
}

function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    userMessageId: row.user_message_id,
    status: row.status,
    autoGenerate: row.auto_generate === 1,
    confirmationRequired: row.confirmation_required === 1,
    maxSteps: row.max_steps,
    stepCount: row.step_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

export class ConversationRepository {
  readonly #connection: DatabaseConnection
  readonly #idFactory: () => string
  readonly #now: () => string

  constructor(
    databasePath: string,
    options: { readonly idFactory?: () => string; readonly now?: () => string } = {}
  ) {
    this.#connection = openDatabase(databasePath)
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async ensureConversation(projectId: string, title = '创作对话'): Promise<ConversationRow> {
    const existing = await this.#connection.kysely
      .selectFrom('conversations')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst()
    if (existing !== undefined) return existing
    const now = this.#now()
    const row: ConversationRow = {
      id: this.#idFactory(),
      project_id: projectId,
      title,
      created_at: now,
      updated_at: now
    }
    await this.#connection.kysely.insertInto('conversations').values(row).executeTakeFirstOrThrow()
    return row
  }

  async createRun(projectId: string, requestInput: AgentRequest, maxSteps: number): Promise<CreatedAgentRun> {
    const request = agentRequestSchema.parse(requestInput)
    const conversation = await this.ensureConversation(projectId)
    const now = this.#now()
    const messageId = this.#idFactory()
    const runId = this.#idFactory()
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction.insertInto('conversation_messages').values({
        id: messageId,
        conversation_id: conversation.id,
        project_id: projectId,
        role: 'user',
        kind: 'text',
        content: request.text,
        receipt_json: null,
        attachments_json: JSON.stringify(request.attachments),
        run_id: runId,
        created_at: now
      }))
      executeSynchronous(this.#connection, transaction.insertInto('agent_runs').values({
        id: runId,
        conversation_id: conversation.id,
        project_id: projectId,
        user_message_id: messageId,
        request_json: JSON.stringify(request),
        plan_json: null,
        status: 'queued',
        auto_generate: request.autoGenerate ? 1 : 0,
        confirmation_required: 0,
        max_steps: maxSteps,
        step_count: 0,
        error_code: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null
      }))
      executeSynchronous(this.#connection, transaction.updateTable('conversations').set({ updated_at: now }).where('id', '=', conversation.id))
    })()
    return {
      conversationId: conversation.id,
      userMessage: await this.getMessage(messageId),
      run: await this.getRun(runId)
    }
  }

  async getMessage(messageId: string): Promise<ConversationMessage> {
    const row = await this.#connection.kysely
      .selectFrom('conversation_messages')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirst()
    if (row === undefined) throw new Error(`Conversation message ${messageId} does not exist.`)
    return mapMessage(row)
  }

  recordDesignAcceptance(projectId: string, messageId: string, sceneRevision: number, validateCurrentScene: () => void): ConversationMessage {
    return this.#connection.sqlite.transaction(() => {
      const row = this.#connection.sqlite.prepare('SELECT * FROM conversation_messages WHERE id = ? AND project_id = ? AND role = ?')
        .get(messageId, projectId, 'assistant') as ConversationMessageRow | undefined
      if (row?.receipt_json == null) throw new Error('此记录没有可接受的作品版本。')
      const receipt = JSON.parse(row.receipt_json) as OperationReceipt
      const facts = completionFactsSchema.parse(receipt.completion)
      if (facts.operationStatus !== 'completed' || facts.scope === null || facts.scope.sceneRevision !== sceneRevision) {
        throw new Error('这份检查不对应当前作品版本，请重新检查后再接受。')
      }
      for (const resultId of facts.scope.resultIds) {
        const available = this.#connection.sqlite.prepare(`SELECT 1 FROM generation_results r JOIN assets a ON a.id = r.asset_id
          WHERE r.id = ? AND r.project_id = ? AND a.status = 'available'`).get(resultId, projectId)
        if (available === undefined) throw new Error('本轮结果已删除或失效，不能接受旧范围。')
      }
      validateCurrentScene()
      if (facts.userAcceptance === null) {
        const updated: OperationReceipt = { ...receipt, completion: { ...facts,
          userAcceptance: { acceptedAt: this.#now(), sceneRevision, resultIds: [...facts.scope.resultIds] } } }
        this.#connection.sqlite.prepare('UPDATE conversation_messages SET receipt_json = ? WHERE id = ?')
          .run(JSON.stringify(updated), messageId)
        return mapMessage({ ...row, receipt_json: JSON.stringify(updated) })
      }
      return mapMessage(row)
    }).immediate()
  }

  async appendUserMessage(runId: string, requestInput: AgentRequest): Promise<ConversationMessage> {
    const request = agentRequestSchema.parse(requestInput)
    const run = await this.getRun(runId)
    const id = this.#idFactory()
    const now = this.#now()
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction.insertInto('conversation_messages').values({
        id,
        conversation_id: run.conversationId,
        project_id: run.projectId,
        role: 'user',
        kind: 'text',
        content: request.text,
        receipt_json: null,
        attachments_json: JSON.stringify(request.attachments),
        run_id: runId,
        created_at: now
      }))
      executeSynchronous(this.#connection, transaction.updateTable('conversations').set({ updated_at: now }).where('id', '=', run.conversationId))
    })()
    return this.getMessage(id)
  }

  async getRun(runId: string): Promise<AgentRun> {
    const row = await this.#connection.kysely.selectFrom('agent_runs').selectAll().where('id', '=', runId).executeTakeFirst()
    if (row === undefined) throw new Error(`Agent run ${runId} does not exist.`)
    return mapRun(row)
  }

  async getRequest(runId: string): Promise<AgentRequest> {
    const row = await this.#connection.kysely
      .selectFrom('agent_runs')
      .select('request_json')
      .where('id', '=', runId)
      .executeTakeFirst()
    if (row === undefined) throw new Error(`Agent run ${runId} does not exist.`)
    return agentRequestSchema.parse(JSON.parse(row.request_json))
  }

  async getPlan(runId: string): Promise<AgentPlan | null> {
    const row = await this.#connection.kysely.selectFrom('agent_runs').select('plan_json').where('id', '=', runId).executeTakeFirst()
    if (row === undefined) throw new Error(`Agent run ${runId} does not exist.`)
    return row.plan_json === null ? null : agentPlanSchema.parse(JSON.parse(row.plan_json))
  }

  async setPlanAspectRatio(runId: string, aspectWidth: number, aspectHeight: number): Promise<AgentPlan> {
    const plan = await this.getPlan(runId)
    if (plan === null) throw new Error(`Agent run ${runId} does not have a plan.`)
    const longEdge = 1280
    const outputWidth = aspectWidth >= aspectHeight ? longEdge : Math.round(longEdge * aspectWidth / aspectHeight)
    const outputHeight = aspectWidth >= aspectHeight ? Math.round(longEdge * aspectHeight / aspectWidth) : longEdge
    const updated = agentPlanSchema.parse({
      ...plan,
      tools: plan.tools.map((tool) => tool.kind !== 'scene_batch' ? tool : {
        ...tool,
        commands: tool.commands.map((command) => command.kind !== 'scene.set-canvas' ? command : {
          ...command,
          canvas: { ...command.canvas, aspectWidth, aspectHeight, outputWidth, outputHeight }
        })
      })
    })
    await this.#connection.kysely.updateTable('agent_runs').set({ plan_json: JSON.stringify(updated), updated_at: this.#now() })
      .where('id', '=', runId).executeTakeFirstOrThrow()
    return updated
  }

  async transition(runId: string, transition: AgentRunTransition): Promise<AgentRun> {
    const current = await this.getRun(runId)
    const now = this.#now()
    await this.#connection.kysely.updateTable('agent_runs').set({
      status: transition.status,
      step_count: transition.stepCount ?? current.stepCount,
      confirmation_required: transition.confirmationRequired === undefined
        ? (current.confirmationRequired ? 1 : 0)
        : (transition.confirmationRequired ? 1 : 0),
      error_code: transition.errorCode === undefined ? current.errorCode : transition.errorCode,
      error_message: transition.errorMessage === undefined ? current.errorMessage : transition.errorMessage,
      started_at: transition.startedAt === undefined ? current.startedAt : transition.startedAt,
      completed_at: transition.completedAt === undefined ? current.completedAt : transition.completedAt,
      updated_at: now
    }).where('id', '=', runId).executeTakeFirstOrThrow()
    return this.getRun(runId)
  }

  async savePlan(runId: string, planInput: AgentPlan, confirmationRequired: boolean): Promise<AgentRun> {
    const plan = agentPlanSchema.parse(planInput)
    const run = await this.getRun(runId)
    if (plan.tools.length > run.maxSteps) throw new Error(`Agent plan exceeds the ${run.maxSteps}-step limit.`)
    const now = this.#now()
    this.#connection.sqlite.transaction(() => {
      const transaction = this.#connection.kysely
      executeSynchronous(this.#connection, transaction.updateTable('agent_runs').set({
        plan_json: JSON.stringify(plan),
        status: confirmationRequired ? 'awaiting_confirmation' : 'awaiting_execution',
        confirmation_required: confirmationRequired ? 1 : 0,
        step_count: plan.tools.length,
        updated_at: now
      }).where('id', '=', runId))
      // The v2 Item/Event ledger retains every superseded step. This legacy
      // table is only a current-plan projection, so replace it atomically when
      // a correction causes replanning instead of colliding on run+ordinal.
      executeSynchronous(this.#connection, transaction.deleteFrom('agent_tool_calls').where('run_id', '=', runId))
      for (const [ordinal, tool] of plan.tools.entries()) {
        executeSynchronous(this.#connection, transaction.insertInto('agent_tool_calls').values({
          id: this.#idFactory(),
          run_id: runId,
          ordinal,
          tool_name: tool.kind,
          status: 'planned',
          arguments_json: JSON.stringify(tool),
          result_json: null,
          error_message: null,
          created_at: now,
          completed_at: null
        }))
      }
    })()
    return this.getRun(runId)
  }

  async appendAssistantMessage(
    runId: string,
    kind: 'text' | 'receipt' | 'error',
    content: string,
    receipt: OperationReceipt | null
  ): Promise<ConversationMessage> {
    const run = await this.getRun(runId)
    const now = this.#now()
    const id = this.#idFactory()
    await this.#connection.kysely.insertInto('conversation_messages').values({
      id,
      conversation_id: run.conversationId,
      project_id: run.projectId,
      role: 'assistant',
      kind,
      content,
      receipt_json: receipt === null ? null : JSON.stringify(receipt),
      attachments_json: '[]',
      run_id: runId,
      created_at: now
    }).executeTakeFirstOrThrow()
    return this.getMessage(id)
  }

  async ensureToolCall(runId: string, ordinal: number, input: AgentPlan['tools'][number]): Promise<void> {
    const tool = agentToolPlanSchema.parse(input)
    const run = await this.getRun(runId)
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= run.maxSteps) throw new Error('Tool ordinal exceeds the run step limit.')
    const now = this.#now()
    // Refinements are real steps added after the initial plan. Append their
    // compatibility rows without replacing completed calls or their receipts.
    this.#connection.sqlite.transaction(() => {
      executeSynchronous(this.#connection, this.#connection.kysely.insertInto('agent_tool_calls').values({
        id: this.#idFactory(), run_id: runId, ordinal, tool_name: tool.kind, status: 'planned',
        arguments_json: JSON.stringify(tool), result_json: null, error_message: null, created_at: now, completed_at: null
      }).onConflict((conflict) => conflict.columns(['run_id', 'ordinal']).doNothing()))
      executeSynchronous(this.#connection, this.#connection.kysely.updateTable('agent_runs')
        .set({ step_count: Math.max(run.stepCount, ordinal + 1), updated_at: now }).where('id', '=', runId))
    })()
  }

  async recordToolOutcome(
    runId: string,
    ordinal: number,
    outcome: { readonly ok: boolean; readonly result: unknown; readonly errorMessage: string | null }
  ): Promise<void> {
    await this.#connection.kysely.updateTable('agent_tool_calls').set({
      status: outcome.ok ? 'completed' : 'failed',
      result_json: JSON.stringify(outcome.result),
      error_message: outcome.errorMessage,
      completed_at: this.#now()
    }).where('run_id', '=', runId).where('ordinal', '=', ordinal).executeTakeFirstOrThrow()
  }

  async recoverInterrupted(projectId: string): Promise<number> {
    const now = this.#now()
    const result = await this.#connection.kysely.updateTable('agent_runs').set({
      status: 'interrupted',
      error_code: 'APP_INTERRUPTED',
      error_message: 'The app stopped before this assistant action finished. The user message is preserved.',
      completed_at: now,
      updated_at: now
    }).where('project_id', '=', projectId).where('status', 'in', [
      'queued', 'planning', 'awaiting_confirmation', 'awaiting_execution', 'executing'
    ].filter((status) => status !== 'awaiting_confirmation') as AgentRunStatus[]).executeTakeFirst()
    return Number(result.numUpdatedRows)
  }

  async getSnapshot(projectId: string): Promise<ConversationSnapshot> {
    const conversation = await this.ensureConversation(projectId)
    const [messages, runs] = await Promise.all([
      this.#connection.kysely.selectFrom('conversation_messages').selectAll()
        .where('conversation_id', '=', conversation.id).orderBy('created_at', 'asc').orderBy('id', 'asc').execute(),
      this.#connection.kysely.selectFrom('agent_runs').selectAll()
        .where('conversation_id', '=', conversation.id).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()
    ])
    const availableResultIds = new Set((this.#connection.sqlite.prepare(`SELECT r.id FROM generation_results r JOIN assets a ON a.id = r.asset_id
      WHERE r.project_id = ? AND a.status = 'available'`).all(projectId) as { id: string }[]).map((row) => row.id))
    return {
      conversationId: conversation.id,
      projectId,
      messages: messages.map((row) => {
        const message = mapMessage(row)
        if (message.receipt?.completion !== undefined) {
          const missing = message.receipt.completion.scope?.resultIds.some((id) => !availableResultIds.has(id)) === true
          return { ...message, receipt: { ...message.receipt, completion: { ...message.receipt.completion,
            scopeUnavailableReason: missing ? '本轮结果已删除或失效，原接受范围不再完整。' : null } } }
        }
        if (message.receipt?.designReview === undefined) return message
        const old = this.#connection.sqlite.prepare(`SELECT i.payload_json FROM agent_items i JOIN agent_turns_v2 t ON t.id = i.turn_id
          WHERE t.input_message_id = ? AND i.type = 'completion_assessment' ORDER BY i.ordinal DESC LIMIT 1`).get(message.runId) as { payload_json: string } | undefined
        let unverifiedMust: CompletionFacts['unverifiedMust'] = []
        if (old !== undefined) {
          try {
            const assessment = agentCompletionAssessmentSchema.parse(JSON.parse(old.payload_json))
            unverifiedMust = assessment.design?.requirements.filter((entry) => entry.id.startsWith('acceptance:') && entry.label.startsWith('必须：') && entry.status !== 'pass')
              .map((entry) => ({ id: entry.id, label: entry.label, reason: entry.evidence.join('；') })) ?? []
          } catch { /* Old malformed evidence stays unverified; preserve its bytes. */ }
        }
        const completion: CompletionFacts = { version: 1, operationStatus: message.receipt.items.length > 0 ? 'completed' : 'not_requested',
          structureStatus: 'not_checked', visualStatus: 'needs_user_review',
          unverifiedMust: unverifiedMust.length ? unverifiedMust : [{ id: 'legacy-review', label: '历史视觉验收', reason: '历史分数不代表用户接受；缺少完整检查证据，需重新复核当前版本。' }],
          scope: null, userAcceptance: null }
        return { ...message, receipt: { ...message.receipt, completion, designReview: { ...message.receipt.designReview, recommendation: 'needs_user_review' as const } } }
      }),
      runs: runs.map(mapRun)
      ,activities: []
    }
  }

  async close(): Promise<void> {
    await this.#connection.kysely.destroy()
  }
}
