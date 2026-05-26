// 治理工作队列存储（P5 刀1）：把 governance summary 的阻塞项派生为带状态的工作队列项，
// 让用户能推进「待审批 / 待验证 / 待归档 / 待修复 / 已处理」。真相源仍在各 store，
// 本表只持有「视图 + 处理状态」，用 dedupe_key 防重复派生。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';

export const QUEUE_STATES = new Set(['pending_review', 'pending_verify', 'pending_archive', 'pending_fix', 'done']);

// 按来源 kind 推断初始队列状态
export function initialStateForKind(kind) {
  switch (kind) {
    case 'approval': return 'pending_review';
    case 'budget': return 'pending_fix';
    case 'delegation': return 'pending_review';
    case 'autopilot': return 'pending_verify';
    case 'agent_run': return 'pending_verify';
    default: return 'pending_review';
  }
}

function mapRow(r) {
  return {
    id: r.id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    title: r.title,
    severity: r.severity,
    queueState: r.queue_state,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class GovernanceQueueStore {
  constructor({ db } = {}) {
    this._db = db || null;
  }

  get db() {
    return this._db || getDb();
  }

  // 从 governance summary 的 blockers 派生/更新队列项（dedupe by source_kind:source_id，不重复派生）
  syncFromBlockers(blockers = []) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO governance_queue_items (id, source_kind, source_id, title, severity, queue_state, dedupe_key, created_at, updated_at)
      VALUES (@id, @source_kind, @source_id, @title, @severity, @queue_state, @dedupe_key, @created_at, @updated_at)
      ON CONFLICT(dedupe_key) DO UPDATE SET title = excluded.title, severity = excluded.severity, updated_at = excluded.updated_at
    `);
    let upserted = 0;
    for (const b of blockers || []) {
      const kind = String(b?.kind || '').slice(0, 80);
      const sourceId = String(b?.id || '').slice(0, 200);
      if (!kind || !sourceId) continue;
      stmt.run({
        id: randomUUID(),
        source_kind: kind,
        source_id: sourceId,
        title: String(b?.title || '').slice(0, 400),
        severity: String(b?.severity || 'info').slice(0, 40),
        queue_state: initialStateForKind(kind),
        dedupe_key: `${kind}:${sourceId}`,
        created_at: now,
        updated_at: now,
      });
      upserted += 1;
    }
    return { upserted };
  }

  setState(id, state, note = '') {
    if (!QUEUE_STATES.has(state)) throw new Error(`invalid queue state: ${state}`);
    const info = this.db
      .prepare('UPDATE governance_queue_items SET queue_state = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(state, String(note || '').slice(0, 1000), Date.now(), id);
    return info.changes > 0;
  }

  // 源对象状态变化时联动：按 source_kind:source_id 标记队列项状态
  setStateBySource(kind, sourceId, state, note = '') {
    if (!QUEUE_STATES.has(state)) throw new Error(`invalid queue state: ${state}`);
    const info = this.db
      .prepare('UPDATE governance_queue_items SET queue_state = ?, note = ?, updated_at = ? WHERE dedupe_key = ?')
      .run(state, String(note || '').slice(0, 1000), Date.now(), `${kind}:${sourceId}`);
    return info.changes > 0;
  }

  list({ state } = {}) {
    const rows = state
      ? this.db.prepare('SELECT * FROM governance_queue_items WHERE queue_state = ? ORDER BY updated_at DESC').all(state)
      : this.db.prepare('SELECT * FROM governance_queue_items ORDER BY updated_at DESC').all();
    return rows.map(mapRow);
  }

  grouped() {
    const out = { pending_review: [], pending_verify: [], pending_archive: [], pending_fix: [], done: [] };
    for (const row of this.list()) {
      if (!out[row.queueState]) out[row.queueState] = [];
      out[row.queueState].push(row);
    }
    return out;
  }
}

export const governanceQueueStore = new GovernanceQueueStore();
