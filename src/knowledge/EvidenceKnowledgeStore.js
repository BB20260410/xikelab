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
        created_at INTEGER NOT NULL
      );
    `);
    this._ready = true;
  }

  // 增量索引：已索引（同 ref_kind:ref_id）的跳过，避免重复
  indexItems(items = []) {
    this.ensureSchema();
    const now = Date.now();
    const hasMeta = this.db.prepare('SELECT 1 FROM evidence_index_meta WHERE ref_key = ?');
    const insertFts = this.db.prepare('INSERT INTO evidence_fts(content, ref_kind, ref_id, room_id, session_id) VALUES (?, ?, ?, ?, ?)');
    const insertMeta = this.db.prepare('INSERT INTO evidence_index_meta(ref_key, fts_rowid, created_at) VALUES (?, ?, ?)');
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
      insertMeta.run(refKey, info.lastInsertRowid, now);
      indexed += 1;
    }
    return { indexed, skipped };
  }

  search(query, { kind, limit = 20 } = {}) {
    this.ensureSchema();
    const cleaned = sanitizeQuery(query);
    if (!cleaned) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    let rows;
    try {
      rows = this.db.prepare(`
        SELECT ref_kind, ref_id, room_id, session_id,
               snippet(evidence_fts, 0, '[', ']', '…', 12) AS snip,
               bm25(evidence_fts) AS rank
        FROM evidence_fts
        WHERE evidence_fts MATCH ?${kind ? ' AND ref_kind = ?' : ''}
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
