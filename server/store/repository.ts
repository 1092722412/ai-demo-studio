import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STORE_SCHEMA_SQL } from './schema.js';

export type ProjectRecord = {
  id: string;
  title: string;
  brief: string;
  stage: string;
  connectionId: string | null;
  currentSourceId: string | null;
  currentVideoId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequirementRecord = {
  id: string;
  text: string;
  outcome: string;
  sourceRef: { artifactId: string; locator: string; quote: string } | null;
  confirmed: boolean;
  sortOrder: number;
};

export type ConnectionRecord = {
  id: string;
  name: string;
  kind: 'codex_app_server' | 'external' | 'api_key';
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  credentialRef: string | null;
  options: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationRecord = {
  id: string;
  projectId: string;
  connectionId: string;
  nativeSessionRef: string | null;
  contextSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  taskId: string | null;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolCallId: string | null;
  state: 'pending' | 'complete' | 'partial';
  createdAt: string;
};

export type TaskRecord = {
  id: string;
  projectId: string;
  conversationId?: string | null;
  connectionId?: string | null;
  kind: 'ai' | 'build' | 'script' | 'record' | 'render';
  purpose?: string | null;
  state: 'queued' | 'running' | 'waiting_input' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  input: unknown;
  runtime?: unknown | null;
  result?: unknown | null;
  error?: unknown | null;
  waitingInput?: unknown | null;
  requestId: string;
  request: unknown;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type EventRecord = {
  taskId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type PlanRecord = {
  projectId: string;
  sourceArtifactId: string | null;
  body: unknown;
  state: 'draft' | 'ready' | 'needs_update';
  editToken: string;
  updatedAt: string;
};

export type SettingsRecord = {
  scope: string;
  values: unknown;
  editToken: string;
  updatedAt: string;
};

export type ArtifactRecord = {
  id: string;
  projectId: string;
  taskId?: string | null;
  kind: 'attachment' | 'source' | 'plan' | 'script' | 'capture' | 'media' | 'video' | 'log';
  relativePath: string;
  mime: string;
  bytes: number;
  state: 'pending' | 'available' | 'partial' | 'missing';
  metadata?: unknown;
  createdAt: string;
};

export type PlanSave = {
  projectId: string;
  expectedEditToken: string;
  sourceArtifactId?: string | null;
  body: unknown;
  state: 'draft' | 'ready' | 'needs_update';
  updatedAt: string;
};

export type SettingsSave = {
  scope: string;
  expectedEditToken: string;
  values: unknown;
  updatedAt: string;
};

export class StoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export type StudioRepository = {
  transaction<T>(work: (repository: StudioRepository) => T): T;
  getProject(projectId: string): ProjectRecord | null;
  listProjects(): ProjectRecord[];
  updateProject(project: ProjectRecord): ProjectRecord;
  getConnection(connectionId: string): ConnectionRecord | null;
  saveConnection(connection: ConnectionRecord): ConnectionRecord;
  listConnections(): ConnectionRecord[];
  hasActiveConnectionTask(connectionId: string): boolean;
  getConversation(conversationId: string, projectId?: string): ConversationRecord | null;
  listConversations(projectId: string): ConversationRecord[];
  saveConversation(conversation: ConversationRecord): ConversationRecord;
  listMessages(conversationId: string, afterId?: string | null, limit?: number): MessageRecord[];
  saveMessage(message: MessageRecord): MessageRecord;
  getTask(taskId: string): TaskRecord | null;
  getTaskByRequest(projectId: string, requestId: string): TaskRecord | null;
  listTasks(projectId: string): TaskRecord[];
  listEvents(taskId: string, afterSeq?: number, limit?: number): EventRecord[];
  getLastEventSeq(taskId: string): number;
  getArtifact(artifactId: string, projectId?: string): ArtifactRecord | null;
  listArtifacts(projectId: string, kind?: ArtifactRecord['kind']): ArtifactRecord[];
  getArtifactPath(projectId: string, artifactId: string): { artifact: ArtifactRecord; path: string } | null;
  getNewArtifactPath(projectId: string, relativePath: string): string;
  getPlan(projectId: string): PlanRecord | null;
  listRequirements(projectId: string): RequirementRecord[];
  replaceRequirements(projectId: string, items: RequirementRecord[]): void;
  listConfirmedRequirementIds(projectId: string): string[];
  clearRequirementConfirmations(projectId: string): void;
  markPlanReady(projectId: string, editToken: string, sourceArtifactId: string): boolean;
  getSettings(scope: string): SettingsRecord | null;
  ensureSettings(scope: string): SettingsRecord;
  saveProject(project: ProjectRecord): ProjectRecord;
  saveTask(task: TaskRecord): TaskRecord;
  appendEvent(event: Omit<EventRecord, 'seq'>): EventRecord;
  registerArtifact(artifact: ArtifactRecord): ArtifactRecord;
  finalizeArtifact(artifactId: string, state: 'available' | 'partial' | 'missing', bytes: number, relativePath?: string): ArtifactRecord;
  compareAndSavePlan(plan: PlanSave): { saved: boolean; editToken: string | null };
  compareAndSaveSettings(settings: SettingsSave): { saved: boolean; editToken: string | null };
  close(): void;
};

export async function initializeStore(dataRoot: string): Promise<StudioRepository> {
  const root = resolve(dataRoot);
  mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(join(root, 'studio.sqlite'));
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    database.exec(STORE_SCHEMA_SQL);
    const repository = new SqliteStudioRepository(database, root);
    repository.ensureGlobalSettings();
    return repository;
  } catch (error) {
    database.close();
    throw error;
  }
}

class SqliteStudioRepository implements StudioRepository {
  private transactionDepth = 0;
  private savepointCounter = 0;
  private closed = false;

  constructor(private readonly database: DatabaseSync, private readonly dataRoot: string) {}

  transaction<T>(work: (repository: StudioRepository) => T): T {
    this.assertOpen();
    const outer = this.transactionDepth === 0;
    const savepoint = `store_${++this.savepointCounter}`;
    this.database.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = work(this);
      if (isPromiseLike(result)) throw new StoreError('VALIDATION_FAILED', '数据库事务回调必须同步完成。');
      this.transactionDepth -= 1;
      this.database.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      try {
        this.database.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // 保留原始事务错误。
      }
      throw error;
    }
  }

  getProject(projectId: string): ProjectRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as DbRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listProjects(): ProjectRecord[] {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM project ORDER BY updated_at DESC').all() as DbRow[]).map(projectFromRow);
  }

  updateProject(project: ProjectRecord): ProjectRecord {
    this.assertOpen();
    validateId(project.id, '项目');
    const result = this.database.prepare(`
      UPDATE project SET title = ?, brief = ?, stage = ?, connection_id = ?, current_source_id = ?,
                         current_video_id = ?, updated_at = ? WHERE id = ?
    `).run(
      project.title, project.brief, project.stage, project.connectionId, project.currentSourceId,
      project.currentVideoId, project.updatedAt, project.id,
    );
    if (Number(result.changes) !== 1) throw new StoreError('VALIDATION_FAILED', '找不到此项目。');
    return project;
  }

  getConnection(connectionId: string): ConnectionRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM connection WHERE id = ?').get(connectionId) as DbRow | undefined;
    return row ? connectionFromRow(row) : null;
  }

  saveConnection(connection: ConnectionRecord): ConnectionRecord {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO connection (id, name, kind, provider, model, base_url, credential_ref, options_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, provider = excluded.provider,
        model = excluded.model, base_url = excluded.base_url, credential_ref = excluded.credential_ref,
        options_json = excluded.options_json, enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(
      connection.id, connection.name, connection.kind, connection.provider, connection.model, connection.baseUrl,
      connection.credentialRef, stableStringify(connection.options), connection.enabled ? 1 : 0,
      connection.createdAt, connection.updatedAt,
    );
    return connection;
  }

  listConnections(): ConnectionRecord[] {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM connection ORDER BY created_at, id').all() as DbRow[]).map(connectionFromRow);
  }

  hasActiveConnectionTask(connectionId: string): boolean {
    this.assertOpen();
    return Boolean(this.database.prepare(`
      SELECT 1 FROM task WHERE connection_id = ? AND state IN ('queued','running','waiting_input','cancelling') LIMIT 1
    `).get(connectionId));
  }

  getConversation(conversationId: string, projectId?: string): ConversationRecord | null {
    this.assertOpen();
    const row = projectId
      ? this.database.prepare('SELECT * FROM conversation WHERE id = ? AND project_id = ?').get(conversationId, projectId) as DbRow | undefined
      : this.database.prepare('SELECT * FROM conversation WHERE id = ?').get(conversationId) as DbRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  listConversations(projectId: string): ConversationRecord[] {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM conversation WHERE project_id = ? ORDER BY updated_at DESC, id DESC')
      .all(projectId) as DbRow[]).map(conversationFromRow);
  }

  saveConversation(conversation: ConversationRecord): ConversationRecord {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO conversation (id, project_id, connection_id, native_session_ref, context_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id,
        native_session_ref = excluded.native_session_ref, context_summary = excluded.context_summary,
        updated_at = excluded.updated_at
    `).run(
      conversation.id, conversation.projectId, conversation.connectionId, conversation.nativeSessionRef,
      conversation.contextSummary, conversation.createdAt, conversation.updatedAt,
    );
    return conversation;
  }

  listMessages(conversationId: string, afterId: string | null = null, limit = 50): MessageRecord[] {
    this.assertOpen();
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const cursor = afterId
      ? this.database.prepare('SELECT created_at FROM message WHERE id = ? AND conversation_id = ?').get(afterId, conversationId) as DbRow | undefined
      : undefined;
    const rows = afterId && !cursor ? [] : afterId
      ? this.database.prepare(`
          SELECT * FROM message WHERE conversation_id = ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at, id LIMIT ?
        `).all(conversationId, cursor!.created_at, cursor!.created_at, afterId, safeLimit) as DbRow[]
      : this.database.prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at, id LIMIT ?')
        .all(conversationId, safeLimit) as DbRow[];
    return rows.map(messageFromRow);
  }

  saveMessage(message: MessageRecord): MessageRecord {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO message (id, conversation_id, task_id, role, text, tool_call_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, role = excluded.role, text = excluded.text,
        tool_call_id = excluded.tool_call_id, state = excluded.state
    `).run(
      message.id, message.conversationId, message.taskId, message.role, message.text,
      message.toolCallId, message.state, message.createdAt,
    );
    return message;
  }

  getTask(taskId: string): TaskRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as DbRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  getTaskByRequest(projectId: string, requestId: string): TaskRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM task WHERE project_id = ? AND request_id = ?')
      .get(projectId, requestId) as DbRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  listTasks(projectId: string): TaskRecord[] {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM task WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as DbRow[]).map(taskFromRow);
  }

  listEvents(taskId: string, afterSeq = 0, limit = 500): EventRecord[] {
    this.assertOpen();
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return (this.database.prepare(`
      SELECT * FROM event WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(taskId, afterSeq, safeLimit) as DbRow[]).map(eventFromRow);
  }

  getLastEventSeq(taskId: string): number {
    this.assertOpen();
    const row = this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS last_seq FROM event WHERE task_id = ?')
      .get(taskId) as DbRow;
    return Number(row.last_seq);
  }

  getArtifact(artifactId: string, projectId?: string): ArtifactRecord | null {
    this.assertOpen();
    const row = projectId
      ? this.database.prepare('SELECT * FROM artifact WHERE id = ? AND project_id = ?').get(artifactId, projectId) as DbRow | undefined
      : this.database.prepare('SELECT * FROM artifact WHERE id = ?').get(artifactId) as DbRow | undefined;
    return row ? artifactFromRow(row) : null;
  }

  listArtifacts(projectId: string, kind?: ArtifactRecord['kind']): ArtifactRecord[] {
    this.assertOpen();
    const rows = kind
      ? this.database.prepare('SELECT * FROM artifact WHERE project_id = ? AND kind = ? ORDER BY created_at DESC').all(projectId, kind) as DbRow[]
      : this.database.prepare('SELECT * FROM artifact WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as DbRow[];
    return rows.map(artifactFromRow);
  }

  getArtifactPath(projectId: string, artifactId: string): { artifact: ArtifactRecord; path: string } | null {
    this.assertOpen();
    const artifact = this.getArtifact(artifactId, projectId);
    if (!artifact) return null;
    const projectRoot = join(this.dataRoot, 'projects', projectId);
    const path = resolveProjectPath(projectRoot, artifact.relativePath);
    if (!existsSync(path)) return null;
    const rootReal = realpathSync(projectRoot);
    const expectedRoot = join(realpathSync(join(this.dataRoot, 'projects')), projectId);
    if (relative(expectedRoot, rootReal)) throw new StoreError('VALIDATION_FAILED', '项目文件目录无效。');
    const fileReal = realpathSync(path);
    assertContained(rootReal, fileReal);
    if (!statSync(fileReal).isFile()) return null;
    return { artifact, path: fileReal };
  }

  listRequirements(projectId: string): RequirementRecord[] {
    this.assertOpen();
    const rows = this.database.prepare('SELECT * FROM requirement WHERE project_id = ? ORDER BY sort_order, id')
      .all(projectId) as DbRow[];
    return rows.map((row) => ({ id: String(row.id), text: String(row.text), outcome: String(row.outcome),
      sourceRef: parseNullableJson(row.source_ref_json) as RequirementRecord['sourceRef'],
      confirmed: row.confirmed === 1, sortOrder: Number(row.sort_order) }));
  }

  // 调用方在更新项目阶段和方案的同一事务内替换条款。
  replaceRequirements(projectId: string, items: RequirementRecord[]): void {
    this.assertOpen();
    this.database.prepare('DELETE FROM requirement WHERE project_id = ?').run(projectId);
    const insert = this.database.prepare(`
      INSERT INTO requirement (id, project_id, text, outcome, source_ref_json, confirmed, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insert.run(item.id, projectId, item.text, item.outcome, item.sourceRef ? JSON.stringify(item.sourceRef) : null,
        Number(item.confirmed), item.sortOrder);
    }
  }

  listConfirmedRequirementIds(projectId: string): string[] {
    this.assertOpen();
    const rows = this.database.prepare('SELECT id FROM requirement WHERE project_id = ? AND confirmed = 1')
      .all(projectId) as DbRow[];
    return rows.map((row) => String(row.id));
  }

  clearRequirementConfirmations(projectId: string): void {
    this.assertOpen();
    this.database.prepare('UPDATE requirement SET confirmed = 0 WHERE project_id = ? AND confirmed = 1').run(projectId);
  }

  markPlanReady(projectId: string, editToken: string, sourceArtifactId: string): boolean {
    this.assertOpen();
    const result = this.database.prepare(`
      UPDATE plan SET state = 'ready'
      WHERE project_id = ? AND edit_token = ? AND source_artifact_id = ? AND state <> 'needs_update'
    `).run(projectId, editToken, sourceArtifactId);
    return Number(result.changes) === 1;
  }

  getNewArtifactPath(projectId: string, relativePath: string): string {
    validateId(projectId, '项目');
    const projectsRoot = realpathSync(join(this.dataRoot, 'projects'));
    const projectRoot = join(projectsRoot, projectId);
    const rootReal = realpathSync(projectRoot);
    if (relative(projectRoot, rootReal)) throw new StoreError('VALIDATION_FAILED', '项目目录不可写入。');
    const parts = normalizeRelativePath(relativePath).split('/');
    if (parts.length !== 2) throw new StoreError('VALIDATION_FAILED', '成果目录格式无效。');
    const directory = join(rootReal, parts[0]!);
    mkdirSync(directory, { recursive: true });
    if (relative(directory, realpathSync(directory))) throw new StoreError('VALIDATION_FAILED', '成果目录不可写入。');
    return join(directory, parts[1]!);
  }

  getPlan(projectId: string): PlanRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM plan WHERE project_id = ?').get(projectId) as DbRow | undefined;
    if (!row) return null;
    return {
      projectId: String(row.project_id),
      sourceArtifactId: asNullableString(row.source_artifact_id),
      body: parseJson(row.body_json),
      state: String(row.state) as PlanRecord['state'],
      editToken: String(row.edit_token),
      updatedAt: String(row.updated_at),
    };
  }

  getSettings(scope: string): SettingsRecord | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM settings WHERE scope = ?').get(scope) as DbRow | undefined;
    if (!row) return null;
    return {
      scope: String(row.scope),
      values: parseJson(row.values_json),
      editToken: String(row.edit_token),
      updatedAt: String(row.updated_at),
    };
  }

  ensureSettings(scope: string): SettingsRecord {
    this.assertOpen();
    this.database.prepare(`
      INSERT OR IGNORE INTO settings (scope, values_json, edit_token, updated_at)
      VALUES (?, '{}', ?, ?)
    `).run(scope, randomUUID(), new Date().toISOString());
    return this.getSettings(scope)!;
  }

  saveProject(project: ProjectRecord): ProjectRecord {
    this.assertOpen();
    validateId(project.id, '项目');
    const projectRoot = join(this.dataRoot, 'projects', project.id);
    mkdirSync(projectRoot, { recursive: true });
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO project (id, title, brief, stage, connection_id, current_source_id, current_video_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.title,
        project.brief,
        project.stage,
        project.connectionId,
        project.currentSourceId,
        project.currentVideoId,
        project.createdAt,
        project.updatedAt,
      );
      this.database.prepare(`
        INSERT INTO plan (project_id, source_artifact_id, body_json, state, edit_token, updated_at)
        VALUES (?, NULL, '{}', 'draft', ?, ?)
      `).run(project.id, randomUUID(), project.updatedAt);
      this.database.prepare(`
        INSERT INTO settings (scope, values_json, edit_token, updated_at)
        VALUES (?, '{}', ?, ?)
      `).run(`project:${project.id}`, randomUUID(), project.updatedAt);
      return project;
    });
  }

  saveTask(task: TaskRecord): TaskRecord {
    this.assertOpen();
    validateId(task.id, '任务');
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM task WHERE project_id = ? AND request_id = ?').get(
        task.projectId,
        task.requestId,
      ) as DbRow | undefined;
      const requestJson = stableStringify(task.request);
      if (existing) {
        if (existing.request_json !== requestJson) {
          throw new StoreError('REQUEST_CONFLICT', '同一 requestId 已用于不同请求。');
        }
        if (existing.id !== task.id) return taskFromRow(existing);
        this.updateTask(task, requestJson);
        return task;
      }
      const existingId = this.database.prepare('SELECT project_id, request_id, request_json FROM task WHERE id = ?')
        .get(task.id) as DbRow | undefined;
      if (existingId) {
        throw new StoreError('REQUEST_CONFLICT', '任务编号已用于其他请求。');
      }
      this.database.prepare(`
        INSERT INTO task (
          id, project_id, conversation_id, connection_id, kind, purpose, state, phase, input_json,
          runtime_json, result_json, error_json, waiting_input_json, request_id, request_json,
          created_at, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.projectId,
        task.conversationId ?? null,
        task.connectionId ?? null,
        task.kind,
        task.purpose ?? null,
        task.state,
        task.phase,
        stableStringify(task.input),
        nullableJson(task.runtime),
        nullableJson(task.result),
        nullableJson(task.error),
        nullableJson(task.waitingInput),
        task.requestId,
        requestJson,
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
      );
      return task;
    });
  }

  appendEvent(event: Omit<EventRecord, 'seq'>): EventRecord {
    this.assertOpen();
    return this.transaction(() => {
      const row = this.database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM event WHERE task_id = ?')
        .get(event.taskId) as DbRow;
      const seq = Number(row.next_seq);
      this.database.prepare(`
        INSERT INTO event (task_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(event.taskId, seq, event.type, stableStringify(event.payload), event.createdAt);
      return { ...event, seq };
    });
  }

  registerArtifact(artifact: ArtifactRecord): ArtifactRecord {
    this.assertOpen();
    validateId(artifact.id, '成果');
    const projectRoot = join(this.dataRoot, 'projects', artifact.projectId);
    const filePath = resolveProjectPath(projectRoot, artifact.relativePath);
    let state = artifact.state;
    let bytes = artifact.bytes;
    if (state !== 'pending') {
      if (existsSync(filePath)) {
        const rootReal = realpathSync(projectRoot);
        const fileReal = realpathSync(filePath);
        assertContained(rootReal, fileReal);
        const stat = statSync(fileReal);
        if (!stat.isFile()) state = 'missing';
        else bytes = stat.size;
      } else {
        state = 'missing';
      }
    }
    const saved = { ...artifact, bytes, state };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO artifact (id, project_id, task_id, kind, relative_path, mime, bytes, state, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saved.id,
        saved.projectId,
        saved.taskId ?? null,
        saved.kind,
        normalizeRelativePath(saved.relativePath),
        saved.mime,
        saved.bytes,
        saved.state,
        stableStringify(saved.metadata ?? {}),
        saved.createdAt,
      );
    });
    return saved;
  }

  compareAndSavePlan(plan: PlanSave): { saved: boolean; editToken: string | null } {
    this.assertOpen();
    return this.transaction(() => {
      const editToken = randomUUID();
      const result = this.database.prepare(`
        UPDATE plan
           SET source_artifact_id = ?, body_json = ?, state = ?, edit_token = ?, updated_at = ?
         WHERE project_id = ? AND edit_token = ?
      `).run(
        plan.sourceArtifactId ?? null,
        stableStringify(plan.body),
        plan.state,
        editToken,
        plan.updatedAt,
        plan.projectId,
        plan.expectedEditToken,
      );
      return Number(result.changes) === 1 ? { saved: true, editToken } : { saved: false, editToken: null };
    });
  }

  finalizeArtifact(artifactId: string, state: 'available' | 'partial' | 'missing', bytes: number, relativePath?: string): ArtifactRecord {
    this.assertOpen();
    const result = this.database.prepare(`
      UPDATE artifact SET state = ?, bytes = ?, relative_path = COALESCE(?, relative_path)
      WHERE id = ? AND state = 'pending'
    `).run(state, bytes, relativePath === undefined ? null : normalizeRelativePath(relativePath), artifactId);
    if (!Number(result.changes)) throw new StoreError('EDIT_CONFLICT', '成果已结束发布。');
    return this.getArtifact(artifactId)!;
  }

  compareAndSaveSettings(settings: SettingsSave): { saved: boolean; editToken: string | null } {
    this.assertOpen();
    return this.transaction(() => {
      const editToken = randomUUID();
      const result = this.database.prepare(`
        UPDATE settings
           SET values_json = ?, edit_token = ?, updated_at = ?
         WHERE scope = ? AND edit_token = ?
      `).run(
        stableStringify(settings.values),
        editToken,
        settings.updatedAt,
        settings.scope,
        settings.expectedEditToken,
      );
      return Number(result.changes) === 1 ? { saved: true, editToken } : { saved: false, editToken: null };
    });
  }

  ensureGlobalSettings(): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT OR IGNORE INTO settings (scope, values_json, edit_token, updated_at)
      VALUES ('global', '{}', ?, ?)
    `).run(randomUUID(), new Date().toISOString());
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreError('STORE_CLOSED', '数据库连接已关闭。');
  }

  private updateTask(task: TaskRecord, requestJson: string): void {
    this.database.prepare(`
      UPDATE task
         SET conversation_id = ?, connection_id = ?, kind = ?, purpose = ?, state = ?, phase = ?, input_json = ?,
             runtime_json = ?, result_json = ?, error_json = ?, waiting_input_json = ?, request_json = ?,
             created_at = ?, started_at = ?, ended_at = ?
       WHERE id = ? AND project_id = ? AND request_id = ?
    `).run(
      task.conversationId ?? null,
      task.connectionId ?? null,
      task.kind,
      task.purpose ?? null,
      task.state,
      task.phase,
      stableStringify(task.input),
      nullableJson(task.runtime),
      nullableJson(task.result),
      nullableJson(task.error),
      nullableJson(task.waitingInput),
      requestJson,
      task.createdAt,
      task.startedAt ?? null,
      task.endedAt ?? null,
      task.id,
      task.projectId,
      task.requestId,
    );
  }
}

type DbRow = Record<string, unknown>;

function projectFromRow(row: DbRow): ProjectRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    brief: String(row.brief),
    stage: String(row.stage),
    connectionId: asNullableString(row.connection_id),
    currentSourceId: asNullableString(row.current_source_id),
    currentVideoId: asNullableString(row.current_video_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function connectionFromRow(row: DbRow): ConnectionRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as ConnectionRecord['kind'],
    provider: asNullableString(row.provider),
    model: asNullableString(row.model),
    baseUrl: asNullableString(row.base_url),
    credentialRef: asNullableString(row.credential_ref),
    options: parseJson(row.options_json),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function conversationFromRow(row: DbRow): ConversationRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    connectionId: String(row.connection_id),
    nativeSessionRef: asNullableString(row.native_session_ref),
    contextSummary: asNullableString(row.context_summary),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function messageFromRow(row: DbRow): MessageRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    taskId: asNullableString(row.task_id),
    role: String(row.role) as MessageRecord['role'],
    text: String(row.text),
    toolCallId: asNullableString(row.tool_call_id),
    state: String(row.state) as MessageRecord['state'],
    createdAt: String(row.created_at),
  };
}

function taskFromRow(row: DbRow): TaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    conversationId: asNullableString(row.conversation_id),
    connectionId: asNullableString(row.connection_id),
    kind: String(row.kind) as TaskRecord['kind'],
    purpose: asNullableString(row.purpose),
    state: String(row.state) as TaskRecord['state'],
    phase: String(row.phase),
    input: parseJson(row.input_json),
    runtime: parseNullableJson(row.runtime_json),
    result: parseNullableJson(row.result_json),
    error: parseNullableJson(row.error_json),
    waitingInput: parseNullableJson(row.waiting_input_json),
    requestId: String(row.request_id),
    request: parseJson(row.request_json),
    createdAt: String(row.created_at),
    startedAt: asNullableString(row.started_at),
    endedAt: asNullableString(row.ended_at),
  };
}

function eventFromRow(row: DbRow): EventRecord {
  return {
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.type),
    payload: parseJson(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function artifactFromRow(row: DbRow): ArtifactRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: asNullableString(row.task_id),
    kind: String(row.kind) as ArtifactRecord['kind'],
    relativePath: String(row.relative_path),
    mime: String(row.mime),
    bytes: Number(row.bytes),
    state: String(row.state) as ArtifactRecord['state'],
    metadata: parseJson(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]));
  }
  return value;
}

function nullableJson(value: unknown): string | null {
  return value === null || value === undefined ? null : stableStringify(value);
}

function parseJson(value: unknown): unknown {
  return JSON.parse(String(value));
}

function parseNullableJson(value: unknown): unknown | null {
  return value === null || value === undefined ? null : parseJson(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function validateId(id: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new StoreError('VALIDATION_FAILED', `${label}编号格式无效。`);
  }
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new StoreError('VALIDATION_FAILED', '成果路径必须是项目内相对路径。');
  }
  const pieces = normalized.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) {
    throw new StoreError('VALIDATION_FAILED', '成果路径包含无效目录片段。');
  }
  return pieces.join('/');
}

function resolveProjectPath(projectRoot: string, path: string): string {
  const normalized = normalizeRelativePath(path).replace(/\//g, sep);
  const resolvedRoot = resolve(projectRoot);
  const filePath = resolve(resolvedRoot, normalized);
  const fromRoot = relative(resolvedRoot, filePath);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new StoreError('VALIDATION_FAILED', '成果路径必须位于项目目录内。');
  }
  return filePath;
}

function assertContained(rootReal: string, fileReal: string): void {
  const fromRoot = relative(rootReal, fileReal);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new StoreError('VALIDATION_FAILED', '成果文件必须位于项目目录内。');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof value === 'object' && 'then' in value && typeof (value as { then?: unknown }).then === 'function');
}
