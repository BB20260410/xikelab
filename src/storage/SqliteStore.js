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

  // 通用流式事件表（含 mcp_calls / metrics / archive / autopilot_log / licenses_issued / webhook_events）
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      room_id TEXT,
      tag TEXT,
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
  `);
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
  INSERT INTO events(ts, kind, room_id, tag, payload) VALUES (?, ?, ?, ?, ?)
`);

export function appendEvent({ kind, ts = Date.now(), roomId = null, tag = null, ...payload }) {
  if (!kind) throw new Error('kind required');
  return _insertEvent().run(ts, kind, roomId, tag, JSON.stringify(payload)).lastInsertRowid;
}

export function listEvents({ kind, roomId, tag, sinceTs, limit = 200, order = 'DESC' } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (tag) { where.push('tag = ?'); args.push(tag); }
  if (sinceTs) { where.push('ts >= ?'); args.push(sinceTs); }
  const sql = `SELECT id, ts, kind, room_id, tag, payload FROM events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ts ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ?`;
  args.push(Math.min(limit, 10000));
  const rows = getDb().prepare(sql).all(...args);
  return rows.map(r => ({ ...r, payload: tryParseJson(r.payload) }));
}

export function countEvents({ kind, roomId, sinceTs } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (sinceTs) { where.push('ts >= ?'); args.push(sinceTs); }
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
    },
  };
}
