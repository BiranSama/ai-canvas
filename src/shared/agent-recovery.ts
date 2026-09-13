import { z } from 'zod'

export const agentFailurePhaseSchema = z.enum(['planning', 'validation', 'preview', 'tool', 'commit', 'provider', 'budget'])
export const agentFailureCategorySchema = z.enum([
  'model_output', 'schema', 'scope', 'revision', 'permission', 'local_execution',
  'external_state', 'protocol', 'network', 'budget'
])
export const agentFailureRetryClassSchema = z.enum([
  'model_can_repair', 'refresh_then_replan', 'user_action_required', 'query_only', 'local_retry', 'terminal'
])
export const agentExternalStateSchema = z.enum(['not_started', 'known_failed', 'unknown', 'completed'])
export const agentReplacementScopeSchema = z.enum(['arguments_only', 'single_tool', 'remaining_plan', 'full_plan', 'none'])
export const agentAllowedRecoveryActionSchema = z.enum([
  'repair', 'refresh_and_replan', 'query_remote', 'retry_read', 'open_settings', 'ask_user', 'stop'
])

const schemaIssueV1Schema = z.object({ path: z.string().max(240), expected: z.string().max(300) })
const schemaIssueV2Schema = schemaIssueV1Schema.extend({ issueCode: z.string().trim().min(1).max(120) })

export const agentFailureEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/),
  phase: agentFailurePhaseSchema,
  category: agentFailureCategorySchema,
  retryClass: agentFailureRetryClassSchema,
  toolName: z.string().trim().min(1).max(160).nullable(),
  safeMessage: z.string().trim().min(1).max(1_000),
  schemaIssues: z.array(schemaIssueV1Schema).max(40),
  expectedSceneRevision: z.number().int().nonnegative().nullable(),
  currentSceneRevision: z.number().int().nonnegative().nullable(),
  affectedElementIds: z.array(z.string().uuid()).max(1_000),
  externalState: agentExternalStateSchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().nonnegative()
})

export const agentFailureEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  failureId: z.string().uuid(),
  parentFailureId: z.string().uuid().nullable(),
  requestCorrelationId: z.string().uuid().nullable(),
  providerAttemptId: z.string().uuid().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/),
  phase: agentFailurePhaseSchema,
  category: agentFailureCategorySchema,
  retryClass: agentFailureRetryClassSchema,
  externalState: agentExternalStateSchema,
  toolName: z.string().trim().min(1).max(160).nullable(),
  safeMessage: z.string().trim().min(1).max(1_000),
  schemaIssues: z.array(schemaIssueV2Schema).max(40),
  expectedSceneRevision: z.number().int().nonnegative().nullable(),
  currentSceneRevision: z.number().int().nonnegative().nullable(),
  affectedElementIds: z.array(z.string().uuid()).max(1_000),
  repairRecipeId: z.string().trim().min(1).max(160).nullable(),
  repairFacts: z.array(z.string().trim().min(1).max(500)).max(40),
  prohibitedRepairs: z.array(z.string().trim().min(1).max(500)).max(40),
  replacementScope: agentReplacementScopeSchema,
  completedToolIndexes: z.array(z.number().int().nonnegative().max(11)).max(12),
  failedToolIndex: z.number().int().nonnegative().max(11).nullable(),
  unstartedToolIndexes: z.array(z.number().int().nonnegative().max(11)).max(12),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().nonnegative(),
  remainingModelTurns: z.number().int().nonnegative(),
  remainingRecoveryAttempts: z.number().int().nonnegative(),
  remainingWallTimeMs: z.number().int().nonnegative(),
  remainingCostCny: z.number().nonnegative().nullable(),
  allowedActions: z.array(agentAllowedRecoveryActionSchema).max(7),
  createdAt: z.string().datetime({ offset: true })
})

export const agentFailureEnvelopeSchema = z.union([agentFailureEnvelopeV2Schema, agentFailureEnvelopeV1Schema])

export type AgentFailureEnvelopeV1 = z.infer<typeof agentFailureEnvelopeV1Schema>
export type AgentFailureEnvelopeV2 = z.infer<typeof agentFailureEnvelopeV2Schema>
export type AgentFailureEnvelope = z.infer<typeof agentFailureEnvelopeSchema>
export type AgentFailureRetryClass = z.infer<typeof agentFailureRetryClassSchema>
export type FailurePhase = z.infer<typeof agentFailurePhaseSchema>
export type FailureCategory = z.infer<typeof agentFailureCategorySchema>
export type ExternalState = z.infer<typeof agentExternalStateSchema>
export type ReplacementScope = z.infer<typeof agentReplacementScopeSchema>
export type AllowedRecoveryAction = z.infer<typeof agentAllowedRecoveryActionSchema>

export interface AgentErrorRecipe {
  readonly code: string
  readonly phase: FailurePhase
  readonly category: FailureCategory
  readonly defaultRetryClass: AgentFailureRetryClass
  readonly defaultExternalState: ExternalState
  readonly publicTitle: string
  readonly publicExplanation: string
  readonly repairInstruction: string | null
  readonly replacementScope: ReplacementScope
  readonly includeAllowedToolSchemas: boolean
  readonly refreshSceneBeforeRepair: boolean
  readonly allowedActions: readonly AllowedRecoveryAction[]
  readonly prohibitedRepairs: readonly string[]
  readonly maxAutomaticModelRepairs: number
  readonly maxAutomaticLocalRetries: number
}

const STOP_ONLY = ['stop'] as const

function recipe(code: string, input: Omit<AgentErrorRecipe, 'code'>): AgentErrorRecipe {
  return Object.freeze({ code, ...input })
}

const MODEL_REPAIR_BASE = {
  phase: 'validation', category: 'model_output', defaultRetryClass: 'model_can_repair', defaultExternalState: 'completed',
  publicTitle: '创作方案需要修正',
  publicExplanation: '模型响应已经完成，但其中的结构化操作不能安全执行；画布尚未修改。',
  repairInstruction: '只修正报告的结构化问题，不改变已验证步骤，不编造元素身份、坐标或用户文字。',
  replacementScope: 'single_tool', includeAllowedToolSchemas: true, refreshSceneBeforeRepair: false,
  allowedActions: ['repair', 'ask_user', 'stop'],
  prohibitedRepairs: ['不得猜测截断 JSON', '不得重放已经完成的工具', '不得切换 Provider、模型或协议'],
  maxAutomaticModelRepairs: 2, maxAutomaticLocalRetries: 0
} as const satisfies Omit<AgentErrorRecipe, 'code'>

function modelRecipe(code: string, overrides: Partial<Omit<AgentErrorRecipe, 'code'>> = {}): AgentErrorRecipe {
  return recipe(code, { ...MODEL_REPAIR_BASE, ...overrides })
}

function terminalProviderRecipe(
  code: string,
  title: string,
  explanation: string,
  actions: readonly AllowedRecoveryAction[] = ['open_settings', 'ask_user', 'stop'],
  overrides: Partial<Omit<AgentErrorRecipe, 'code'>> = {}
): AgentErrorRecipe {
  return recipe(code, {
    phase: 'provider', category: 'network', defaultRetryClass: 'terminal', defaultExternalState: 'unknown',
    publicTitle: title, publicExplanation: explanation, repairInstruction: null, replacementScope: 'none',
    includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false, allowedActions: actions,
    prohibitedRepairs: ['不得自动重新提交 POST', '不得切换 Provider、模型、协议或 Base URL'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0,
    ...overrides
  })
}

function permissionRecipe(code: string, title: string): AgentErrorRecipe {
  return recipe(code, {
    phase: 'validation', category: 'permission', defaultRetryClass: 'user_action_required', defaultExternalState: 'not_started',
    publicTitle: title, publicExplanation: '作品尚未修改，需要用户处理权限、锁定或批准条件。', repairInstruction: null,
    replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['ask_user', 'stop'], prohibitedRepairs: ['不得绕过权限、锁定或批准'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  })
}

function budgetRecipe(code: string, title: string): AgentErrorRecipe {
  return recipe(code, {
    phase: 'budget', category: 'budget', defaultRetryClass: 'user_action_required', defaultExternalState: 'not_started',
    publicTitle: title, publicExplanation: '本轮已在已批准边界前停止；不会创建新的请求或写入。', repairInstruction: null,
    replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['ask_user', 'stop'], prohibitedRepairs: ['不得绕过预算'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  })
}

export const AGENT_ERROR_RECIPES: Readonly<Record<string, AgentErrorRecipe>> = Object.freeze({
  MODEL_OUTPUT_TRUNCATED: modelRecipe('MODEL_OUTPUT_TRUNCATED', { replacementScope: 'remaining_plan' }),
  MODEL_ARGUMENTS_INVALID: modelRecipe('MODEL_ARGUMENTS_INVALID', {
    replacementScope: 'arguments_only',
    repairInstruction: '重新提交一个完整合法的 submitAgentPlan JSON 对象。依据 schemaIssues 的语法位置修正格式，字符串内引号和换行必须转义；禁止注释、尾逗号、表达式、Markdown 或拼接多个对象。保留原用户意图与已提交步骤，不得执行或猜测修补损坏的参数。'
  }),
  MODEL_TOOL_UNSUPPORTED: modelRecipe('MODEL_TOOL_UNSUPPORTED'),
  MODEL_TOOL_CALL_MISSING: modelRecipe('MODEL_TOOL_CALL_MISSING', { replacementScope: 'full_plan' }),
  MODEL_PLAN_SCHEMA_INVALID: modelRecipe('MODEL_PLAN_SCHEMA_INVALID', { category: 'schema' }),
  MODEL_ACTION_PLAN_EMPTY: modelRecipe('MODEL_ACTION_PLAN_EMPTY', { replacementScope: 'full_plan' }),
  MODEL_OUTPUT_FILTERED: modelRecipe('MODEL_OUTPUT_FILTERED', {
    defaultRetryClass: 'user_action_required', repairInstruction: null, allowedActions: ['ask_user', 'stop'], maxAutomaticModelRepairs: 0
  }),
  PROVIDER_RESPONSE_TRUNCATED: modelRecipe('PROVIDER_RESPONSE_TRUNCATED', { replacementScope: 'remaining_plan' }),
  PROVIDER_PROTOCOL_MISMATCH: terminalProviderRecipe('PROVIDER_PROTOCOL_MISMATCH', '协议响应无法解析', '供应商已返回内容，但不符合当前显式协议；应用不会自动创建第二个请求。', undefined, { category: 'protocol', defaultExternalState: 'known_failed' }),
  PROVIDER_CONTENT_TYPE_MISMATCH: terminalProviderRecipe('PROVIDER_CONTENT_TYPE_MISMATCH', '响应格式不匹配', '流式请求没有返回可识别的事件流。', undefined, { category: 'protocol', defaultExternalState: 'known_failed' }),
  PROVIDER_STREAM_MALFORMED: terminalProviderRecipe('PROVIDER_STREAM_MALFORMED', '响应流格式错误', '供应商返回了不能安全解析的事件。', undefined, { category: 'protocol', defaultExternalState: 'known_failed' }),
  PROVIDER_STREAM_INCOMPLETE: terminalProviderRecipe('PROVIDER_STREAM_INCOMPLETE', '响应流提前结束', '连接结束前没有收到协议要求的完成事件。', undefined, { category: 'protocol', defaultExternalState: 'known_failed' }),
  PROVIDER_STREAM_UNSUPPORTED: terminalProviderRecipe('PROVIDER_STREAM_UNSUPPORTED', '当前配置不支持流式响应', '请求尚未发送；请检查协议、能力声明与传输方式。', undefined, { category: 'protocol', defaultExternalState: 'not_started' }),
  PROVIDER_TOOL_ARGUMENTS_INCOMPLETE: terminalProviderRecipe('PROVIDER_TOOL_ARGUMENTS_INCOMPLETE', '工具参数未完成', '工具参数仍在分片时响应流已经结束。', undefined, { category: 'protocol', defaultExternalState: 'known_failed' }),
  PROVIDER_KEY_MISSING: terminalProviderRecipe('PROVIDER_KEY_MISSING', '缺少供应商凭据', '请在设置中安全保存文字模型凭据。', undefined, { defaultExternalState: 'not_started' }),
  PROVIDER_AUTH_FAILED: terminalProviderRecipe('PROVIDER_AUTH_FAILED', '供应商鉴权失败', '供应商拒绝了当前凭据或账户权限。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_RATE_LIMITED: terminalProviderRecipe('PROVIDER_RATE_LIMITED', '供应商请求受限', '供应商当前拒绝更多请求；应用不会自动重复提交。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_CONNECT_TIMEOUT: terminalProviderRecipe('PROVIDER_CONNECT_TIMEOUT', '连接文字模型超时', '应用没有在连接上限内收到响应头。'),
  PROVIDER_FIRST_EVENT_TIMEOUT: terminalProviderRecipe('PROVIDER_FIRST_EVENT_TIMEOUT', '等待首个响应超时', '连接已建立，但没有在首事件上限内收到正文或合法事件。'),
  PROVIDER_IDLE_TIMEOUT: terminalProviderRecipe('PROVIDER_IDLE_TIMEOUT', '文字模型响应停滞', '响应已经开始，但超过空闲上限没有收到新数据。'),
  PROVIDER_TOTAL_TIMEOUT: terminalProviderRecipe('PROVIDER_TOTAL_TIMEOUT', '文字模型响应超时', '单次请求达到无条件总时间上限。'),
  PROVIDER_CANCELLED: terminalProviderRecipe('PROVIDER_CANCELLED', '请求已停止', '当前文字模型请求已由用户或上层流程停止。', STOP_ONLY),
  PROVIDER_NETWORK_ERROR: terminalProviderRecipe('PROVIDER_NETWORK_ERROR', '无法连接供应商', '连接中断且远端状态无法安全确认。'),
  PROVIDER_TIMEOUT: terminalProviderRecipe('PROVIDER_TIMEOUT', '文字模型响应超时', '旧传输路径达到单次请求总上限；应用不会自动重复提交。'),
  PROVIDER_EMPTY_RESPONSE: terminalProviderRecipe('PROVIDER_EMPTY_RESPONSE', '供应商返回空响应', '请求已完成，但没有可验证的正文。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_RESPONSE_FAILED: terminalProviderRecipe('PROVIDER_RESPONSE_FAILED', '供应商明确返回失败', '供应商在流中明确声明本次响应失败。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_REQUEST_TOO_LARGE: terminalProviderRecipe('PROVIDER_REQUEST_TOO_LARGE', '请求超过安全上限', '请求尚未发送；请缩小本轮上下文或参考图。', undefined, { defaultExternalState: 'not_started' }),
  PROVIDER_HTTP_ERROR: terminalProviderRecipe('PROVIDER_HTTP_ERROR', '供应商拒绝请求', '供应商返回了不能自动恢复的 HTTP 错误。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_CONTENT_FILTERED: terminalProviderRecipe('PROVIDER_CONTENT_FILTERED', '图片未通过内容审核', '图片服务拒绝了本次内容，没有返回图片。请检查创作内容和参考图。', ['ask_user', 'stop'], { defaultExternalState: 'known_failed', defaultRetryClass: 'user_action_required' }),
  PROVIDER_UPSTREAM_ERROR: terminalProviderRecipe('PROVIDER_UPSTREAM_ERROR', '供应商暂时不可用', '供应商返回了服务端错误；POST 不会自动重复提交。', undefined, { defaultExternalState: 'known_failed' }),
  PROVIDER_DESTINATION_DENIED: terminalProviderRecipe('PROVIDER_DESTINATION_DENIED', '请求目标被拒绝', '请求地址不在已保存供应商范围内。', undefined, { defaultExternalState: 'not_started' }),
  PROVIDER_RESPONSE_TOO_LARGE: terminalProviderRecipe('PROVIDER_RESPONSE_TOO_LARGE', '响应超过安全上限', '为保护本地资源，应用已停止读取过大的响应。'),
  TOOL_NOT_FOUND: modelRecipe('TOOL_NOT_FOUND', { category: 'scope', defaultExternalState: 'not_started' }),
  TOOL_NOT_AVAILABLE: modelRecipe('TOOL_NOT_AVAILABLE', { category: 'scope', defaultExternalState: 'not_started' }),
  TOOL_READ_TRANSIENT: recipe('TOOL_READ_TRANSIENT', {
    phase: 'tool', category: 'local_execution', defaultRetryClass: 'local_retry', defaultExternalState: 'not_started',
    publicTitle: '读取作品状态暂时受阻', publicExplanation: '读取型本地工具遇到可识别的瞬时错误，可以在原操作内有界重试。',
    repairInstruction: null, replacementScope: 'single_tool', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['retry_read', 'ask_user', 'stop'], prohibitedRepairs: ['不得把读取重试扩大为写入或模型请求'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 2
  }),
  TOOL_READ_RETRY_EXHAUSTED: recipe('TOOL_READ_RETRY_EXHAUSTED', {
    phase: 'tool', category: 'local_execution', defaultRetryClass: 'terminal', defaultExternalState: 'known_failed',
    publicTitle: '读取作品状态仍未恢复', publicExplanation: '两次本地读取重试仍未成功，应用已停止。',
    repairInstruction: null, replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['ask_user', 'stop'], prohibitedRepairs: ['不得继续无限重试', '不得创建模型请求'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  TOOL_IDEMPOTENCY_CONFLICT: recipe('TOOL_IDEMPOTENCY_CONFLICT', {
    phase: 'commit', category: 'local_execution', defaultRetryClass: 'terminal', defaultExternalState: 'known_failed',
    publicTitle: '操作身份冲突', publicExplanation: '同一操作身份对应了不同参数，应用已停止。', repairInstruction: null,
    replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false, allowedActions: STOP_ONLY,
    prohibitedRepairs: ['不得生成新身份以绕过冲突'], maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  TOOL_SCOPE_DENIED: permissionRecipe('TOOL_SCOPE_DENIED', '操作超出本轮范围'),
  TOOL_PERMISSION_DENIED: permissionRecipe('TOOL_PERMISSION_DENIED', '当前权限不允许这项操作'),
  TOOL_APPROVAL_REQUIRED: permissionRecipe('TOOL_APPROVAL_REQUIRED', '需要你的确认'),
  SCENE_REVISION_STALE: recipe('SCENE_REVISION_STALE', {
    phase: 'preview', category: 'revision', defaultRetryClass: 'refresh_then_replan', defaultExternalState: 'not_started',
    publicTitle: '画布已发生变化', publicExplanation: '方案基于旧画布版本，应用将刷新后只规划未执行部分。',
    repairInstruction: '刷新当前 Scene，只替换失败和未开始的步骤。', replacementScope: 'remaining_plan',
    includeAllowedToolSchemas: true, refreshSceneBeforeRepair: true, allowedActions: ['refresh_and_replan', 'ask_user', 'stop'],
    prohibitedRepairs: ['不得重放已提交工具'], maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 1
  }),
  SCENE_ELEMENT_LOCKED: permissionRecipe('SCENE_ELEMENT_LOCKED', '元素已锁定'),
  SCENE_ELEMENT_PROTECTED: permissionRecipe('SCENE_ELEMENT_PROTECTED', '元素受保护'),
  TOOL_PREVIEW_FAILED: modelRecipe('TOOL_PREVIEW_FAILED', { category: 'schema', defaultExternalState: 'not_started' }),
  TOOL_COMMIT_FAILED: recipe('TOOL_COMMIT_FAILED', {
    phase: 'commit', category: 'local_execution', defaultRetryClass: 'terminal', defaultExternalState: 'known_failed',
    publicTitle: '画布提交失败', publicExplanation: '原子写入没有完成；应用不会猜测或重放。', repairInstruction: null,
    replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false, allowedActions: ['ask_user', 'stop'],
    prohibitedRepairs: ['不得自动重放写入'], maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  EXTERNAL_POST_STATE_UNKNOWN: recipe('EXTERNAL_POST_STATE_UNKNOWN', {
    phase: 'provider', category: 'external_state', defaultRetryClass: 'query_only', defaultExternalState: 'unknown',
    publicTitle: '远端提交状态未知', publicExplanation: '无法确认远端是否已接受请求；应用不会创建第二个 POST。',
    repairInstruction: null, replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['query_remote', 'ask_user', 'stop'], prohibitedRepairs: ['不得重新提交外部 POST'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  EXTERNAL_POST_NOT_STARTED: recipe('EXTERNAL_POST_NOT_STARTED', {
    phase: 'provider', category: 'external_state', defaultRetryClass: 'user_action_required', defaultExternalState: 'not_started',
    publicTitle: '远端请求尚未发送', publicExplanation: '预检在发送前停止；用户可以修正设置或要求后创建一项新请求。',
    repairInstruction: null, replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['open_settings', 'ask_user', 'stop'], prohibitedRepairs: ['不得绕过预检或预算'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  EXTERNAL_POST_KNOWN_FAILED: terminalProviderRecipe(
    'EXTERNAL_POST_KNOWN_FAILED',
    '远端明确拒绝请求',
    '供应商已明确返回失败；应用不会在后台创建第二个 POST。',
    ['open_settings', 'ask_user', 'stop'],
    { category: 'external_state', defaultExternalState: 'known_failed' }
  ),
  EXTERNAL_RESULT_INVALID: terminalProviderRecipe(
    'EXTERNAL_RESULT_INVALID',
    '远端结果无法使用',
    '远端任务已完成，但结果没有通过本地合同或安全校验。',
    ['ask_user', 'stop'],
    { category: 'external_state', defaultExternalState: 'completed' }
  ),
  EXTERNAL_JOB_QUERY_AVAILABLE: recipe('EXTERNAL_JOB_QUERY_AVAILABLE', {
    phase: 'provider', category: 'external_state', defaultRetryClass: 'query_only', defaultExternalState: 'unknown',
    publicTitle: '可以核对原图片任务', publicExplanation: '已有图片 Job ID；应用只会查询原任务，不会重新提交生成 POST。',
    repairInstruction: null, replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
    allowedActions: ['query_remote', 'ask_user', 'stop'], prohibitedRepairs: ['不得创建新的图片 POST', '不得切换模型或供应商'],
    maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
  }),
  BUDGET_MODEL_TURNS: budgetRecipe('BUDGET_MODEL_TURNS', '模型回合预算已用尽'),
  BUDGET_TOOL_CALLS: budgetRecipe('BUDGET_TOOL_CALLS', '工具次数预算已用尽'),
  BUDGET_SCENE_WRITES: budgetRecipe('BUDGET_SCENE_WRITES', '画布写入预算已用尽'),
  BUDGET_GENERATION_JOBS: budgetRecipe('BUDGET_GENERATION_JOBS', '图片任务预算已用尽'),
  BUDGET_GENERATED_IMAGES: budgetRecipe('BUDGET_GENERATED_IMAGES', '图片数量预算已用尽'),
  BUDGET_COST: budgetRecipe('BUDGET_COST', '费用预算已用尽'),
  BUDGET_WALL_TIME: budgetRecipe('BUDGET_WALL_TIME', '本轮时间预算已用尽')
})

const TERMINAL_RECIPE = recipe('UNKNOWN_AGENT_FAILURE', {
  phase: 'validation', category: 'local_execution', defaultRetryClass: 'terminal', defaultExternalState: 'known_failed',
  publicTitle: '操作未能完成', publicExplanation: '错误不属于已验证的自动恢复范围。', repairInstruction: null,
  replacementScope: 'none', includeAllowedToolSchemas: false, refreshSceneBeforeRepair: false,
  allowedActions: STOP_ONLY, prohibitedRepairs: ['不得猜测恢复步骤'], maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0
})

export function agentErrorRecipe(code: string): AgentErrorRecipe {
  return AGENT_ERROR_RECIPES[code] ?? TERMINAL_RECIPE
}

export interface AgentFailureDescriptor {
  readonly phase: FailurePhase
  readonly category: FailureCategory
  readonly retryClass: AgentFailureRetryClass
  readonly externalState: ExternalState
}

export function agentFailureDescriptor(code: string): AgentFailureDescriptor {
  const value = agentErrorRecipe(code)
  return { phase: value.phase, category: value.category, retryClass: value.defaultRetryClass, externalState: value.defaultExternalState }
}

function hash64(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0')
}

function deterministicUuid(value: string): string {
  const hex = `${hash64(value)}${hash64(`failure:${value}`)}`.slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = '8'
  const joined = hex.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

export function agentFailureFingerprint(input: {
  readonly code: string
  readonly phase: FailurePhase
  readonly toolName?: string | null
  readonly schemaIssues?: readonly { readonly path: string; readonly expected: string }[]
}): string {
  const issues = [...(input.schemaIssues ?? [])].map((issue) => `${issue.path.trim()}:${issue.expected.trim()}`).sort().join('|')
  return `${hash64(`${input.code}|${input.phase}|${input.toolName ?? ''}|${issues}`)}${hash64(issues)}`
}

export function normalizeAgentFailureEnvelope(value: AgentFailureEnvelope): AgentFailureEnvelopeV2 {
  if (value.schemaVersion === 2) return value
  const recipeValue = agentErrorRecipe(value.code)
  const fingerprint = agentFailureFingerprint(value)
  const legacyKey = JSON.stringify({ code: value.code, phase: value.phase, toolName: value.toolName, schemaIssues: value.schemaIssues, attempt: value.attempt })
  return agentFailureEnvelopeV2Schema.parse({
    schemaVersion: 2,
    failureId: deterministicUuid(legacyKey), parentFailureId: null, requestCorrelationId: null, providerAttemptId: null, fingerprint,
    code: value.code, phase: value.phase, category: value.category, retryClass: value.retryClass, externalState: value.externalState,
    toolName: value.toolName, safeMessage: value.safeMessage,
    schemaIssues: value.schemaIssues.map((issue) => ({ issueCode: 'LEGACY_UNATTRIBUTED', ...issue })),
    expectedSceneRevision: value.expectedSceneRevision, currentSceneRevision: value.currentSceneRevision,
    affectedElementIds: value.affectedElementIds, repairRecipeId: null, repairFacts: [],
    prohibitedRepairs: [...recipeValue.prohibitedRepairs], replacementScope: 'none',
    completedToolIndexes: [], failedToolIndex: null, unstartedToolIndexes: [],
    attempt: value.attempt, maxAttempts: value.maxAttempts,
    remainingModelTurns: 0, remainingRecoveryAttempts: 0, remainingWallTimeMs: 0, remainingCostCny: null,
    allowedActions: value.retryClass === 'query_only' ? ['query_remote', 'ask_user', 'stop'] : ['ask_user', 'stop'],
    createdAt: new Date(0).toISOString()
  })
}

export function isAutomaticAgentRecovery(retryClass: AgentFailureRetryClass): boolean {
  return retryClass === 'model_can_repair' || retryClass === 'refresh_then_replan' || retryClass === 'local_retry'
}
