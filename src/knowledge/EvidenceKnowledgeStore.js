// 本地证据知识库（P4 刀1）：把 Agent Run / 工具结果 / 归档 / Activity / 代码问答 的摘要文本
// 索引进本地 SQLite FTS5，提供 bm25 跨来源检索。只读本地、不做云同步；索引前脱敏明显密钥。
import { getDb } from '../storage/SqliteStore.js';

const MAX_CONTENT = 4000;

// 索引前移除明显的密钥/凭据，避免敏感原文进入可搜索库
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text) {
  let s = String(text || '');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}

// FTS5 query 容错：移除会破坏 MATCH 语法的特殊字符，仅保留可检索 token
function sanitizeQuery(q) {
  return String(q || '').replace(/["'(){}*:^[\]~-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 把单个 run 的 timeline（messages + toolResults）派生成可索引证据项。
// indexFromStores（批量）与 indexRunTimeline（单 run 归档钩子）共用，避免重复逻辑。
function runTimelineToItems(run, timeline) {
  const items = [];
  if (!run || !timeline) return items;
  for (const m of timeline.messages || []) {
    const content = `${m.summary || ''} ${m.content || ''}`.trim();
    if (m.id && content) items.push({ refKind: 'agent_message', refId: m.id, content, roomId: run.roomId, sessionId: run.sessionId, runId: run.id });
  }
  for (const t of timeline.toolResults || []) {
    const content = `${t.toolName || ''} ${t.outputSummary || t.output_summary || ''}`.trim();
    if (t.id && content) items.push({ refKind: 'tool_result', refId: t.id, content, roomId: run.roomId, sessionId: run.sessionId, runId: run.id });
  }
  return items;
}

export class EvidenceKnowledgeStore {
  constructor({ db } = {}) {
    this._db = db || null;
    this._ready = false;
  }

  get db() {
    return this._db || getDb();
  }

  ensureSchema() {
    if (this._ready) return;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(content, ref_kind, ref_id, room_id, session_id);
      CREATE TABLE IF NOT EXISTS evidence_index_meta (
        ref_key TEXT PRIMARY KEY,
        fts_rowid INTEGER,
        run_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    // 旧库幂等补列（F1：run_id 用于命中精准跳转对应 Agent Run）
    const cols = new Set(this.db.prepare('PRAGMA table_info(evidence_index_meta)').all().map((c) => c.name));
    if (!cols.has('run_id')) this.db.exec('ALTER TABLE evidence_index_meta ADD COLUMN run_id TEXT');
    this._ready = true;
  }

  // 增量索引：已索引（同 ref_kind:ref_id）的跳过，避免重复
  indexItems(items = []) {
    this.ensureSchema();
    const now = Date.now();
    const hasMeta = this.db.prepare('SELECT 1 FROM evidence_index_meta WHERE ref_key = ?');
    const insertFts = this.db.prepare('INSERT INTO evidence_fts(content, ref_kind, ref_id, room_id, session_id) VALUES (?, ?, ?, ?, ?)');
    const insertMeta = this.db.prepare('INSERT INTO evidence_index_meta(ref_key, fts_rowid, run_id, created_at) VALUES (?, ?, ?, ?)');
    let indexed = 0;
    let skipped = 0;
    for (const it of items || []) {
      const refKind = String(it?.refKind || '').slice(0, 80);
      const refId = String(it?.refId || '').slice(0, 200);
      const content = redactSecrets(String(it?.content || '')).slice(0, MAX_CONTENT);
      if (!refKind || !refId || !content) continue;
      const refKey = `${refKind}:${refId}`;
      if (hasMeta.get(refKey)) { skipped += 1; continue; }
      const info = insertFts.run(content, refKind, refId, String(it?.roomId || '').slice(0, 160), String(it?.sessionId || '').slice(0, 160));
      insertMeta.run(refKey, info.lastInsertRowid, String(it?.runId || '').slice(0, 200) || null, now);
      indexed += 1;
    }
    return { indexed, skipped };
  }

  // 从现有 store 派生证据并增量索引（让知识库接入真实数据，而非孤岛）。
  // 只读摘要文本（run message summary/content、tool output summary、activity summary）；
  // 失败不抛断主流程，依赖 indexItems 的 ref dedupe 做增量。
  indexFromStores({ agentRunStore, activityLog, limit = 200 } = {}) {
    const items = [];
    try {
      if (agentRunStore?.list) {
        for (const run of agentRunStore.list({ limit }) || []) {
          const timeline = agentRunStore.getTimeline?.(run.id);
          if (!timeline) continue;
          items.push(...runTimelineToItems(run, timeline));
        }
      }
    } catch { /* 派生失败不阻断 */ }
    try {
      if (activityLog?.list) {
        for (const e of activityLog.list({ limit }) || []) {
          const content = `${e.action || ''} ${e.summary || e.message || ''}`.trim();
          if (e.id && content) items.push({ refKind: 'activity', refId: e.id, content, roomId: e.roomId, sessionId: e.sessionId });
        }
      }
    } catch { /* 派生失败不阻断 */ }
    return this.indexItems(items);
  }

  // 单 run 归档时的增量索引（供 AgentRunStore archiveHook 调用）。只索引该 run 的证据，
  // 依赖 indexItems 的 ref dedupe 做幂等；失败由调用方吞掉，不阻断归档主流程。
  indexRunTimeline(run, timeline) {
    return this.indexItems(runTimelineToItems(run, timeline));
  }

  search(query, { kind, limit = 20 } = {}) {
    this.ensureSchema();
    const cleaned = sanitizeQuery(query);
    if (!cleaned) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    let rows;
    try {
      rows = this.db.prepare(`
        SELECT evidence_fts.ref_kind, evidence_fts.ref_id, evidence_fts.room_id, evidence_fts.session_id,
               evidence_index_meta.run_id AS run_id,
               snippet(evidence_fts, 0, '[', ']', '…', 12) AS snip,
               bm25(evidence_fts) AS rank
        FROM evidence_fts
        LEFT JOIN evidence_index_meta ON evidence_index_meta.fts_rowid = evidence_fts.rowid
        WHERE evidence_fts MATCH ?${kind ? ' AND evidence_fts.ref_kind = ?' : ''}
        ORDER BY rank
        LIMIT ?
      `).all(...(kind ? [cleaned, String(kind), safeLimit] : [cleaned, safeLimit]));
    } catch {
      return [];
    }
    return rows.map((r) => ({
      refKind: r.ref_kind,
      refId: r.ref_id,
      roomId: r.room_id || '',
      sessionId: r.session_id || '',
      runId: r.run_id || '',
      snippet: r.snip || '',
      score: Number(r.rank) || 0,
    }));
  }

  stats() {
    this.ensureSchema();
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM evidence_index_meta').get();
    return { indexed: Number(row?.n) || 0 };
  }
}

export const evidenceKnowledgeStore = new EvidenceKnowledgeStore();
