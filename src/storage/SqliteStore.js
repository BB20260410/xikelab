// panel v2.0 Task 4.1 — SQLite 数据底座
// 替代散落的 jsonl 文件，提供：
//   - 流式追加表（mcp_calls / metrics / archive / autopilot_log / licenses_issued）
//   - KV 通用键值表
//   - 简单查询（按 ts / room / tag 等过滤）
//   - 向量列保留（v2.0 Task 4.2 接入）

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude-panel', 'panel.db');

let _db = null;
let _dbPath = null;

export function initSqlite(dbPath = DEFAULT_DB_PATH) {
  if (_db && _dbPath === dbPath) return _db;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // 通用流式事件表（含 mcp_calls / metrics / archive / autopilot_log / licenses_issued / webhook_events / activity）
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      room_id TEXT,
      session_id TEXT,
      tag TEXT,
      entity_type TEXT,
      entity_id TEXT,
      task_id TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_events_room_kind ON events(room_id, kind);

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS room_summary (
      room_id TEXT PRIMARY KEY,
      mode TEXT,
      topic TEXT,
      status TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      cost_cents INTEGER DEFAULT 0,
      msg_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_room_status ON room_summary(status, updated_at);

    -- v2.0 Task 4.2 — 向量索引（暂留空 BLOB 列，4.2 接入 embedding）
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      text TEXT NOT NULL,
      vector BLOB,
      dim INTEGER,
      model TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);

    CREATE TABLE IF NOT EXISTS budget_policies (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL DEFAULT 'usd',
      window_kind TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL,
      warn_percent REAL NOT NULL DEFAULT 0.8,
      hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
      notify_enabled INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(scope_type, scope_id, metric, window_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_policies_scope ON budget_policies(scope_type, scope_id, metric, is_active);

    CREATE TABLE IF NOT EXISTS budget_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      adapter_id TEXT,
      project_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_budget_usage_scope_ts ON budget_usage(scope_type, scope_id, metric, ts);
    CREATE INDEX IF NOT EXISTS idx_budget_usage_room_ts ON budget_usage(room_id, ts);

    CREATE TABLE IF NOT EXISTS budget_incidents (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      threshold_type TEXT NOT NULL,
      observed_amount REAL NOT NULL,
      limit_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      activity_id INTEGER,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_budget_incidents_policy_status ON budget_incidents(policy_id, status, window_start);
    CREATE INDEX IF NOT EXISTS idx_budget_incidents_scope_status ON budget_incidents(scope_type, scope_id, status);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requester_type TEXT,
      requester_id TEXT,
      dedupe_key TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      decision_by TEXT,
      decision_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      decided_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status_type ON approvals(status, type, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_requester ON approvals(requester_type, requester_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_dedupe ON approvals(dedupe_key, status);

    CREATE TABLE IF NOT EXISTS approval_comments (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      actor_type TEXT,
      actor_id TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON approval_comments(approval_id, created_at);

    CREATE TABLE IF NOT EXISTS autopilot_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      schedule_kind TEXT NOT NULL DEFAULT 'interval',
      interval_ms INTEGER,
      next_run_at INTEGER,
      last_run_at INTEGER,
      action TEXT NOT NULL DEFAULT 'notify',
      target_type TEXT,
      target_id TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      project_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_schedules_due ON autopilot_schedules(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_schedules_target ON autopilot_schedules(target_type, target_id);

    CREATE TABLE IF NOT EXISTS autopilot_jobs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      project_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
      locked_by TEXT,
      locked_at INTEGER,
      dedupe_key TEXT UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_status_due ON autopilot_jobs(status, run_after, priority);
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_schedule ON autopilot_jobs(schedule_id, status);
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_room ON autopilot_jobs(room_id, status);

    CREATE TABLE IF NOT EXISTS autopilot_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      schedule_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      worker_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      result TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_job ON autopilot_runs(job_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_schedule ON autopilot_runs(schedule_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status ON autopilot_runs(status, started_at);

    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      source_room_id TEXT NOT NULL,
      source_task_id TEXT,
      target_room_id TEXT,
      target_mode TEXT NOT NULL DEFAULT 'debate',
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      objective_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      executed_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_source ON delegations(source_room_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_room_id, status);
    CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status, updated_at);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      agent_profile_id TEXT,
      agent_profile_title TEXT,
      adapter_id TEXT,
      model_id TEXT,
      turn_id TEXT,
      source_type TEXT,
      source_id TEXT,
      defer_reason TEXT,
      approval_id TEXT,
      budget_incident_id TEXT,
      delegation_id TEXT,
      related_activity_ids TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      dispatch_tags TEXT NOT NULL DEFAULT '[]',
      governance TEXT NOT NULL DEFAULT '{}',
      details TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_room_status ON agent_runs(room_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_profile_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_source ON agent_runs(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_delegation ON agent_runs(delegation_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_approval ON agent_runs(approval_id, updated_at);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      role TEXT NOT NULL DEFAULT 'system',
      status TEXT,
      summary TEXT,
      content TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_tool_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      input_summary TEXT,
      output_summary TEXT,
      cost_usd REAL DEFAULT 0,
      approval_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tool_results_run ON agent_tool_results(run_id, created_at);
  `);
  ensureEventsSchema(db);
  ensureAgentRunSchema(db);
  fs.chmodSync(dbPath, 0o600);
  _db = db;
  _dbPath = dbPath;
  return db;
}

export function getDb() {
  return _db || initSqlite();
}

export function close() {
  if (_db) { try { _db.close(); } catch {} _db = null; _dbPath = null; }
}

// ===== Events API（替代 jsonl 流式追加） =====
const _insertEvent = () => getDb().prepare(`
  INSERT INTO events(ts, kind, room_id, session_id, tag, entity_type, entity_id, task_id, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function appendEvent({
  kind,
  ts = Date.now(),
  roomId = null,
  sessionId = null,
  tag = null,
  entityType = null,
  entityId = null,
  taskId = null,
  ...payload
}) {
  if (!kind) throw new Error('kind required');
  return _insertEvent().run(
    normalizeTs(ts),
    kind,
    nullableString(roomId),
    nullableString(sessionId),
    nullableString(tag),
    nullableString(entityType),
    nullableString(entityId),
    nullableString(taskId),
    JSON.stringify(payload)
  ).lastInsertRowid;
}

export function listEvents({
  kind,
  roomId,
  sessionId,
  tag,
  entityType,
  entityId,
  taskId,
  sinceTs,
  untilTs,
  limit = 200,
  order = 'DESC',
} = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
  if (tag) { where.push('tag = ?'); args.push(tag); }
  if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); args.push(entityId); }
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (sinceTs !== undefined && sinceTs !== null) { where.push('ts >= ?'); args.push(normalizeTs(sinceTs)); }
  if (untilTs !== undefined && untilTs !== null) { where.push('ts <= ?'); args.push(normalizeTs(untilTs)); }
  const sql = `SELECT id, ts, kind, room_id, session_id, tag, entity_type, entity_id, task_id, payload FROM events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ts ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ?`;
  args.push(Math.min(limit, 10000));
  const rows = getDb().prepare(sql).all(...args);
  return rows.map(r => ({
    ...r,
    roomId: r.room_id,
    sessionId: r.session_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    taskId: r.task_id,
    payload: tryParseJson(r.payload),
  }));
}

export function countEvents({ kind, roomId, sessionId, entityType, entityId, taskId, sinceTs, untilTs } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
  if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); args.push(entityId); }
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (sinceTs !== undefined && sinceTs !== null) { where.push('ts >= ?'); args.push(normalizeTs(sinceTs)); }
  if (untilTs !== undefined && untilTs !== null) { where.push('ts <= ?'); args.push(normalizeTs(untilTs)); }
  const sql = `SELECT COUNT(*) as c FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return getDb().prepare(sql).get(...args).c;
}

// ===== KV API =====
export function kvGet(k) {
  const r = getDb().prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? tryParseJson(r.v) : null;
}

export function kvSet(k, v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return getDb().prepare(`
    INSERT INTO kv(k, v, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).run(k, s).changes;
}

export function kvDelete(k) {
  return getDb().prepare('DELETE FROM kv WHERE k = ?').run(k).changes;
}

// ===== Room summary API =====
export function upsertRoomSummary(summary) {
  return getDb().prepare(`
    INSERT INTO room_summary(room_id, mode, topic, status, started_at, ended_at, cost_cents, msg_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(room_id) DO UPDATE SET
      mode = excluded.mode, topic = excluded.topic, status = excluded.status,
      started_at = excluded.started_at, ended_at = excluded.ended_at,
      cost_cents = excluded.cost_cents, msg_count = excluded.msg_count,
      updated_at = excluded.updated_at
  `).run(
    summary.roomId, summary.mode, summary.topic, summary.status,
    summary.startedAt || null, summary.endedAt || null,
    summary.costCents || 0, summary.msgCount || 0
  ).changes;
}

export function listRoomSummary({ status, limit = 200 } = {}) {
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  args.push(limit);
  return getDb().prepare(`SELECT * FROM room_summary ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args);
}

// ===== 工具 =====
function tryParseJson(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function nullableString(v) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, 512);
}

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.trunc(ts);
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (Number.isFinite(n)) return Math.trunc(n);
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function ensureEventsSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };
  addColumn('session_id', 'TEXT');
  addColumn('entity_type', 'TEXT');
  addColumn('entity_id', 'TEXT');
  addColumn('task_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_session_kind ON events(session_id, kind);
    CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
  `);
}

// ===== 健康/统计 =====
export function getStats() {
  const db = getDb();
  return {
    dbPath: _dbPath,
    sizeBytes: fs.existsSync(_dbPath) ? fs.statSync(_dbPath).size : 0,
    counts: {
      events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
      kv: db.prepare('SELECT COUNT(*) as c FROM kv').get().c,
      room_summary: db.prepare('SELECT COUNT(*) as c FROM room_summary').get().c,
      embeddings: db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c,
      budget_policies: db.prepare('SELECT COUNT(*) as c FROM budget_policies').get().c,
      budget_usage: db.prepare('SELECT COUNT(*) as c FROM budget_usage').get().c,
      budget_incidents: db.prepare('SELECT COUNT(*) as c FROM budget_incidents').get().c,
      approvals: db.prepare('SELECT COUNT(*) as c FROM approvals').get().c,
      approval_comments: db.prepare('SELECT COUNT(*) as c FROM approval_comments').get().c,
      autopilot_schedules: db.prepare('SELECT COUNT(*) as c FROM autopilot_schedules').get().c,
      autopilot_jobs: db.prepare('SELECT COUNT(*) as c FROM autopilot_jobs').get().c,
      autopilot_runs: db.prepare('SELECT COUNT(*) as c FROM autopilot_runs').get().c,
      delegations: db.prepare('SELECT COUNT(*) as c FROM delegations').get().c,
      agent_runs: db.prepare('SELECT COUNT(*) as c FROM agent_runs').get().c,
      agent_messages: db.prepare('SELECT COUNT(*) as c FROM agent_messages').get().c,
      agent_tool_results: db.prepare('SELECT COUNT(*) as c FROM agent_tool_results').get().c,
    },
  };
}

function ensureAgentRunSchema(db) {
  const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tableNames.has('agent_runs')) return;
  const columns = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };
  addColumn('turn_id', 'TEXT');
  addColumn('source_type', 'TEXT');
  addColumn('source_id', 'TEXT');
  addColumn('defer_reason', 'TEXT');
  addColumn('approval_id', 'TEXT');
  addColumn('budget_incident_id', 'TEXT');
  addColumn('delegation_id', 'TEXT');
  addColumn('related_activity_ids', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('governance', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('details', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_room_status ON agent_runs(room_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_profile_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_source ON agent_runs(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_delegation ON agent_runs(delegation_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_approval ON agent_runs(approval_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tool_results_run ON agent_tool_results(run_id, created_at);
  `);
}
