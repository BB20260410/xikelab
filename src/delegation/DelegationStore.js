import { randomUUID } from 'node:crypto';
import { activityLog } from '../audit/ActivityLog.js';
import { getDb } from '../storage/SqliteStore.js';

export const DELEGATION_STATUSES = new Set(['queued', 'created', 'cancelled', 'failed']);
export const DELEGATION_TARGET_MODES = new Set(['chat', 'debate', 'squad', 'arena']);

function nowMs() {
  return Date.now();
}

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max).trim() || null;
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function rowToDelegation(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    sourceRoomId: row.source_room_id,
    sourceTaskId: row.source_task_id || null,
    targetRoomId: row.target_room_id || null,
    targetMode: row.target_mode,
    title: row.title,
    instructions: row.instructions,
    objectiveId: row.objective_id || null,
    payload: parsePayload(row.payload),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executedAt: row.executed_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

function normalizeTargetMode(value) {
  const mode = String(value || 'debate').toLowerCase();
  if (!DELEGATION_TARGET_MODES.has(mode)) throw new Error(`invalid targetMode: ${value}`);
  return mode;
}

function normalizeStatus(value) {
  const status = String(value || 'queued').toLowerCase();
  if (!DELEGATION_STATUSES.has(status)) throw new Error(`invalid delegation status: ${value}`);
  return status;
}

export class DelegationStore {
  constructor({ logger = console, audit = activityLog } = {}) {
    this.logger = logger;
    this.audit = audit;
  }

  db() {
    return getDb();
  }

  create(input = {}) {
    const sourceRoomId = str(input.sourceRoomId ?? input.source_room_id);
    if (!sourceRoomId) throw new Error('sourceRoomId required');
    const title = str(input.title, 240);
    if (!title) throw new Error('title required');
    const instructions = str(input.instructions, 8000);
    if (!instructions) throw new Error('instructions required');
    const id = str(input.id, 160) || `delegation-${randomUUID().slice(0, 12)}`;
    const now = nowMs();
    const targetMode = normalizeTargetMode(input.targetMode ?? input.target_mode);
    const sourceTaskId = str(input.sourceTaskId ?? input.source_task_id, 240);
    const objectiveId = str(input.objectiveId ?? input.objective_id, 240) || `obj-${id}`;
    const payload = parsePayload(input.payload);

    this.db().prepare(`
      INSERT INTO delegations(
        id, status, source_room_id, source_task_id, target_room_id, target_mode,
        title, instructions, objective_id, payload, error,
        created_at, updated_at, executed_at, cancelled_at
      ) VALUES (?, 'queued', ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
    `).run(
      id,
      sourceRoomId,
      sourceTaskId,
      targetMode,
      title,
      instructions,
      objectiveId,
      JSON.stringify(payload),
      now,
      now
    );
    const delegation = this.get(id);
    this.audit.recordSafe({
      action: 'delegation.created',
      actorType: input.actorType || 'user',
      roomId: sourceRoomId,
      taskId: sourceTaskId,
      entityType: 'delegation',
      entityId: id,
      status: 'queued',
      details: {
        targetMode,
        title,
        objectiveId,
      },
    });
    return delegation;
  }

  get(id) {
    return rowToDelegation(this.db().prepare('SELECT * FROM delegations WHERE id = ?').get(id));
  }

  list(query = {}) {
    const where = [];
    const args = [];
    if (query.status) { where.push('status = ?'); args.push(normalizeStatus(query.status)); }
    if (query.sourceRoomId) { where.push('source_room_id = ?'); args.push(str(query.sourceRoomId)); }
    if (query.targetRoomId) { where.push('target_room_id = ?'); args.push(str(query.targetRoomId)); }
    if (query.sourceTaskId) { where.push('source_task_id = ?'); args.push(str(query.sourceTaskId)); }
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const sql = `SELECT * FROM delegations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db().prepare(sql).all(...args, limit).map(rowToDelegation);
  }

  markCreated(id, { targetRoomId }) {
    const delegation = this.get(id);
    if (!delegation) throw new Error('delegation not found');
    const now = nowMs();
    this.db().prepare(`
      UPDATE delegations
      SET status = 'created', target_room_id = ?, updated_at = ?, executed_at = ?, error = NULL
      WHERE id = ?
    `).run(str(targetRoomId), now, now, id);
    const updated = this.get(id);
    this.audit.recordSafe({
      action: 'delegation.executed',
      actorType: 'system',
      roomId: updated.sourceRoomId,
      taskId: updated.sourceTaskId,
      entityType: 'delegation',
      entityId: id,
      status: 'created',
      details: {
        targetRoomId: updated.targetRoomId,
        targetMode: updated.targetMode,
      },
    });
    return updated;
  }

  attachAgentRun(id, patch = {}) {
    const delegation = this.get(id);
    if (!delegation) throw new Error('delegation not found');
    const payload = {
      ...(delegation.payload || {}),
      agentRunId: str(patch.agentRunId, 160) || delegation.payload?.agentRunId || null,
      approvalId: str(patch.approvalId, 160) || delegation.payload?.approvalId || null,
      autopilotJobId: str(patch.jobId || patch.autopilotJobId, 160) || delegation.payload?.autopilotJobId || null,
    };
    const now = nowMs();
    this.db().prepare('UPDATE delegations SET payload = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(payload), now, id);
    const updated = this.get(id);
    this.audit.recordSafe({
      action: 'delegation.agent_run_attached',
      actorType: 'system',
      roomId: updated.sourceRoomId,
      taskId: updated.sourceTaskId,
      entityType: 'delegation',
      entityId: id,
      status: updated.status,
      details: {
        agentRunId: payload.agentRunId,
        approvalId: payload.approvalId,
        autopilotJobId: payload.autopilotJobId,
      },
    });
    return updated;
  }

  markFailed(id, error) {
    const delegation = this.get(id);
    if (!delegation) throw new Error('delegation not found');
    const now = nowMs();
    this.db().prepare(`
      UPDATE delegations
      SET status = 'failed', updated_at = ?, error = ?
      WHERE id = ?
    `).run(now, str(error, 4000) || 'failed', id);
    const updated = this.get(id);
    this.audit.recordSafe({
      action: 'delegation.failed',
      actorType: 'system',
      roomId: updated.sourceRoomId,
      taskId: updated.sourceTaskId,
      entityType: 'delegation',
      entityId: id,
      severity: 'error',
      status: 'failed',
      details: { error: updated.error },
    });
    return updated;
  }

  cancel(id, { reason = '', actorType = 'user' } = {}) {
    const delegation = this.get(id);
    if (!delegation) throw new Error('delegation not found');
    if (delegation.status === 'created') throw new Error('created delegation cannot be cancelled');
    const now = nowMs();
    this.db().prepare(`
      UPDATE delegations
      SET status = 'cancelled', updated_at = ?, cancelled_at = ?, error = ?
      WHERE id = ?
    `).run(now, now, str(reason, 4000), id);
    const updated = this.get(id);
    this.audit.recordSafe({
      action: 'delegation.cancelled',
      actorType,
      roomId: updated.sourceRoomId,
      taskId: updated.sourceTaskId,
      entityType: 'delegation',
      entityId: id,
      status: 'cancelled',
      details: { reason },
    });
    return updated;
  }
}

export const delegationStore = new DelegationStore();
