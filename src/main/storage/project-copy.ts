import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { deserializeSceneSnapshot, sceneSchema, serializeSceneSnapshot } from '../../domain'
import { operationBatchSchema } from '../../shared/scene-authority'
import { projectWorkContextSchema } from '../../shared/project-work-context'
import { agentRequestSchema } from '../../shared/agent'

// A single-project database is copied in place. Keeping rowids is essential:
// snapshots and committed operations are replayed in insertion order.
const PROJECT_TABLES = [
  'scene_snapshots', 'operation_batches', 'assets', 'generation_jobs', 'generation_results',
  'conversations', 'conversation_messages', 'agent_runs', 'agent_activities', 'agent_decisions',
  'agent_threads', 'agent_events', 'agent_tool_calls_v2', 'agent_project_context_settings',
  'project_directives', 'project_memory_entries', 'project_memory_candidates', 'agent_context_manifests',
  'agent_context_compactions', 'agent_outbound_context_records', 'generation_workflow_intents',
  'agent_budget_reservations', 'generation_subscriptions', 'agent_generation_limits', 'project_work_context',
  'project_copy_records'
] as const

const ENVELOPES = [
  ['agent_runs', 'request_json'], ['agent_runs', 'plan_json'],
  ['agent_tool_calls', 'arguments_json'], ['agent_tool_calls', 'result_json'],
  ['conversation_messages', 'receipt_json'], ['agent_items', 'payload_json'], ['agent_events', 'payload_json'],
  ['agent_tool_calls_v2', 'arguments_json'], ['agent_tool_calls_v2', 'preview_json'], ['agent_tool_calls_v2', 'result_json'],
  ['agent_context_entries', 'content_json']
] as const

const deniedApproval = { effect: 'deny', source: 'hard_policy', code: 'PROJECT_COPY_AUTHORITY_EXPIRED',
  explanation: '副本保留原执行记录；原项目的一次性执行批准不适用于此作品。' }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rewriteSceneValues(value: unknown, sourceId: string, destinationId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteSceneValues(item, sourceId, destinationId))
  if (!object(value)) return value
  // Only a complete, validated Scene is an identity-bearing nested document.
  // User text and arbitrary objects with a field named projectId are untouched.
  if (value.projectId === sourceId && value.canvas !== undefined && value.elements !== undefined && value.schemaVersion !== undefined) {
    const parsed = sceneSchema.safeParse(value)
    if (parsed.success) return { ...value, projectId: destinationId }
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, rewriteSceneValues(nested, sourceId, destinationId)]))
}

function rewritePatches(json: string, sourceId: string, destinationId: string): string {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('副本历史包含无法读取的操作补丁。')
  return JSON.stringify(parsed.map((patch: unknown) => {
    if (!object(patch) || !Array.isArray(patch.path)) throw new Error('副本历史包含无效操作路径。')
    if (patch.path.length === 1 && patch.path[0] === 'projectId' && patch.value === sourceId) return { ...patch, value: destinationId }
    return { ...patch, ...('value' in patch ? { value: rewriteSceneValues(patch.value, sourceId, destinationId) } : {}) }
  }))
}

export interface ProjectCopyManifest {
  readonly version: 1
  readonly sourceProjectId: string
  readonly projectId: string
  readonly copiedAt: string
  readonly disposition: string
  readonly sourceJobs: readonly unknown[]
  readonly sourceTurns: readonly unknown[]
  readonly sourceReservations: readonly unknown[]
  readonly sourceTurnLimits: readonly unknown[]
  readonly sourceApprovals: readonly unknown[]
}

export function reidentifyProjectCopy(database: Database.Database, destinationId: string, destinationPath: string,
  destinationName: string, copiedAt: string): ProjectCopyManifest {
  const projects = database.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
  if (projects.length !== 1) throw new Error('另存为要求一个可独立识别的源项目。')
  const sourceId = projects[0]!.id
  if (sourceId === destinationId) throw new Error('副本必须使用新的项目身份。')
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  const discovered = tables.filter(({ name }) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('项目包含未识别的数据库表名。')
    return (database.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).some((column) => column.name === 'project_id')
  }).map(({ name }) => name).sort()
  if (JSON.stringify(discovered) !== JSON.stringify([...PROJECT_TABLES].sort())) throw new Error('项目关系超出已验证的复制范围；原项目保持可用。')
  for (const table of PROJECT_TABLES) {
    const foreign = database.prepare(`SELECT 1 FROM ${table} WHERE project_id != ? LIMIT 1`).get(sourceId)
    if (foreign !== undefined) throw new Error(`项目关系不一致：${table}`)
  }
  const manifest: ProjectCopyManifest = {
    version: 1, sourceProjectId: sourceId, projectId: destinationId, copiedAt,
    disposition: '独立作品：原记录的金额与远端状态仅为来源事实；副本不继承执行或扣费批准，也不表示原远端任务被取消或退款。',
    sourceJobs: database.prepare('SELECT id, status, external_task_id, submission_state, error_code, cost_json FROM generation_jobs').all(),
    sourceTurns: database.prepare('SELECT id, status, temporary_state FROM agent_turns_v2').all(),
    sourceReservations: database.prepare('SELECT id, intent_id, status, request_limit, image_limit, cost_limit_cny, actual_requests, actual_images, actual_cost_cny FROM agent_budget_reservations').all(),
    sourceTurnLimits: database.prepare('SELECT turn_id, limits_json, grant_item_id FROM agent_generation_limits').all(),
    sourceApprovals: database.prepare('SELECT id, approval_json FROM agent_tool_calls_v2').all()
  }

  database.transaction(() => {
    database.pragma('defer_foreign_keys = ON')
    for (const row of database.prepare('SELECT id, scene_json FROM scene_snapshots').all() as Array<{ id: string; scene_json: string }>) {
      const scene = deserializeSceneSnapshot(row.scene_json)
      if (scene.projectId !== sourceId) throw new Error('历史画布属于另一项目，无法形成完整副本。')
      database.prepare('UPDATE scene_snapshots SET scene_json = ? WHERE id = ?').run(serializeSceneSnapshot({ ...scene, projectId: destinationId }), row.id)
    }
    for (const row of database.prepare('SELECT * FROM operation_batches').all() as Array<Record<string, unknown>>) {
      const patches = rewritePatches(row.patches_json as string, sourceId, destinationId)
      const inverse = rewritePatches(row.inverse_patches_json as string, sourceId, destinationId)
      operationBatchSchema.parse({ id: row.id, origin: row.origin, summary: row.summary, committedAt: row.committed_at,
        revisionBefore: row.revision_before, revisionAfter: row.revision_after, patches: JSON.parse(patches), inversePatches: JSON.parse(inverse) })
      database.prepare('UPDATE operation_batches SET patches_json = ?, inverse_patches_json = ? WHERE id = ?').run(patches, inverse, row.id)
    }
    for (const [table, column] of ENVELOPES) {
      const rows = database.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ id: string; value: string }>
      for (const row of rows) {
        const before: unknown = JSON.parse(row.value)
        const after = rewriteSceneValues(before, sourceId, destinationId)
        if (object(after) && object(after.request) && agentRequestSchema.safeParse(after.request).success) {
          after.request = { ...after.request, autoGenerate: false, ...(after.request.projectId === sourceId ? { projectId: destinationId } : {}) }
        }
        if (table === 'agent_runs' && column === 'request_json' && object(after)) {
          after.autoGenerate = false
          if (after.projectId === sourceId) after.projectId = destinationId
        }
        if (table === 'agent_tool_calls_v2' && column === 'preview_json' && object(after)) after.approval = deniedApproval
        const serialized = JSON.stringify(after)
        if (serialized !== row.value) database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(serialized, row.id)
      }
    }
    const contextRow = database.prepare('SELECT context_json FROM project_work_context WHERE project_id = ?').get(sourceId) as { context_json: string } | undefined
    if (contextRow !== undefined) {
      const context = projectWorkContextSchema.parse(JSON.parse(contextRow.context_json))
      const latest = database.prepare('SELECT scene_json FROM scene_snapshots ORDER BY rowid DESC LIMIT 1').get() as { scene_json: string }
      const elementIds = new Set(deserializeSceneSnapshot(latest.scene_json).elements.map((element) => element.id))
      context.workspace.selectedIds = context.workspace.selectedIds.filter((id) => elementIds.has(id))
      const resultIds = new Set((database.prepare('SELECT id FROM generation_results').all() as Array<{ id: string }>).map((row) => row.id))
      for (const key of ['referenceResultId', 'focusedResultId', 'compareAId', 'compareBId'] as const) {
        const id = context.generation[key]
        if (id !== null && !resultIds.has(id)) context.generation[key] = null
      }
      if (context.generation.compareAId === null || context.generation.compareBId === null) context.generation.compareEnabled = false
      context.projectId = destinationId
      database.prepare('UPDATE project_work_context SET context_json = ? WHERE project_id = ?').run(JSON.stringify(context), sourceId)
    }
    for (const row of database.prepare('SELECT id, spec_json FROM generation_workflow_intents').all() as Array<{ id: string; spec_json: string }>) {
      const spec: unknown = JSON.parse(row.spec_json)
      if (!object(spec)) throw new Error('生成来源记录无法读取。')
      delete spec.executionIdentityId
      database.prepare('UPDATE generation_workflow_intents SET spec_json = ? WHERE id = ?').run(JSON.stringify(spec), row.id)
    }
    database.prepare("UPDATE generation_jobs SET status = 'interrupted', stage = 'interrupted', error_code = 'PROJECT_COPY_DETACHED', error_message = ?, error_stage = 'interrupted', completed_at = ?, updated_at = ? WHERE status IN ('queued','preparing','generating','downloading')")
      .run('此任务属于原作品。副本保留来源记录，可用新的生成继续创作。', copiedAt, copiedAt)
    database.prepare('UPDATE generation_jobs SET execution_identity_id = NULL, copied_from_project_id = ?').run(sourceId)
    database.prepare("UPDATE generation_workflow_intents SET status = 'cancelled', error_code = 'PROJECT_COPY_DETACHED', error_message = ?, completed_at = ?, updated_at = ? WHERE status IN ('prepared','dispatching','dispatched','waiting')")
      .run('副本不继承原项目的待执行生成。', copiedAt, copiedAt)
    database.exec("UPDATE agent_budget_reservations SET status = 'released' WHERE status = 'reserved'; DELETE FROM agent_generation_limits;")
    database.exec("UPDATE generation_subscriptions SET status = 'cancelled' WHERE status = 'waiting';")
    database.exec("UPDATE agent_runs SET auto_generate = 0, confirmation_required = 0; UPDATE agent_runs SET status = 'interrupted', error_code = 'PROJECT_COPY_DETACHED' WHERE status IN ('queued','planning','awaiting_confirmation','awaiting_execution','executing');")
    database.exec("UPDATE agent_tool_calls SET status = 'cancelled' WHERE status = 'planned'; UPDATE agent_activities SET state = 'interrupted', recoverable = 0 WHERE state IN ('queued','running','waiting'); UPDATE agent_decisions SET status = 'cancelled' WHERE status = 'waiting';")
    database.exec("UPDATE agent_threads SET active_goal_id = NULL, active_turn_id = NULL; UPDATE agent_goals SET permission_profile_id = NULL; UPDATE agent_goals SET status = 'cancelled' WHERE status IN ('active','blocked');")
    database.exec("UPDATE agent_turns_v2 SET write_lease_id = NULL; UPDATE agent_turns_v2 SET temporary_state = 'rejected' WHERE temporary_state = 'pending'; UPDATE agent_turns_v2 SET status = 'interrupted', error_code = 'PROJECT_COPY_DETACHED' WHERE status IN ('queued','building_context','planning','running','waiting_decision','waiting_job');")
    database.exec("UPDATE agent_items SET status = 'interrupted' WHERE status IN ('queued','started','waiting'); UPDATE agent_queue_entries SET status = 'cancelled' WHERE status IN ('queued','paused','claimed');")
    database.prepare("UPDATE agent_tool_calls_v2 SET execution_token_hash = NULL, renderer_session_hash = NULL, token_expires_at = NULL, permission_json = ?, approval_json = ?")
      .run(JSON.stringify({ id: 'project-copy-expired', version: 1, label: '来源执行记录', permissions: [], allowedTools: [], allowExternal: false, allowDangerous: false, maxCostCny: 0 }), JSON.stringify(deniedApproval))
    database.exec("UPDATE agent_tool_calls_v2 SET status = 'expired' WHERE status IN ('prepared','committing'); UPDATE agent_outbound_context_records SET approval_id = NULL; UPDATE agent_outbound_context_records SET status = 'cancelled' WHERE status IN ('prepared','approved');")
    for (const table of PROJECT_TABLES) database.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ?`).run(destinationId, sourceId)
    database.prepare('UPDATE projects SET id = ?, name = ?, project_path = ?, updated_at = ?, last_opened_at = ?, clean_shutdown = 1 WHERE id = ?')
      .run(destinationId, destinationName, destinationPath, copiedAt, copiedAt, sourceId)
    database.prepare('INSERT INTO project_copy_records VALUES (?, ?, ?, ?, ?)').run(randomUUID(), destinationId, sourceId, copiedAt, JSON.stringify(manifest))
    if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('副本关系验证失败，源项目未改变。')
  }).immediate()
  return manifest
}
