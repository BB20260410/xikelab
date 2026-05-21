// panel v2.0 Task 4.2 — 向量索引（基于 SqliteStore.embeddings 表）

import { getDb, initSqlite } from '../storage/SqliteStore.js';
import { embed, cosineSim } from './EmbeddingProvider.js';

// Float32Array <-> Buffer 互转
function vectorToBuf(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
function bufToVector(buf) {
  const n = buf.length / 4;
  const vec = new Float32Array(n);
  for (let i = 0; i < n; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

export async function upsertEmbedding({ kind, refId, text, provider = 'hash', model, baseUrl }) {
  initSqlite();
  const db = getDb();
  const { vector, provider: p, model: m } = await embed(text, { provider, model, baseUrl });
  db.prepare(`
    INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      text = excluded.text, vector = excluded.vector,
      dim = excluded.dim, model = excluded.model
  `).run(kind, refId, text, vectorToBuf(vector), vector.length, m);
  return { ok: true, dim: vector.length, provider: p, model: m };
}

export async function semanticSearch(query, { kind, limit = 10, provider = 'hash', model, baseUrl, minScore = 0 } = {}) {
  initSqlite();
  const db = getDb();
  const { vector: qv } = await embed(query, { provider, model, baseUrl });
  const where = kind ? 'WHERE kind = ?' : '';
  const args = kind ? [kind] : [];
  const rows = db.prepare(`SELECT id, kind, ref_id, text, vector, dim, model FROM embeddings ${where}`).all(...args);
  const scored = rows.map(r => {
    const v = bufToVector(r.vector);
    // dim 不同视为 0 分（hash 128 vs ollama 384 不能直接比）
    const score = v.length === qv.length ? cosineSim(v, qv) : 0;
    return { id: r.id, kind: r.kind, refId: r.ref_id, text: r.text, model: r.model, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score >= minScore).slice(0, limit);
}

export function deleteEmbedding({ kind, refId }) {
  initSqlite();
  return getDb().prepare('DELETE FROM embeddings WHERE kind = ? AND ref_id = ?').run(kind, refId).changes;
}

export function listEmbeddings({ kind, limit = 100 } = {}) {
  initSqlite();
  const db = getDb();
  const where = kind ? 'WHERE kind = ?' : '';
  const args = kind ? [kind] : [];
  args.push(limit);
  return db.prepare(`SELECT id, kind, ref_id, substr(text, 1, 200) as text, dim, model FROM embeddings ${where} ORDER BY id DESC LIMIT ?`).all(...args);
}
