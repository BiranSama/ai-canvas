import { randomUUID } from 'node:crypto'
import {
  contextCompactionSchema,
  contextEntrySchema,
  contextManifestSchema,
  createMemoryCandidateInputSchema,
  createProjectDirectiveInputSchema,
  createProjectMemoryInputSchema,
  memoryCandidateSchema,
  outboundContextRecordSchema,
  outboundContextStatusSchema,
  outboundContextPolicySchema,
  projectDirectiveSchema,
  projectKnowledgeSnapshotSchema,
  projectMemoryEntrySchema,
  resolveMemoryCandidateInputSchema,
  setOutboundPolicyInputSchema,
  updateProjectDirectiveInputSchema,
  updateProjectMemoryInputSchema,
  type ContextCompaction,
  type ContextDisposition,
  type ContextManifest,
  type ContextSourceType,
  type CreateMemoryCandidateInput,
  type CreateProjectDirectiveInput,
  type CreateProjectMemoryInput,
  type MemoryCandidate,
  type OutboundContextPolicy,
  type OutboundContextRecord,
  type OutboundContextStatus,
  type ProjectDirective,
  type ProjectKnowledgeSnapshot,
  type ProjectMemoryEntry,
  type ResolveMemoryCandidateInput,
  type SetOutboundPolicyInput,
  type UpdateProjectDirectiveInput,
  type UpdateProjectMemoryInput
} from '../../shared/agent-context'
import {
  openDatabase,
  type AgentContextCompactionRow,
  type AgentContextEntryRow,
  type AgentContextManifestRow,
  type AgentOutboundContextRecordRow,
  type AgentProjectContextSettingsRow,
  type DatabaseConnection,
  type ProjectDirectiveRow,
  type ProjectMemoryCandidateRow,
  type ProjectMemoryEntryRow
} from '../storage/database'

export class AgentContextRepositoryError extends Error {
  readonly code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVALID_STATE'

  constructor(code: AgentContextRepositoryError['code'], message: string) {
    super(message)
    this.name = 'AgentContextRepositoryError'
    this.code = code
  }
}

export interface ContextManifestEntryInput {
  readonly sourceType: ContextSourceType
  readonly sourceId: string
  readonly version: number | null
  readonly scope: string
  readonly disposition: ContextDisposition
  readonly reason: string
  readonly content: unknown
  readonly estimatedBytes: number
}

export interface CreateContextManifestInput {
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly sceneRevision: number
  readonly outboundPolicy: OutboundContextPolicy
  readonly entries: readonly ContextManifestEntryInput[]
  readonly estimatedTextBytes: number
  readonly imageCount: number
  readonly sourceHash: string
}

export interface CreateContextCompactionInput {
  readonly projectId: string
  readonly threadId: string
  readonly sourceSequenceFrom: number
  readonly sourceSequenceTo: number
  readonly sourceHash: string
  readonly summary: string
}

export interface CreateOutboundContextRecordInput {
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly manifestId: string
  readonly toolCallId?: string | null
  readonly providerId?: string | null
  readonly model?: string | null
  readonly policy: OutboundContextPolicy
  readonly dataTypes: readonly string[]
  readonly imageAssetIds: readonly string[]
  readonly textBytes: number
  readonly imageCount: number
  readonly imageBytes?: number | null
  readonly approvalId?: string | null
  readonly requestCorrelationId?: string | null
  readonly status: OutboundContextStatus
  readonly reason: string
}

function mapDirective(row: ProjectDirectiveRow): ProjectDirective {
  return projectDirectiveSchema.parse({
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    category: row.category,
    priority: row.priority,
    enabled: row.enabled === 1,
    sourceMessageId: row.source_message_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapMemory(row: ProjectMemoryEntryRow): ProjectMemoryEntry {
  return projectMemoryEntrySchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    confidence: row.confidence,
    status: row.status,
    version: row.version,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapCandidate(row: ProjectMemoryCandidateRow): MemoryCandidate {
  return memoryCandidateSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    confidence: row.confidence,
    status: row.status,
    confirmedMemoryId: row.confirmed_memory_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function mapContextEntry(row: AgentContextEntryRow) {
  return contextEntrySchema.parse({
    id: row.id,
    manifestId: row.manifest_id,
    ordinal: row.ordinal,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.source_version,
    scope: row.scope,
    disposition: row.disposition,
    reason: row.reason,
    content: JSON.parse(row.content_json),
    estimatedBytes: row.estimated_bytes,
    createdAt: row.created_at
  })
}

function mapManifest(row: AgentContextManifestRow, entries: readonly AgentContextEntryRow[]): ContextManifest {
  return contextManifestSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sceneRevision: row.scene_revision,
    entries: entries.map(mapContextEntry),
    outboundPolicy: row.outbound_policy,
    estimatedTextBytes: row.estimated_text_bytes,
    imageCount: row.image_count,
    sourceHash: row.source_hash,
    createdAt: row.created_at
  })
}

function mapCompaction(row: AgentContextCompactionRow): ContextCompaction {
  return contextCompactionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    sourceSequenceFrom: row.source_sequence_from,
    sourceSequenceTo: row.source_sequence_to,
    sourceHash: row.source_hash,
    summary: row.summary,
    version: row.version,
    createdAt: row.created_at
  })
}

function mapOutbound(row: AgentOutboundContextRecordRow): OutboundContextRecord {
  return outboundContextRecordSchema.parse({
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    manifestId: row.manifest_id,
    toolCallId: row.tool_call_id,
    providerId: row.provider_id,
    model: row.model,
    policy: row.policy,
    dataTypes: JSON.parse(row.data_types_json),
    imageAssetIds: JSON.parse(row.image_asset_ids_json),
    textBytes: row.text_bytes,
    imageCount: row.image_count,
    imageBytes: row.image_bytes,
    approvalId: row.approval_id,
    requestCorrelationId: row.request_correlation_id,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export class AgentContextRepository {
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

  async getSettings(projectId: string): Promise<{ readonly outboundPolicy: OutboundContextPolicy; readonly version: number }> {
    const now = this.#now()
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_project_context_settings(project_id, outbound_policy, version, created_at, updated_at)
      VALUES (?, 'minimal', 1, ?, ?)
      ON CONFLICT(project_id) DO NOTHING
    `).run(projectId, now, now)
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_project_context_settings WHERE project_id = ?')
      .get(projectId) as AgentProjectContextSettingsRow | undefined
    if (row === undefined) throw new AgentContextRepositoryError('NOT_FOUND', `Project ${projectId} does not exist.`)
    return { outboundPolicy: outboundContextPolicySchema.parse(row.outbound_policy), version: row.version }
  }

  async setOutboundPolicy(projectId: string, inputValue: SetOutboundPolicyInput): Promise<{ readonly outboundPolicy: OutboundContextPolicy; readonly version: number }> {
    const input = setOutboundPolicyInputSchema.parse(inputValue)
    await this.getSettings(projectId)
    const now = this.#now()
    const result = this.#connection.sqlite.prepare(`
      UPDATE agent_project_context_settings
      SET outbound_policy = ?, version = version + 1, updated_at = ?
      WHERE project_id = ? AND version = ?
    `).run(input.policy, now, projectId, input.expectedVersion)
    if (result.changes === 0) this.#throwVersionConflict('context settings', projectId, input.expectedVersion)
    return this.getSettings(projectId)
  }

  async listDirectives(projectId: string, includeDisabled = true): Promise<readonly ProjectDirective[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM project_directives WHERE project_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
      ORDER BY enabled DESC, priority DESC, updated_at DESC, id
    `).all(projectId) as ProjectDirectiveRow[]
    return rows.map(mapDirective)
  }

  async createDirective(projectId: string, inputValue: CreateProjectDirectiveInput): Promise<ProjectDirective> {
    const input = createProjectDirectiveInputSchema.parse(inputValue)
    const now = this.#now()
    const row: ProjectDirectiveRow = {
      id: this.#idFactory(), project_id: projectId, text: input.text, category: input.category,
      priority: input.priority, enabled: 1, source_message_id: input.sourceMessageId,
      version: 1, created_at: now, updated_at: now
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO project_directives(
        id, project_id, text, category, priority, enabled, source_message_id, version, created_at, updated_at
      ) VALUES (
        @id, @project_id, @text, @category, @priority, @enabled, @source_message_id, @version, @created_at, @updated_at
      )
    `).run(row)
    return mapDirective(row)
  }

  async updateDirective(projectId: string, inputValue: UpdateProjectDirectiveInput): Promise<ProjectDirective> {
    const input = updateProjectDirectiveInputSchema.parse(inputValue)
    const current = this.#requireDirective(projectId, input.id)
    if (current.version !== input.expectedVersion) {
      throw new AgentContextRepositoryError('VERSION_CONFLICT', `Directive ${input.id} changed from version ${input.expectedVersion} to ${current.version}.`)
    }
    const now = this.#now()
    const next: ProjectDirectiveRow = {
      ...current,
      text: input.text ?? current.text,
      category: input.category ?? current.category,
      priority: input.priority ?? current.priority,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      version: current.version + 1,
      updated_at: now
    }
    const result = this.#connection.sqlite.prepare(`
      UPDATE project_directives SET text = @text, category = @category, priority = @priority,
        enabled = @enabled, version = @version, updated_at = @updated_at
      WHERE id = @id AND project_id = @project_id AND version = @expected_version
    `).run({ ...next, expected_version: input.expectedVersion })
    if (result.changes === 0) this.#throwVersionConflict('directive', input.id, input.expectedVersion)
    return mapDirective(next)
  }

  async listMemories(projectId: string, includeInactive = true): Promise<readonly ProjectMemoryEntry[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM project_memory_entries WHERE project_id = ? ${includeInactive ? '' : "AND status = 'active'"}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id
    `).all(projectId) as ProjectMemoryEntryRow[]
    return rows.map(mapMemory)
  }

  async createMemory(projectId: string, inputValue: CreateProjectMemoryInput): Promise<ProjectMemoryEntry> {
    const input = createProjectMemoryInputSchema.parse(inputValue)
    const now = this.#now()
    const row: ProjectMemoryEntryRow = {
      id: this.#idFactory(), project_id: projectId, kind: input.kind, content: input.content,
      source_type: input.sourceType, source_id: input.sourceId, confidence: input.confidence,
      status: 'active', version: 1, supersedes_id: input.supersedesId, created_at: now, updated_at: now
    }
    this.#insertMemory(row)
    return mapMemory(row)
  }

  async updateMemory(projectId: string, inputValue: UpdateProjectMemoryInput): Promise<ProjectMemoryEntry> {
    const input = updateProjectMemoryInputSchema.parse(inputValue)
    const current = this.#requireMemory(projectId, input.id)
    if (current.version !== input.expectedVersion) {
      throw new AgentContextRepositoryError('VERSION_CONFLICT', `Memory ${input.id} changed from version ${input.expectedVersion} to ${current.version}.`)
    }
    const contentChanged = input.content !== undefined || input.kind !== undefined || input.confidence !== undefined
    const now = this.#now()
    if (contentChanged) {
      let successor: ProjectMemoryEntryRow | null = null
      const transaction = this.#connection.sqlite.transaction(() => {
        const latest = this.#requireMemory(projectId, input.id)
        if (latest.version !== input.expectedVersion) this.#throwVersionConflict('memory', input.id, input.expectedVersion)
        this.#connection.sqlite.prepare(`
          UPDATE project_memory_entries SET status = 'disabled', version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(now, input.id, input.expectedVersion)
        successor = {
          id: this.#idFactory(), project_id: projectId, kind: input.kind ?? latest.kind,
          content: input.content ?? latest.content, source_type: latest.source_type, source_id: latest.source_id,
          confidence: input.confidence ?? latest.confidence, status: input.status ?? 'active',
          version: latest.version + 1, supersedes_id: latest.id, created_at: now, updated_at: now
        }
        this.#insertMemory(successor)
      })
      transaction()
      if (successor === null) throw new Error('Memory update did not create a successor.')
      return mapMemory(successor)
    }
    const nextStatus = input.status ?? current.status
    const result = this.#connection.sqlite.prepare(`
      UPDATE project_memory_entries SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND version = ?
    `).run(nextStatus, now, input.id, projectId, input.expectedVersion)
    if (result.changes === 0) this.#throwVersionConflict('memory', input.id, input.expectedVersion)
    return mapMemory({ ...current, status: nextStatus, version: current.version + 1, updated_at: now })
  }

  async listCandidates(projectId: string): Promise<readonly MemoryCandidate[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM project_memory_candidates WHERE project_id = ?
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC, id
    `).all(projectId) as ProjectMemoryCandidateRow[]
    return rows.map(mapCandidate)
  }

  async createCandidate(projectId: string, inputValue: CreateMemoryCandidateInput): Promise<MemoryCandidate> {
    const input = createMemoryCandidateInputSchema.parse(inputValue)
    const now = this.#now()
    const row: ProjectMemoryCandidateRow = {
      id: this.#idFactory(), project_id: projectId, kind: input.kind, content: input.content,
      source_type: input.sourceType, source_id: input.sourceId, confidence: input.confidence,
      status: 'pending', confirmed_memory_id: null, version: 1, created_at: now, updated_at: now
    }
    this.#connection.sqlite.prepare(`
      INSERT INTO project_memory_candidates(
        id, project_id, kind, content, source_type, source_id, confidence, status,
        confirmed_memory_id, version, created_at, updated_at
      ) VALUES (
        @id, @project_id, @kind, @content, @source_type, @source_id, @confidence, @status,
        @confirmed_memory_id, @version, @created_at, @updated_at
      )
    `).run(row)
    return mapCandidate(row)
  }

  async resolveCandidate(projectId: string, inputValue: ResolveMemoryCandidateInput): Promise<MemoryCandidate> {
    const input = resolveMemoryCandidateInputSchema.parse(inputValue)
    const now = this.#now()
    let resultRow: ProjectMemoryCandidateRow | null = null
    const transaction = this.#connection.sqlite.transaction(() => {
      const candidate = this.#requireCandidate(projectId, input.id)
      if (candidate.version !== input.expectedVersion) this.#throwVersionConflict('memory candidate', input.id, input.expectedVersion)
      if (candidate.status !== 'pending') {
        throw new AgentContextRepositoryError('INVALID_STATE', `Memory candidate ${input.id} is already ${candidate.status}.`)
      }
      let memoryId: string | null = null
      if (input.resolution === 'confirm') {
        const memory: ProjectMemoryEntryRow = {
          id: this.#idFactory(), project_id: projectId, kind: candidate.kind, content: candidate.content,
          source_type: 'candidate', source_id: candidate.id, confidence: candidate.confidence,
          status: 'active', version: 1, supersedes_id: null, created_at: now, updated_at: now
        }
        this.#insertMemory(memory)
        memoryId = memory.id
      }
      const status = input.resolution === 'confirm' ? 'confirmed' : 'rejected'
      const update = this.#connection.sqlite.prepare(`
        UPDATE project_memory_candidates SET status = ?, confirmed_memory_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND version = ? AND status = 'pending'
      `).run(status, memoryId, now, input.id, projectId, input.expectedVersion)
      if (update.changes === 0) this.#throwVersionConflict('memory candidate', input.id, input.expectedVersion)
      resultRow = { ...candidate, status, confirmed_memory_id: memoryId, version: candidate.version + 1, updated_at: now }
    })
    transaction()
    if (resultRow === null) throw new Error('Memory candidate resolution did not produce a row.')
    return mapCandidate(resultRow)
  }

  async createManifest(input: CreateContextManifestInput): Promise<ContextManifest> {
    const now = this.#now()
    const manifestId = this.#idFactory()
    const manifestRow: AgentContextManifestRow = {
      id: manifestId, project_id: input.projectId, thread_id: input.threadId, turn_id: input.turnId,
      scene_revision: input.sceneRevision, outbound_policy: outboundContextPolicySchema.parse(input.outboundPolicy),
      estimated_text_bytes: input.estimatedTextBytes, image_count: input.imageCount,
      source_hash: input.sourceHash, created_at: now
    }
    const entryRows: AgentContextEntryRow[] = input.entries.map((entry, ordinal) => ({
      id: this.#idFactory(), manifest_id: manifestId, ordinal, source_type: entry.sourceType,
      source_id: entry.sourceId, source_version: entry.version, scope: entry.scope,
      disposition: entry.disposition, reason: entry.reason, content_json: JSON.stringify(entry.content ?? null),
      estimated_bytes: entry.estimatedBytes, created_at: now
    }))
    const parsed = mapManifest(manifestRow, entryRows)
    const transaction = this.#connection.sqlite.transaction(() => {
      this.#connection.sqlite.prepare(`
        INSERT INTO agent_context_manifests(
          id, project_id, thread_id, turn_id, scene_revision, outbound_policy,
          estimated_text_bytes, image_count, source_hash, created_at
        ) VALUES (
          @id, @project_id, @thread_id, @turn_id, @scene_revision, @outbound_policy,
          @estimated_text_bytes, @image_count, @source_hash, @created_at
        )
      `).run(manifestRow)
      const insertEntry = this.#connection.sqlite.prepare(`
        INSERT INTO agent_context_entries(
          id, manifest_id, ordinal, source_type, source_id, source_version, scope,
          disposition, reason, content_json, estimated_bytes, created_at
        ) VALUES (
          @id, @manifest_id, @ordinal, @source_type, @source_id, @source_version, @scope,
          @disposition, @reason, @content_json, @estimated_bytes, @created_at
        )
      `)
      for (const row of entryRows) insertEntry.run(row)
    })
    transaction()
    return parsed
  }

  async getManifest(manifestId: string): Promise<ContextManifest> {
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_context_manifests WHERE id = ?')
      .get(manifestId) as AgentContextManifestRow | undefined
    if (row === undefined) throw new AgentContextRepositoryError('NOT_FOUND', `Context manifest ${manifestId} does not exist.`)
    const entries = this.#connection.sqlite.prepare('SELECT * FROM agent_context_entries WHERE manifest_id = ? ORDER BY ordinal, id')
      .all(manifestId) as AgentContextEntryRow[]
    return mapManifest(row, entries)
  }

  async getLatestManifest(projectId: string): Promise<ContextManifest | null> {
    const row = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_context_manifests WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(projectId) as AgentContextManifestRow | undefined
    return row === undefined ? null : this.getManifest(row.id)
  }

  async createCompaction(input: CreateContextCompactionInput): Promise<ContextCompaction> {
    const existing = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_context_compactions
      WHERE thread_id = ? AND source_sequence_from = ? AND source_sequence_to = ? AND source_hash = ?
    `).get(input.threadId, input.sourceSequenceFrom, input.sourceSequenceTo, input.sourceHash) as AgentContextCompactionRow | undefined
    if (existing !== undefined) return mapCompaction(existing)
    const now = this.#now()
    const latest = this.#connection.sqlite.prepare(`
      SELECT MAX(version) AS version FROM agent_context_compactions WHERE thread_id = ?
    `).get(input.threadId) as { version: number | null }
    const row: AgentContextCompactionRow = {
      id: this.#idFactory(), project_id: input.projectId, thread_id: input.threadId,
      source_sequence_from: input.sourceSequenceFrom, source_sequence_to: input.sourceSequenceTo,
      source_hash: input.sourceHash, summary: input.summary, version: (latest.version ?? 0) + 1, created_at: now
    }
    const parsed = mapCompaction(row)
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_context_compactions(
        id, project_id, thread_id, source_sequence_from, source_sequence_to,
        source_hash, summary, version, created_at
      ) VALUES (
        @id, @project_id, @thread_id, @source_sequence_from, @source_sequence_to,
        @source_hash, @summary, @version, @created_at
      )
    `).run(row)
    return parsed
  }

  async listCompactions(threadId: string): Promise<readonly ContextCompaction[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_context_compactions WHERE thread_id = ? ORDER BY source_sequence_to DESC, id
    `).all(threadId) as AgentContextCompactionRow[]
    return rows.map(mapCompaction)
  }

  async createOutboundRecord(input: CreateOutboundContextRecordInput): Promise<OutboundContextRecord> {
    const now = this.#now()
    const row: AgentOutboundContextRecordRow = {
      id: this.#idFactory(), project_id: input.projectId, thread_id: input.threadId, turn_id: input.turnId,
      manifest_id: input.manifestId, tool_call_id: input.toolCallId ?? null,
      provider_id: input.providerId ?? null, model: input.model ?? null,
      policy: outboundContextPolicySchema.parse(input.policy), data_types_json: JSON.stringify(input.dataTypes),
      image_asset_ids_json: JSON.stringify(input.imageAssetIds), text_bytes: input.textBytes,
      image_count: input.imageCount, image_bytes: input.imageBytes ?? null,
      approval_id: input.approvalId ?? null, request_correlation_id: input.requestCorrelationId ?? null,
      status: outboundContextStatusSchema.parse(input.status),
      reason: input.reason, created_at: now, updated_at: now
    }
    const parsed = mapOutbound(row)
    this.#connection.sqlite.prepare(`
      INSERT INTO agent_outbound_context_records(
        id, project_id, thread_id, turn_id, manifest_id, tool_call_id, provider_id, model,
        policy, data_types_json, image_asset_ids_json, text_bytes, image_count, image_bytes,
        approval_id, request_correlation_id, status,
        reason, created_at, updated_at
      ) VALUES (
        @id, @project_id, @thread_id, @turn_id, @manifest_id, @tool_call_id, @provider_id, @model,
        @policy, @data_types_json, @image_asset_ids_json, @text_bytes, @image_count, @image_bytes,
        @approval_id, @request_correlation_id, @status,
        @reason, @created_at, @updated_at
      )
    `).run(row)
    return parsed
  }

  async transitionOutboundRecord(recordId: string, statusValue: OutboundContextStatus, reason: string): Promise<OutboundContextRecord> {
    const status = outboundContextStatusSchema.parse(statusValue)
    const now = this.#now()
    const result = this.#connection.sqlite.prepare(`
      UPDATE agent_outbound_context_records SET status = ?, reason = ?, updated_at = ? WHERE id = ?
    `).run(status, reason, now, recordId)
    if (result.changes === 0) throw new AgentContextRepositoryError('NOT_FOUND', `Outbound record ${recordId} does not exist.`)
    const row = this.#connection.sqlite.prepare('SELECT * FROM agent_outbound_context_records WHERE id = ?')
      .get(recordId) as AgentOutboundContextRecordRow
    return mapOutbound(row)
  }

  async listOutboundRecords(projectId: string, limit = 50): Promise<readonly OutboundContextRecord[]> {
    const rows = this.#connection.sqlite.prepare(`
      SELECT * FROM agent_outbound_context_records WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?
    `).all(projectId, Math.max(1, Math.min(500, Math.floor(limit)))) as AgentOutboundContextRecordRow[]
    return rows.map(mapOutbound)
  }

  async getSnapshot(projectId: string): Promise<ProjectKnowledgeSnapshot> {
    const [settings, directives, memories, candidates, latestManifest, outboundRecords] = await Promise.all([
      this.getSettings(projectId),
      this.listDirectives(projectId),
      this.listMemories(projectId),
      this.listCandidates(projectId),
      this.getLatestManifest(projectId),
      this.listOutboundRecords(projectId)
    ])
    return projectKnowledgeSnapshotSchema.parse({
      projectId,
      outboundPolicy: settings.outboundPolicy,
      outboundPolicyVersion: settings.version,
      directives,
      memories,
      candidates,
      latestManifest,
      outboundRecords
    })
  }

  async close(): Promise<void> {
    this.#connection.sqlite.close()
  }

  #insertMemory(row: ProjectMemoryEntryRow): void {
    this.#connection.sqlite.prepare(`
      INSERT INTO project_memory_entries(
        id, project_id, kind, content, source_type, source_id, confidence, status,
        version, supersedes_id, created_at, updated_at
      ) VALUES (
        @id, @project_id, @kind, @content, @source_type, @source_id, @confidence, @status,
        @version, @supersedes_id, @created_at, @updated_at
      )
    `).run(row)
  }

  #requireDirective(projectId: string, id: string): ProjectDirectiveRow {
    const row = this.#connection.sqlite.prepare('SELECT * FROM project_directives WHERE id = ? AND project_id = ?')
      .get(id, projectId) as ProjectDirectiveRow | undefined
    if (row === undefined) throw new AgentContextRepositoryError('NOT_FOUND', `Directive ${id} does not exist.`)
    return row
  }

  #requireMemory(projectId: string, id: string): ProjectMemoryEntryRow {
    const row = this.#connection.sqlite.prepare('SELECT * FROM project_memory_entries WHERE id = ? AND project_id = ?')
      .get(id, projectId) as ProjectMemoryEntryRow | undefined
    if (row === undefined) throw new AgentContextRepositoryError('NOT_FOUND', `Memory ${id} does not exist.`)
    return row
  }

  #requireCandidate(projectId: string, id: string): ProjectMemoryCandidateRow {
    const row = this.#connection.sqlite.prepare('SELECT * FROM project_memory_candidates WHERE id = ? AND project_id = ?')
      .get(id, projectId) as ProjectMemoryCandidateRow | undefined
    if (row === undefined) throw new AgentContextRepositoryError('NOT_FOUND', `Memory candidate ${id} does not exist.`)
    return row
  }

  #throwVersionConflict(kind: string, id: string, expectedVersion: number): never {
    throw new AgentContextRepositoryError('VERSION_CONFLICT', `${kind} ${id} no longer matches expected version ${expectedVersion}.`)
  }
}
