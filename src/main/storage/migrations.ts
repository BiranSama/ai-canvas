import Database from 'better-sqlite3'
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const LATEST_DATABASE_VERSION = 15

interface Migration {
  readonly version: number
  readonly up: (database: Database.Database) => void
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    up: (database) => {
      database.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          project_path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL,
          clean_shutdown INTEGER NOT NULL DEFAULT 1 CHECK (clean_shutdown IN (0, 1))
        );

        CREATE TABLE scene_snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scene_revision INTEGER NOT NULL,
          scene_json TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN ('initial', 'explicit', 'autosave', 'recovery', 'undo', 'redo')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX scene_snapshots_project_revision
          ON scene_snapshots(project_id, scene_revision DESC, created_at DESC);

        CREATE TABLE operation_batches (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          origin TEXT NOT NULL CHECK (origin IN ('user', 'agent', 'system')),
          summary TEXT NOT NULL,
          revision_before INTEGER NOT NULL,
          revision_after INTEGER NOT NULL,
          patches_json TEXT NOT NULL,
          inverse_patches_json TEXT NOT NULL,
          committed_at TEXT NOT NULL
        );

        CREATE TABLE assets (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          thumbnail_relative_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('png', 'jpeg', 'webp')),
          has_alpha INTEGER NOT NULL CHECK (has_alpha IN (0, 1)),
          source_type TEXT NOT NULL CHECK (source_type IN ('imported', 'generated', 'reference')),
          source_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('available', 'missing')),
          created_at TEXT NOT NULL,
          UNIQUE(project_id, content_hash)
        );
        CREATE INDEX assets_project_created ON assets(project_id, created_at DESC);
      `)
    }
  },
  {
    version: 2,
    up: (database) => {
      database.exec(`
        CREATE TABLE generation_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'generating', 'downloading', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted')),
          stage TEXT NOT NULL,
          external_task_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          parent_job_id TEXT REFERENCES generation_jobs(id),
          source_message_id TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          error_code TEXT,
          error_message TEXT,
          error_stage TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX generation_jobs_project_created
          ON generation_jobs(project_id, created_at DESC);
        CREATE INDEX generation_jobs_status_updated
          ON generation_jobs(status, updated_at);

        CREATE TABLE generation_results (
          id TEXT PRIMARY KEY NOT NULL,
          job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES assets(id),
          variant_index INTEGER NOT NULL,
          parent_result_id TEXT REFERENCES generation_results(id),
          favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
          reference_deleted INTEGER NOT NULL DEFAULT 0 CHECK (reference_deleted IN (0, 1)),
          created_at TEXT NOT NULL,
          UNIQUE(job_id, variant_index)
        );
        CREATE INDEX generation_results_project_created
          ON generation_results(project_id, created_at DESC);
      `)
    }
  },
  {
    version: 3,
    up: (database) => {
      database.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id)
        );

        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          kind TEXT NOT NULL CHECK (kind IN ('text', 'receipt', 'error')),
          content TEXT NOT NULL,
          receipt_json TEXT,
          attachments_json TEXT NOT NULL,
          run_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX conversation_messages_conversation_created
          ON conversation_messages(conversation_id, created_at, id);

        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
          request_json TEXT NOT NULL,
          plan_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('queued', 'planning', 'awaiting_confirmation', 'awaiting_execution', 'executing', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted')),
          auto_generate INTEGER NOT NULL CHECK (auto_generate IN (0, 1)),
          confirmation_required INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_required IN (0, 1)),
          max_steps INTEGER NOT NULL,
          step_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX agent_runs_project_created ON agent_runs(project_id, created_at DESC);
        CREATE INDEX agent_runs_status_updated ON agent_runs(status, updated_at);

        CREATE TABLE agent_tool_calls (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'failed', 'cancelled')),
          arguments_json TEXT NOT NULL,
          result_json TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(run_id, ordinal)
        );
      `)
    }
  },
  {
    version: 4,
    up: (database) => {
      database.exec(`
        CREATE TABLE agent_activities (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
          ordinal INTEGER,
          kind TEXT NOT NULL CHECK (kind IN ('plan', 'tool', 'generation', 'decision', 'receipt', 'recovery')),
          event_type TEXT NOT NULL,
          label TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted')),
          progress REAL,
          object_label TEXT NOT NULL,
          action_label TEXT NOT NULL,
          impact_label TEXT NOT NULL,
          scope_label TEXT,
          affected_ids_json TEXT NOT NULL DEFAULT '[]',
          operation_batch_id TEXT,
          job_id TEXT,
          budget_impact_json TEXT,
          recoverable INTEGER NOT NULL DEFAULT 0 CHECK (recoverable IN (0, 1)),
          undone_at TEXT,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, kind, ordinal)
        );
        CREATE INDEX agent_activities_project_created
          ON agent_activities(project_id, created_at, id);
        CREATE UNIQUE INDEX agent_activities_generation_job
          ON agent_activities(job_id) WHERE job_id IS NOT NULL AND kind = 'generation';

        CREATE TABLE agent_activity_events (
          id TEXT PRIMARY KEY NOT NULL,
          activity_id TEXT NOT NULL REFERENCES agent_activities(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted')),
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX agent_activity_events_activity_created
          ON agent_activity_events(activity_id, created_at, id);

        CREATE TABLE agent_decisions (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL UNIQUE REFERENCES agent_activities(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('aspect_ratio', 'generation_confirmation', 'budget_alternative')),
          title TEXT NOT NULL,
          consequence TEXT NOT NULL,
          options_json TEXT NOT NULL,
          default_option_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('waiting', 'resolved', 'cancelled')),
          selected_option_id TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `)
    }
  },
  {
    version: 5,
    up: (database) => {
      database.exec(`
        CREATE TABLE agent_threads (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          active_goal_id TEXT,
          active_turn_id TEXT,
          last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id)
        );

        CREATE TABLE agent_goals (
          id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          objective TEXT NOT NULL,
          completion_definition_json TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('review', 'collaboration', 'auto')),
          scope_json TEXT NOT NULL,
          permission_profile_id TEXT,
          budget_json TEXT NOT NULL,
          prohibitions_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'blocked', 'cancelled')),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX agent_goals_thread_updated ON agent_goals(thread_id, updated_at DESC, id);

        CREATE TABLE agent_turns_v2 (
          id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          goal_id TEXT REFERENCES agent_goals(id),
          input_message_id TEXT,
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job',
            'interrupted', 'completed', 'completed_with_notes', 'needs_user_review', 'blocked',
            'budget_limited', 'usage_limited', 'failed', 'cancelled'
          )),
          scene_revision_at_start INTEGER NOT NULL CHECK (scene_revision_at_start >= 0),
          context_manifest_id TEXT,
          write_lease_id TEXT,
          model_turns_used INTEGER NOT NULL DEFAULT 0 CHECK (model_turns_used >= 0),
          tool_calls_used INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls_used >= 0),
          scene_write_batches_used INTEGER NOT NULL DEFAULT 0 CHECK (scene_write_batches_used >= 0),
          recovery_attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts_used >= 0),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX agent_turns_v2_thread_created ON agent_turns_v2(thread_id, created_at DESC, id);
        CREATE UNIQUE INDEX agent_turns_v2_one_active
          ON agent_turns_v2(thread_id)
          WHERE status IN ('queued', 'building_context', 'planning', 'running', 'waiting_decision', 'waiting_job');

        CREATE TABLE agent_items (
          id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL REFERENCES agent_turns_v2(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN (
            'user_message', 'assistant_message', 'plan', 'decision', 'tool_call', 'tool_result',
            'scene_change', 'generation_subscription', 'completion_assessment', 'context_compaction', 'recovery'
          )),
          status TEXT NOT NULL CHECK (status IN ('queued', 'started', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted')),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(turn_id, ordinal)
        );

        CREATE TABLE agent_events (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          turn_id TEXT REFERENCES agent_turns_v2(id) ON DELETE CASCADE,
          item_id TEXT REFERENCES agent_items(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          type TEXT NOT NULL,
          payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(thread_id, sequence)
        );
        CREATE INDEX agent_events_thread_sequence ON agent_events(thread_id, sequence);

        CREATE TABLE agent_queue_entries (
          id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('correct_current', 'append_current', 'queue_next', 'interrupt_now')),
          position INTEGER NOT NULL CHECK (position >= 0),
          status TEXT NOT NULL CHECK (status IN ('queued', 'paused', 'claimed', 'completed', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(thread_id, position)
        );
        CREATE INDEX agent_queue_entries_thread_status_position
          ON agent_queue_entries(thread_id, status, position);
      `)
    }
  },
  {
    version: 6,
    up: (database) => {
      database.exec(`
        CREATE TABLE agent_tool_calls_v2 (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
          turn_id TEXT REFERENCES agent_turns_v2(id) ON DELETE SET NULL,
          legacy_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          tool_name TEXT NOT NULL,
          definition_version INTEGER NOT NULL CHECK (definition_version > 0),
          risk TEXT NOT NULL CHECK (risk IN ('read', 'local_reversible', 'persistent_reversible', 'external', 'dangerous')),
          status TEXT NOT NULL CHECK (status IN (
            'prepared', 'committing', 'completed', 'failed', 'cancelled', 'expired'
          )),
          idempotency_key TEXT NOT NULL,
          expected_scene_revision INTEGER CHECK (expected_scene_revision >= 0),
          scope_json TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          permission_json TEXT NOT NULL,
          approval_json TEXT NOT NULL,
          preview_json TEXT,
          execution_token_hash TEXT,
          renderer_session_hash TEXT,
          token_expires_at TEXT,
          operation_batch_id TEXT,
          scene_revision_after INTEGER CHECK (scene_revision_after >= 0),
          result_json TEXT,
          error_code TEXT,
          error_message TEXT,
          recoverable INTEGER NOT NULL DEFAULT 0 CHECK (recoverable IN (0, 1)),
          created_at TEXT NOT NULL,
          prepared_at TEXT,
          committed_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, idempotency_key),
          UNIQUE(legacy_run_id, ordinal)
        );
        CREATE INDEX agent_tool_calls_v2_project_created
          ON agent_tool_calls_v2(project_id, created_at DESC, id);
        CREATE INDEX agent_tool_calls_v2_status_updated
          ON agent_tool_calls_v2(status, updated_at);
        CREATE UNIQUE INDEX agent_tool_calls_v2_active_token
          ON agent_tool_calls_v2(execution_token_hash)
          WHERE execution_token_hash IS NOT NULL;
      `)
    }
  },
  {
    version: 7,
    up: (database) => {
      database.exec(`
        CREATE TABLE agent_project_context_settings (
          project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          outbound_policy TEXT NOT NULL DEFAULT 'minimal' CHECK (outbound_policy IN (
            'minimal', 'review_each_image', 'local_only', 'custom'
          )),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE project_directives (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('creative', 'content', 'workflow', 'privacy')),
          priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 1000),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          source_message_id TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX project_directives_project_priority
          ON project_directives(project_id, enabled DESC, priority DESC, updated_at DESC, id);

        CREATE TABLE project_memory_entries (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'choice', 'direction', 'constraint')),
          content TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('user', 'turn', 'candidate', 'migration')),
          source_id TEXT NOT NULL,
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'expired', 'deleted')),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          supersedes_id TEXT REFERENCES project_memory_entries(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX project_memory_entries_project_status
          ON project_memory_entries(project_id, status, updated_at DESC, id);

        CREATE TABLE project_memory_candidates (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'choice', 'direction', 'constraint')),
          content TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('turn', 'planner', 'migration')),
          source_id TEXT NOT NULL,
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
          confirmed_memory_id TEXT REFERENCES project_memory_entries(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX project_memory_candidates_project_status
          ON project_memory_candidates(project_id, status, updated_at DESC, id);

        CREATE TABLE agent_context_manifests (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL REFERENCES agent_turns_v2(id) ON DELETE CASCADE,
          scene_revision INTEGER NOT NULL CHECK (scene_revision >= 0),
          outbound_policy TEXT NOT NULL CHECK (outbound_policy IN (
            'minimal', 'review_each_image', 'local_only', 'custom'
          )),
          estimated_text_bytes INTEGER NOT NULL CHECK (estimated_text_bytes >= 0),
          image_count INTEGER NOT NULL CHECK (image_count >= 0),
          source_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX agent_context_manifests_thread_created
          ON agent_context_manifests(thread_id, created_at DESC, id);
        CREATE INDEX agent_context_manifests_turn_created
          ON agent_context_manifests(turn_id, created_at DESC, id);

        CREATE TABLE agent_context_entries (
          id TEXT PRIMARY KEY NOT NULL,
          manifest_id TEXT NOT NULL REFERENCES agent_context_manifests(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          source_type TEXT NOT NULL CHECK (source_type IN (
            'policy', 'user', 'directive', 'scene', 'selection', 'job', 'result',
            'memory', 'summary', 'preference', 'capability'
          )),
          source_id TEXT NOT NULL,
          source_version INTEGER CHECK (source_version >= 0),
          scope TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'tool_available', 'outbound', 'excluded')),
          reason TEXT NOT NULL,
          content_json TEXT NOT NULL,
          estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes >= 0),
          created_at TEXT NOT NULL,
          UNIQUE(manifest_id, ordinal)
        );

        CREATE TABLE agent_context_compactions (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          source_sequence_from INTEGER NOT NULL CHECK (source_sequence_from > 0),
          source_sequence_to INTEGER NOT NULL CHECK (source_sequence_to >= source_sequence_from),
          source_hash TEXT NOT NULL,
          summary TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          UNIQUE(thread_id, source_sequence_from, source_sequence_to, source_hash)
        );
        CREATE INDEX agent_context_compactions_thread_sequence
          ON agent_context_compactions(thread_id, source_sequence_to DESC, id);

        CREATE TABLE agent_outbound_context_records (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL REFERENCES agent_turns_v2(id) ON DELETE CASCADE,
          manifest_id TEXT NOT NULL REFERENCES agent_context_manifests(id) ON DELETE CASCADE,
          tool_call_id TEXT REFERENCES agent_tool_calls_v2(id) ON DELETE SET NULL,
          provider_id TEXT,
          model TEXT,
          policy TEXT NOT NULL CHECK (policy IN ('minimal', 'review_each_image', 'local_only', 'custom')),
          data_types_json TEXT NOT NULL,
          image_asset_ids_json TEXT NOT NULL,
          text_bytes INTEGER NOT NULL CHECK (text_bytes >= 0),
          image_count INTEGER NOT NULL CHECK (image_count >= 0),
          status TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'blocked', 'sent', 'cancelled')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX agent_outbound_context_records_turn_created
          ON agent_outbound_context_records(turn_id, created_at DESC, id);
      `)
    }
  },
  {
    version: 8,
    up: (database) => {
      database.exec(`
        CREATE TABLE generation_workflow_intents (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
          turn_id TEXT REFERENCES agent_turns_v2(id) ON DELETE SET NULL,
          tool_call_item_id TEXT REFERENCES agent_items(id) ON DELETE SET NULL,
          source_message_id TEXT,
          spec_json TEXT NOT NULL,
          compiled_request_json TEXT NOT NULL,
          prompt_package_json TEXT,
          source_hash TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'prepared', 'dispatching', 'dispatched', 'waiting', 'completed',
            'failed', 'cancelled', 'external_unknown'
          )),
          job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
          dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0 AND dispatch_attempts <= 1),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dispatched_at TEXT,
          completed_at TEXT,
          UNIQUE(project_id, idempotency_key)
        );
        CREATE INDEX generation_workflow_intents_status_updated
          ON generation_workflow_intents(project_id, status, updated_at DESC, id);
        CREATE INDEX generation_workflow_intents_job
          ON generation_workflow_intents(job_id);

        CREATE TABLE agent_budget_reservations (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          turn_id TEXT REFERENCES agent_turns_v2(id) ON DELETE SET NULL,
          intent_id TEXT NOT NULL REFERENCES generation_workflow_intents(id) ON DELETE CASCADE,
          request_limit INTEGER NOT NULL CHECK (request_limit > 0),
          image_limit INTEGER NOT NULL CHECK (image_limit > 0),
          cost_limit_cny REAL NOT NULL CHECK (cost_limit_cny >= 0),
          actual_requests INTEGER NOT NULL DEFAULT 0 CHECK (actual_requests >= 0),
          actual_images INTEGER NOT NULL DEFAULT 0 CHECK (actual_images >= 0),
          actual_cost_cny REAL NOT NULL DEFAULT 0 CHECK (actual_cost_cny >= 0),
          status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(intent_id)
        );
        CREATE INDEX agent_budget_reservations_project_status
          ON agent_budget_reservations(project_id, status, updated_at DESC, id);

        CREATE TABLE generation_subscriptions (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL REFERENCES agent_turns_v2(id) ON DELETE CASCADE,
          intent_id TEXT NOT NULL REFERENCES generation_workflow_intents(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('waiting', 'observed', 'cancelled')),
          last_job_status TEXT NOT NULL CHECK (last_job_status IN (
            'queued', 'preparing', 'generating', 'downloading', 'completed',
            'failed', 'cancelled', 'timed_out', 'interrupted'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          observed_at TEXT,
          UNIQUE(turn_id, job_id)
        );
        CREATE INDEX generation_subscriptions_job_status
          ON generation_subscriptions(job_id, status, updated_at DESC, id);

        CREATE TABLE generation_result_records (
          result_id TEXT PRIMARY KEY NOT NULL REFERENCES generation_results(id) ON DELETE CASCADE,
          intent_id TEXT NOT NULL REFERENCES generation_workflow_intents(id) ON DELETE CASCADE,
          prompt_package_hash TEXT,
          prompt_package_json TEXT,
          source_scene_revision INTEGER CHECK (source_scene_revision >= 0),
          profile_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('text', 'canvas', 'edit', 'similar', 'text-effect')),
          actual_cost_cny REAL NOT NULL DEFAULT 0 CHECK (actual_cost_cny >= 0),
          created_at TEXT NOT NULL
        );
        CREATE INDEX generation_result_records_intent
          ON generation_result_records(intent_id, created_at, result_id);
      `)
    }
  },
  {
    version: 9,
    up: (database) => {
      database.exec(`
        ALTER TABLE agent_turns_v2 ADD COLUMN task_id TEXT;
        ALTER TABLE agent_turns_v2 ADD COLUMN task_relation TEXT CHECK (task_relation IN (
          'continue_current', 'revise_current', 'supplement_current', 'new_task', 'temporary_try'
        ));
        ALTER TABLE agent_turns_v2 ADD COLUMN dispatch_mode TEXT CHECK (dispatch_mode IN (
          'apply_now', 'queue_after_current', 'interrupt_current'
        ));
        ALTER TABLE agent_turns_v2 ADD COLUMN base_task_id TEXT;
        ALTER TABLE agent_turns_v2 ADD COLUMN temporary_state TEXT CHECK (temporary_state IN (
          'pending', 'accepted', 'rejected'
        ));
        CREATE INDEX agent_turns_v2_thread_task_created
          ON agent_turns_v2(thread_id, task_id, created_at DESC, id);

        ALTER TABLE agent_queue_entries ADD COLUMN task_id TEXT;
        ALTER TABLE agent_queue_entries ADD COLUMN task_relation TEXT CHECK (task_relation IN (
          'continue_current', 'revise_current', 'supplement_current', 'new_task', 'temporary_try'
        ));
        ALTER TABLE agent_queue_entries ADD COLUMN dispatch_mode TEXT CHECK (dispatch_mode IN (
          'apply_now', 'queue_after_current', 'interrupt_current'
        ));
        ALTER TABLE agent_queue_entries ADD COLUMN base_task_id TEXT;
        UPDATE agent_queue_entries SET
          task_relation = CASE mode
            WHEN 'correct_current' THEN 'revise_current'
            WHEN 'append_current' THEN 'supplement_current'
            WHEN 'queue_next' THEN 'continue_current'
            ELSE NULL
          END,
          dispatch_mode = CASE mode
            WHEN 'interrupt_now' THEN 'interrupt_current'
            ELSE 'queue_after_current'
          END;
      `)
    }
  },
  {
    version: 10,
    up: (database) => {
      database.exec(`
        ALTER TABLE agent_outbound_context_records ADD COLUMN image_bytes INTEGER CHECK(image_bytes >= 0);
        ALTER TABLE agent_outbound_context_records ADD COLUMN approval_id TEXT REFERENCES agent_items(id) ON DELETE SET NULL;
        ALTER TABLE agent_outbound_context_records ADD COLUMN request_correlation_id TEXT;
      `)
    }
  },
  {
    version: 11,
    up: (database) => {
      database.exec(`
        ALTER TABLE generation_jobs ADD COLUMN execution_identity_id TEXT;
        ALTER TABLE generation_jobs ADD COLUMN effective_timeout_ms INTEGER CHECK(effective_timeout_ms > 0);
        ALTER TABLE generation_jobs ADD COLUMN submission_state TEXT CHECK(submission_state IN ('not_sent', 'may_have_sent', 'accepted'));
      `)
    }
  },
  {
    version: 12,
    up: (database) => {
      database.exec(`
        CREATE TABLE agent_generation_limits (
          turn_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_turns_v2(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          thread_id TEXT NOT NULL REFERENCES agent_threads(id),
          limits_json TEXT NOT NULL,
          grant_item_id TEXT REFERENCES agent_items(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX agent_generation_limits_project ON agent_generation_limits(project_id, thread_id);
      `)
    }
  },
  {
    version: 13,
    up: (database) => {
      database.exec(`CREATE TABLE project_work_context (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
        context_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`)
    }
  },
  {
    version: 14,
    up: (database) => {
      database.exec(`ALTER TABLE generation_jobs ADD COLUMN copied_from_project_id TEXT;
        CREATE TABLE project_copy_records (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id),
          source_project_id TEXT NOT NULL,
          copied_at TEXT NOT NULL,
          manifest_json TEXT NOT NULL
        );`)
    }
  },
  {
    version: 15,
    up: (database) => {
      // Preserve old numeric columns as historical facts. Without provenance,
      // even a non-zero value does not establish verified settlement.
      database.exec('ALTER TABLE generation_jobs ADD COLUMN cost_json TEXT;')
      database.prepare(`UPDATE generation_jobs SET cost_json = json_object(
        'version', 1, 'estimate', NULL, 'actual', json_object(
          'status', 'known_free', 'amount', 0, 'currency', 'CNY', 'source', 'offline_mock',
          'evidence', json_object('receiptId', 'offline:' || id, 'observedAt', created_at)
        )) WHERE provider_id = 'mock'`).run()
    }
  }
]

export interface MigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  readonly backupPath: string | null
}

function readCurrentVersion(database: Database.Database): number {
  const hasMigrationsTable = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { readonly present: 1 } | undefined
  if (hasMigrationsTable === undefined) return 0
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    readonly version: number | null
  }
  return row.version ?? 0
}

function createBackupPath(databasePath: string, fromVersion: number): string {
  return join(dirname(databasePath), `project.pre-migration-v${fromVersion}.bak.db`)
}

export function runMigrations(databasePath: string): MigrationResult {
  const existed = existsSync(databasePath) && statSync(databasePath).size > 0
  const database = new Database(databasePath)
  database.pragma('foreign_keys = ON')
  const fromVersion = readCurrentVersion(database)

  if (fromVersion > LATEST_DATABASE_VERSION) {
    database.close()
    throw new Error(`Project database version ${fromVersion} is newer than supported version ${LATEST_DATABASE_VERSION}.`)
  }

  const pending = migrations.filter((migration) => migration.version > fromVersion)
  if (pending.length === 0) {
    database.close()
    return { fromVersion, toVersion: fromVersion, backupPath: null }
  }

  let backupPath: string | null = null
  if (existed) {
    backupPath = createBackupPath(databasePath, fromVersion)
    copyFileSync(databasePath, backupPath)
  }

  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
    for (const migration of pending) {
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString())
    }
  })

  try {
    migrate()
    database.pragma('journal_mode = WAL')
    database.close()
    return { fromVersion, toVersion: LATEST_DATABASE_VERSION, backupPath }
  } catch (error) {
    database.close()
    throw error
  }
}
