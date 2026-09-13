import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { AgentActivityKind, AgentActivityState, AgentRunStatus } from '../../shared/agent'
import type {
  AgentGoalStatus,
  AgentItemStatus,
  AgentItemType,
  AgentMode,
  AgentQueueStatus,
  AgentThreadStatus,
  AgentTurnStatus,
  DispatchMode,
  TaskRelation,
  TemporaryTryState,
  TurnInputMode
} from '../../shared/agent-harness'
import type { AgentToolRisk } from '../../shared/agent-tools'
import type {
  GenerationBudgetReservation,
  GenerationSubscription,
  GenerationWorkflowIntentStatus,
  GenerationWorkflowOperation
} from '../../shared/generation-workflow'
import type {
  ContextDisposition,
  ContextSourceType,
  OutboundContextPolicy,
  OutboundContextStatus,
  ProjectDirectiveCategory,
  ProjectMemoryKind,
  ProjectMemorySourceType,
  ProjectMemoryStatus
} from '../../shared/agent-context'
import { runMigrations, type MigrationResult } from './migrations'

export interface ProjectRow {
  id: string
  name: string
  project_path: string
  schema_version: number
  created_at: string
  updated_at: string
  last_opened_at: string
  clean_shutdown: number
}

export interface SceneSnapshotRow {
  id: string
  project_id: string
  scene_revision: number
  scene_json: string
  reason: 'initial' | 'explicit' | 'autosave' | 'recovery' | 'undo' | 'redo'
  created_at: string
}

export interface OperationBatchRow {
  id: string
  project_id: string
  origin: 'user' | 'agent' | 'system'
  summary: string
  revision_before: number
  revision_after: number
  patches_json: string
  inverse_patches_json: string
  committed_at: string
}

export interface AssetRow {
  id: string
  project_id: string
  relative_path: string
  thumbnail_relative_path: string
  content_hash: string
  width: number
  height: number
  format: 'png' | 'jpeg' | 'webp'
  has_alpha: number
  source_type: 'imported' | 'generated' | 'reference'
  source_id: string | null
  status: 'available' | 'missing'
  created_at: string
}

export type GenerationJobStatus =
  | 'queued'
  | 'preparing'
  | 'generating'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'

export interface GenerationJobRow {
  id: string
  copied_from_project_id: string | null
  cost_json: string | null
  execution_identity_id: string | null
  effective_timeout_ms: number | null
  submission_state: 'not_sent' | 'may_have_sent' | 'accepted' | null
  project_id: string
  provider_id: string
  model: string
  request_json: string
  status: GenerationJobStatus
  stage: string
  external_task_id: string | null
  attempt: number
  parent_job_id: string | null
  source_message_id: string | null
  cancel_requested: number
  error_code: string | null
  error_message: string | null
  error_stage: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

export interface GenerationResultRow {
  id: string
  job_id: string
  project_id: string
  asset_id: string
  variant_index: number
  parent_result_id: string | null
  favorite: number
  reference_deleted: number
  created_at: string
}

export interface ConversationRow {
  id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationMessageRow {
  id: string
  conversation_id: string
  project_id: string
  role: 'user' | 'assistant'
  kind: 'text' | 'receipt' | 'error'
  content: string
  receipt_json: string | null
  attachments_json: string
  run_id: string | null
  created_at: string
}

export interface AgentRunRow {
  id: string
  conversation_id: string
  project_id: string
  user_message_id: string
  request_json: string
  plan_json: string | null
  status: AgentRunStatus
  auto_generate: number
  confirmation_required: number
  max_steps: number
  step_count: number
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

export interface AgentToolCallRow {
  id: string
  run_id: string
  ordinal: number
  tool_name: string
  status: 'planned' | 'completed' | 'failed' | 'cancelled'
  arguments_json: string
  result_json: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export interface AgentActivityRow {
  id: string
  project_id: string
  run_id: string | null
  ordinal: number | null
  kind: AgentActivityKind
  event_type: string
  label: string
  state: AgentActivityState
  progress: number | null
  object_label: string
  action_label: string
  impact_label: string
  scope_label: string | null
  affected_ids_json: string
  operation_batch_id: string | null
  job_id: string | null
  budget_impact_json: string | null
  recoverable: number
  undone_at: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

export interface AgentActivityEventRow {
  id: string
  activity_id: string
  event_type: string
  state: AgentActivityState
  summary: string
  created_at: string
}

export interface AgentDecisionRow {
  id: string
  project_id: string
  run_id: string
  activity_id: string
  kind: 'aspect_ratio' | 'generation_confirmation' | 'budget_alternative'
  title: string
  consequence: string
  options_json: string
  default_option_id: string
  status: 'waiting' | 'resolved' | 'cancelled'
  selected_option_id: string | null
  created_at: string
  resolved_at: string | null
}

export interface AgentThreadRow {
  id: string
  project_id: string
  title: string
  status: AgentThreadStatus
  active_goal_id: string | null
  active_turn_id: string | null
  last_sequence: number
  created_at: string
  updated_at: string
}

export interface AgentGoalRow {
  id: string
  thread_id: string
  objective: string
  completion_definition_json: string
  mode: AgentMode
  scope_json: string
  permission_profile_id: string | null
  budget_json: string
  prohibitions_json: string
  status: AgentGoalStatus
  version: number
  created_at: string
  updated_at: string
}

export interface AgentTurnV2Row {
  id: string
  thread_id: string
  goal_id: string | null
  input_message_id: string | null
  task_id: string | null
  task_relation: TaskRelation | null
  dispatch_mode: DispatchMode | null
  base_task_id: string | null
  temporary_state: TemporaryTryState | null
  status: AgentTurnStatus
  scene_revision_at_start: number
  context_manifest_id: string | null
  write_lease_id: string | null
  model_turns_used: number
  tool_calls_used: number
  scene_write_batches_used: number
  recovery_attempts_used: number
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface AgentItemRow {
  id: string
  thread_id: string
  turn_id: string
  type: AgentItemType
  status: AgentItemStatus
  ordinal: number
  payload_version: number
  payload_json: string
  created_at: string
  updated_at: string
}

export interface AgentEventRow {
  id: string
  project_id: string
  thread_id: string
  turn_id: string | null
  item_id: string | null
  sequence: number
  type: string
  payload_version: number
  payload_json: string
  created_at: string
}

export interface AgentQueueEntryRow {
  id: string
  thread_id: string
  message_id: string
  mode: TurnInputMode
  task_id: string | null
  task_relation: TaskRelation | null
  dispatch_mode: DispatchMode | null
  base_task_id: string | null
  position: number
  status: AgentQueueStatus
  created_at: string
  updated_at: string
}

export type AgentToolCallV2Status = 'prepared' | 'committing' | 'completed' | 'failed' | 'cancelled' | 'expired'

export interface AgentToolCallV2Row {
  id: string
  project_id: string
  thread_id: string | null
  turn_id: string | null
  legacy_run_id: string | null
  ordinal: number
  tool_name: string
  definition_version: number
  risk: AgentToolRisk
  status: AgentToolCallV2Status
  idempotency_key: string
  expected_scene_revision: number | null
  scope_json: string
  arguments_json: string
  permission_json: string
  approval_json: string
  preview_json: string | null
  execution_token_hash: string | null
  renderer_session_hash: string | null
  token_expires_at: string | null
  operation_batch_id: string | null
  scene_revision_after: number | null
  result_json: string | null
  error_code: string | null
  error_message: string | null
  recoverable: number
  created_at: string
  prepared_at: string | null
  committed_at: string | null
  completed_at: string | null
  updated_at: string
}

export interface AgentProjectContextSettingsRow {
  project_id: string
  outbound_policy: OutboundContextPolicy
  version: number
  created_at: string
  updated_at: string
}

export interface ProjectDirectiveRow {
  id: string
  project_id: string
  text: string
  category: ProjectDirectiveCategory
  priority: number
  enabled: number
  source_message_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface ProjectMemoryEntryRow {
  id: string
  project_id: string
  kind: ProjectMemoryKind
  content: string
  source_type: ProjectMemorySourceType
  source_id: string
  confidence: number
  status: ProjectMemoryStatus
  version: number
  supersedes_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectMemoryCandidateRow {
  id: string
  project_id: string
  kind: ProjectMemoryKind
  content: string
  source_type: 'turn' | 'planner' | 'migration'
  source_id: string
  confidence: number
  status: 'pending' | 'confirmed' | 'rejected'
  confirmed_memory_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface AgentContextManifestRow {
  id: string
  project_id: string
  thread_id: string
  turn_id: string
  scene_revision: number
  outbound_policy: OutboundContextPolicy
  estimated_text_bytes: number
  image_count: number
  source_hash: string
  created_at: string
}

export interface AgentContextEntryRow {
  id: string
  manifest_id: string
  ordinal: number
  source_type: ContextSourceType
  source_id: string
  source_version: number | null
  scope: string
  disposition: ContextDisposition
  reason: string
  content_json: string
  estimated_bytes: number
  created_at: string
}

export interface AgentContextCompactionRow {
  id: string
  project_id: string
  thread_id: string
  source_sequence_from: number
  source_sequence_to: number
  source_hash: string
  summary: string
  version: number
  created_at: string
}

export interface AgentOutboundContextRecordRow {
  id: string
  project_id: string
  thread_id: string
  turn_id: string
  manifest_id: string
  tool_call_id: string | null
  provider_id: string | null
  model: string | null
  policy: OutboundContextPolicy
  data_types_json: string
  image_asset_ids_json: string
  text_bytes: number
  image_count: number
  image_bytes: number | null
  approval_id: string | null
  request_correlation_id: string | null
  status: OutboundContextStatus
  reason: string
  created_at: string
  updated_at: string
}

export interface GenerationWorkflowIntentRow {
  id: string
  project_id: string
  thread_id: string | null
  turn_id: string | null
  tool_call_item_id: string | null
  source_message_id: string | null
  spec_json: string
  compiled_request_json: string
  prompt_package_json: string | null
  source_hash: string
  idempotency_key: string
  status: GenerationWorkflowIntentStatus
  job_id: string | null
  dispatch_attempts: number
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  dispatched_at: string | null
  completed_at: string | null
}

export interface AgentBudgetReservationRow {
  id: string
  project_id: string
  turn_id: string | null
  intent_id: string
  request_limit: number
  image_limit: number
  cost_limit_cny: number
  actual_requests: number
  actual_images: number
  actual_cost_cny: number
  status: GenerationBudgetReservation['status']
  created_at: string
  updated_at: string
}

export interface GenerationSubscriptionRow {
  id: string
  project_id: string
  thread_id: string
  turn_id: string
  intent_id: string
  job_id: string
  status: GenerationSubscription['status']
  last_job_status: GenerationJobStatus
  created_at: string
  updated_at: string
  observed_at: string | null
}

export interface GenerationResultRecordRow {
  result_id: string
  intent_id: string
  prompt_package_hash: string | null
  prompt_package_json: string | null
  source_scene_revision: number | null
  profile_id: string
  provider_id: string
  model: string
  operation: GenerationWorkflowOperation
  actual_cost_cny: number
  created_at: string
}

export interface ProjectDatabase {
  projects: ProjectRow
  scene_snapshots: SceneSnapshotRow
  operation_batches: OperationBatchRow
  assets: AssetRow
  generation_jobs: GenerationJobRow
  generation_results: GenerationResultRow
  conversations: ConversationRow
  conversation_messages: ConversationMessageRow
  agent_runs: AgentRunRow
  agent_tool_calls: AgentToolCallRow
  agent_activities: AgentActivityRow
  agent_activity_events: AgentActivityEventRow
  agent_decisions: AgentDecisionRow
  agent_threads: AgentThreadRow
  agent_goals: AgentGoalRow
  agent_turns_v2: AgentTurnV2Row
  agent_items: AgentItemRow
  agent_events: AgentEventRow
  agent_queue_entries: AgentQueueEntryRow
  agent_tool_calls_v2: AgentToolCallV2Row
  agent_project_context_settings: AgentProjectContextSettingsRow
  project_directives: ProjectDirectiveRow
  project_memory_entries: ProjectMemoryEntryRow
  project_memory_candidates: ProjectMemoryCandidateRow
  agent_context_manifests: AgentContextManifestRow
  agent_context_entries: AgentContextEntryRow
  agent_context_compactions: AgentContextCompactionRow
  agent_outbound_context_records: AgentOutboundContextRecordRow
  generation_workflow_intents: GenerationWorkflowIntentRow
  agent_budget_reservations: AgentBudgetReservationRow
  generation_subscriptions: GenerationSubscriptionRow
  generation_result_records: GenerationResultRecordRow
}

export interface DatabaseConnection {
  readonly sqlite: Database.Database
  readonly kysely: Kysely<ProjectDatabase>
  readonly migration: MigrationResult
}

/** Execute a typed query without yielding while a SQLite write transaction is
 * held. Another repository uses a separate connection on the same JS thread;
 * awaiting between writes would let its synchronous writer block our commit. */
export function executeSynchronous(connection: DatabaseConnection, query: { compile(): { sql: string; parameters: readonly unknown[] } }): void {
  const compiled = query.compile()
  connection.sqlite.prepare(compiled.sql).run(...compiled.parameters)
}

export function openDatabase(databasePath: string): DatabaseConnection {
  const migration = runMigrations(databasePath)
  const sqlite = new Database(databasePath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  const kysely = new Kysely<ProjectDatabase>({ dialect: new SqliteDialect({ database: sqlite }) })
  return { sqlite, kysely, migration }
}
