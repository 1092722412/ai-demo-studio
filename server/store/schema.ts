// 工作台数据库的首版结构；初始化只执行建表和索引，不扫描旧任务文件。
export const STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('codex_app_server', 'external', 'api_key')),
  provider TEXT,
  model TEXT,
  base_url TEXT,
  credential_ref TEXT,
  options_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  stage TEXT NOT NULL,
  connection_id TEXT REFERENCES connection(id) ON DELETE SET NULL,
  current_source_id TEXT REFERENCES artifact(id) ON DELETE SET NULL,
  current_video_id TEXT REFERENCES artifact(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirement (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  outcome TEXT NOT NULL,
  source_ref_json TEXT,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connection(id),
  native_session_ref TEXT,
  context_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id)
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  text TEXT NOT NULL,
  tool_call_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'partial')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  source_artifact_id TEXT REFERENCES artifact(id) ON DELETE SET NULL,
  body_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'needs_update')),
  edit_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT PRIMARY KEY,
  values_json TEXT NOT NULL,
  edit_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id TEXT,
  connection_id TEXT REFERENCES connection(id),
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'build', 'script', 'record', 'render')),
  purpose TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  phase TEXT NOT NULL,
  input_json TEXT NOT NULL,
  runtime_json TEXT,
  result_json TEXT,
  error_json TEXT,
  waiting_input_json TEXT,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (project_id, request_id),
  UNIQUE (id, project_id),
  FOREIGN KEY (conversation_id, project_id) REFERENCES conversation(id, project_id)
);

CREATE TABLE IF NOT EXISTS event (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('attachment', 'source', 'plan', 'script', 'capture', 'media', 'video', 'log')),
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'available', 'partial', 'missing')),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, relative_path),
  FOREIGN KEY (task_id, project_id) REFERENCES task(id, project_id)
);

CREATE TABLE IF NOT EXISTS review (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  video_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  decision TEXT NOT NULL CHECK (decision IN ('comment', 'accepted', 'changes_requested')),
  time_ms INTEGER CHECK (time_ms IS NULL OR time_ms >= 0),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS requirement_project_order_idx ON requirement(project_id, sort_order);
CREATE INDEX IF NOT EXISTS conversation_project_updated_idx ON conversation(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS message_conversation_created_idx ON message(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS task_project_created_idx ON task(project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS task_active_write_project_idx
  ON task(project_id)
  WHERE state IN ('queued', 'running', 'waiting_input', 'cancelling')
    AND (kind <> 'ai' OR purpose IS NULL OR purpose <> 'discuss');
CREATE INDEX IF NOT EXISTS event_created_idx ON event(task_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_project_kind_idx ON artifact(project_id, kind);
CREATE INDEX IF NOT EXISTS review_project_created_idx ON review(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_updated_idx ON project(updated_at DESC);
CREATE INDEX IF NOT EXISTS connection_enabled_idx ON connection(enabled);
`;
